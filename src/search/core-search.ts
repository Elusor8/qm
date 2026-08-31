import type { Principal } from "../types.ts";
import { collectBytes } from "../util/bytes.ts";

export const SEARCH_PRINCIPALS_HEADER = "x-qm-principals";
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SEARCH_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
type SearchHitType = "message" | "conversation" | "file" | "page" | "external";
export interface BackendSearchHit {
  id: string;
  type: SearchHitType;
  title?: string;
  snippet: string;
  url?: string;
  createdAt?: number;
  score?: number;
  metadata?: Record<string, unknown>;
}
export interface SearchHit extends BackendSearchHit {
  backend: string;
}
interface SearchRequest {
  query: string;
  principals: readonly Principal[];
  limit: number;
}
export interface SearchBackend {
  name: string;
  search(request: SearchRequest): Promise<BackendSearchHit[]>;
}
export interface CoreSearch {
  search(input: {
    query: string;
    principals: readonly Principal[];
    limit?: number;
  }): Promise<{ hits: SearchHit[]; failedBackends: string[] }>;
}
function canonicalPrincipals(principals: readonly Principal[]): Principal[] {
  const unique = new Map<string, Principal>();
  for (const principal of principals) {
    const id = principal.id.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (!unique.has(key)) unique.set(key, { ...principal, id });
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function searchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
}
export function createCoreSearch(
  backends: readonly SearchBackend[],
  opts: { onBackendError?: (backend: string, error: unknown) => void } = {},
): CoreSearch {
  const names = new Set<string>();
  for (const backend of backends) {
    if (!backend.name.trim() || names.has(backend.name))
      throw new Error(`duplicate or empty search backend: ${backend.name}`);
    names.add(backend.name);
  }
  return {
    async search(input) {
      const query = input.query.trim();
      const principals = canonicalPrincipals(input.principals);
      if (!query || !principals.length) return { hits: [], failedBackends: [] };
      const limit = searchLimit(input.limit);
      const settled = await Promise.allSettled(backends.map((backend) => backend.search({ query, principals, limit })));
      const hits: SearchHit[] = [];
      const failedBackends: string[] = [];
      for (const [index, result] of settled.entries()) {
        const backend = backends[index]!;
        if (result.status === "rejected") {
          failedBackends.push(backend.name);
          opts.onBackendError?.(backend.name, result.reason);
          continue;
        }
        for (const hit of result.value.slice(0, limit)) hits.push({ ...hit, backend: backend.name });
      }
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return { hits: hits.slice(0, limit), failedBackends };
    },
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseHit(value: unknown): BackendSearchHit | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.snippet !== "string") return null;
  const allowed = new Set<SearchHitType>(["message", "conversation", "file", "page", "external"]);
  if (typeof value.type !== "string" || !allowed.has(value.type as SearchHitType)) return null;
  return {
    id: value.id,
    type: value.type as SearchHitType,
    snippet: value.snippet,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? { createdAt: value.createdAt } : {}),
    ...(typeof value.score === "number" && Number.isFinite(value.score) ? { score: value.score } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}
export function createHttpSearchBackend(opts: {
  name: string;
  url: string;
  fetch?: typeof fetch;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}): SearchBackend {
  const endpoint = new URL(opts.url);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1")
    throw new Error(`search backend ${opts.name} must use https`);
  const doFetch = opts.fetch ?? fetch;
  return {
    name: opts.name,
    async search(request) {
      const response = await doFetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        headers: {
          "content-type": "application/json",
          ...opts.headers,
          [SEARCH_PRINCIPALS_HEADER]: JSON.stringify(request.principals.map((p) => p.id)),
        },
        body: JSON.stringify({ query: request.query, limit: request.limit }),
      });
      if (!response.ok) throw new Error(`search backend ${opts.name} returned ${response.status}`);
      if (!response.body) throw new Error(`search backend ${opts.name} returned an empty body`);
      const bytes = await collectBytes(response.body, {
        maxBytes: SEARCH_RESPONSE_MAX_BYTES,
        tooLarge: () => new Error(`search backend ${opts.name} response is too large`),
      });
      let body: unknown;
      try {
        body = JSON.parse(bytes.data.toString("utf8"));
      } catch {
        throw new Error(`search backend ${opts.name} returned invalid JSON`);
      }
      if (!isRecord(body) || !Array.isArray(body.hits))
        throw new Error(`search backend ${opts.name} returned invalid JSON`);
      return body.hits.map(parseHit).filter((hit): hit is BackendSearchHit => hit !== null);
    },
  };
}
