import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import type { MemoryCapturePolicy, MemoryProviderRoute } from "./provider-router.ts";

const KINDS = new Set<ScopeKind>(["personal", "channel", "team", "org", "group"]);
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const ARG = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]*$/;

export interface McpMemoryAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface McpMemoryOperationConfig {
  tool: string;
  auth: McpMemoryAuthConfig;
  queryArg?: string;
  contentArg?: string;
  actorArg?: string;
  scopeArg?: string;
  maxCharsArg?: string;
  inputArg?: string;
  replyArg?: string;
  capturedAtArg?: string;
  sourceArg?: string;
  idempotencyArg?: string;
}

export interface McpMemoryProviderConfig {
  id: string;
  type: "mcp";
  url: string;
  read: McpMemoryOperationConfig;
  write?: McpMemoryOperationConfig;
  timeoutMs: number;
}

export interface MemoryProviderConfig {
  providers: McpMemoryProviderConfig[];
  routes: MemoryProviderRoute[];
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${at} must be a non-empty string`);
  return value;
}

function privateMcpUrl(value: unknown, at: string): string {
  const raw = string(value, at);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${at} must be a valid URL`);
  }
  const privateHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname.endsWith(".internal") ||
      url.hostname.endsWith(".flycast") ||
      url.hostname.endsWith(".local"));
  if ((url.protocol !== "https:" && !privateHttp) || url.username || url.password || url.hash)
    throw new Error(`${at} must use HTTPS or a recognized private HTTP host`);
  return raw.replace(/\/+$/, "");
}

function operation(value: unknown, at: string, env: NodeJS.ProcessEnv): McpMemoryOperationConfig {
  const raw = object(value, at);
  const clientIdEnv = string(raw.clientIdEnv, `${at}.clientIdEnv`);
  const clientSecretEnv = string(raw.clientSecretEnv, `${at}.clientSecretEnv`);
  if (!ENV.test(clientIdEnv) || !ENV.test(clientSecretEnv)) throw new Error(`${at} credential env names are invalid`);
  const clientId = env[clientIdEnv];
  const clientSecret = env[clientSecretEnv];
  if (!clientId || !clientSecret) throw new Error(`${at} requires ${clientIdEnv} and ${clientSecretEnv}`);
  const out: McpMemoryOperationConfig = {
    tool: string(raw.tool, `${at}.tool`),
    auth: { clientId, clientSecret },
  };
  for (const key of [
    "queryArg",
    "contentArg",
    "actorArg",
    "scopeArg",
    "maxCharsArg",
    "inputArg",
    "replyArg",
    "capturedAtArg",
    "sourceArg",
    "idempotencyArg",
  ] as const) {
    if (raw[key] === undefined) continue;
    const name = string(raw[key], `${at}.${key}`);
    if (!ARG.test(name)) throw new Error(`${at}.${key} is invalid`);
    out[key] = name;
  }
  return out;
}

function scope(value: unknown, at: string): ScopeKind | ScopeId {
  const raw = string(value, at);
  if (KINDS.has(raw as ScopeKind)) return raw as ScopeKind;
  if (!parseScopeId(raw).kind) throw new Error(`${at} must be a scope kind or scope id`);
  return raw;
}

export function parseMemoryProviderConfig(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): MemoryProviderConfig | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MEMORY_PROVIDER_CONFIG must be valid JSON");
  }
  const root = object(parsed, "MEMORY_PROVIDER_CONFIG");
  if (!Array.isArray(root.providers) || !Array.isArray(root.routes))
    throw new Error("MEMORY_PROVIDER_CONFIG requires providers and routes arrays");
  const providers = root.providers.map((value, i) => {
    const raw = object(value, `MEMORY_PROVIDER_CONFIG.providers[${i}]`);
    const id = string(raw.id, `MEMORY_PROVIDER_CONFIG.providers[${i}].id`);
    if (!ID.test(id) || id === "default") throw new Error(`invalid memory provider id: ${id}`);
    if (raw.type !== "mcp") throw new Error(`memory provider ${id} has unsupported type`);
    const timeoutMs = raw.timeoutMs === undefined ? 3_000 : raw.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) <= 0 || Number(timeoutMs) > 30_000)
      throw new Error(`memory provider ${id}.timeoutMs must be an integer from 1 to 30000`);
    return {
      id,
      type: "mcp" as const,
      url: privateMcpUrl(raw.url, `memory provider ${id}.url`),
      timeoutMs: Number(timeoutMs),
      read: operation(raw.read, `memory provider ${id}.read`, env),
      ...(raw.write ? { write: operation(raw.write, `memory provider ${id}.write`, env) } : {}),
    };
  });
  const ids = new Set(["default", ...providers.map(({ id }) => id)]);
  if (ids.size !== providers.length + 1) throw new Error("memory provider ids must be unique");
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const routes = root.routes.map((value, i): MemoryProviderRoute => {
    const raw = object(value, `MEMORY_PROVIDER_CONFIG.routes[${i}]`);
    const provider = string(raw.provider, `MEMORY_PROVIDER_CONFIG.routes[${i}].provider`);
    if (!ids.has(provider)) throw new Error(`unknown memory provider in route: ${provider}`);
    if (!Array.isArray(raw.scopes) || !raw.scopes.length) throw new Error(`memory route ${i} requires scopes`);
    const capture = raw.capture ?? "off";
    if (!(["off", "explicit", "automatic"] as unknown[]).includes(capture))
      throw new Error(`memory route ${i} has invalid capture policy`);
    if (provider !== "default" && capture !== "off" && !providerById.get(provider)?.write)
      throw new Error(`memory route ${i} enables capture but provider ${provider} has no write operation`);
    return {
      provider,
      scopes: raw.scopes.map((value, j) => scope(value, `memory route ${i}.scopes[${j}]`)),
      capture: capture as MemoryCapturePolicy,
      ...(typeof raw.recall === "boolean" ? { recall: raw.recall } : {}),
      manage: provider === "default",
      ...(typeof raw.manage === "boolean" ? { manage: raw.manage } : {}),
      ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
      failOpen: provider !== "default",
      ...(typeof raw.failOpen === "boolean" ? { failOpen: raw.failOpen } : {}),
    };
  });
  return { providers, routes };
}
