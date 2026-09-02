import { createHmac } from "node:crypto";

export const ZIPVIZ_RUNTIME_CONTEXT_VERSION = "v1";

export const ZIPVIZ_RUNTIME_CONTEXT_HEADERS = Object.freeze({
  threadRef: "x-zipviz-runtime-thread-ref",
  nativeEventId: "x-zipviz-runtime-native-event-id",
  timestamp: "x-zipviz-runtime-context-timestamp",
  signature: "x-zipviz-runtime-context-signature",
});

export const ZIPVIZ_RESERVED_ARG_KEYS = Object.freeze(["thread_ref", "native_event_id", "runtime_context"]);

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/;

export interface ZipvizBinding {
  adapterKind: string;
  adapterInstance: string;
  mailbox: string;
  actorExternalId: string;
  actorPrincipalId: string;
}

export interface McpRuntimeContext {
  actorId: string;
  threadRef: string;
  nativeEventId: string;
}

export interface ZipvizSigning {
  binding: ZipvizBinding;
  secret: string;
}

export function isValidZipvizIdentifier(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

export function isValidZipvizAdapterKind(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function zipvizCanonicalContextBytes(
  binding: ZipvizBinding,
  claim: { threadRef: string; nativeEventId: string },
): string {
  return JSON.stringify([
    "zipviz-runtime-context",
    ZIPVIZ_RUNTIME_CONTEXT_VERSION,
    binding.adapterKind,
    binding.adapterInstance,
    binding.mailbox,
    binding.actorExternalId,
    claim.threadRef,
    claim.nativeEventId,
  ]);
}

export function signZipvizRuntimeContext(input: {
  secret: string;
  binding: ZipvizBinding;
  threadRef: string;
  nativeEventId: string;
  timestamp: number;
}): string {
  const canonical = zipvizCanonicalContextBytes(input.binding, input);
  const mac = createHmac("sha256", input.secret)
    .update(`${ZIPVIZ_RUNTIME_CONTEXT_VERSION}:${input.timestamp}:${canonical}`)
    .digest("hex");
  return `${ZIPVIZ_RUNTIME_CONTEXT_VERSION}=${mac}`;
}

export function assertNoZipvizRuntimeArgs(args: Record<string, unknown>): void {
  for (const key of ZIPVIZ_RESERVED_ARG_KEYS) {
    if (Object.hasOwn(args, key))
      throw new Error(`${key} is not a caller-supplied argument; it comes from the signed runtime context`);
  }
}

export function zipvizRuntimeContextHeaders(input: {
  signing: ZipvizSigning;
  context: McpRuntimeContext | undefined;
  nowMs: number;
}): Record<string, string> {
  const { binding, secret } = input.signing;
  if (!secret) throw new Error("zipviz connector requires the core signing secret");
  if (
    !isValidZipvizAdapterKind(binding.adapterKind) ||
    !isValidZipvizIdentifier(binding.adapterInstance) ||
    !isValidZipvizIdentifier(binding.mailbox) ||
    !isValidZipvizIdentifier(binding.actorExternalId) ||
    !binding.actorPrincipalId
  )
    throw new Error("zipviz connector binding is incomplete");
  const context = input.context;
  if (!context || !context.actorId) throw new Error("zipviz connector requires an authenticated runtime actor");
  if (context.actorId !== binding.actorPrincipalId)
    throw new Error("zipviz connector is not bound to the acting runtime principal");
  if (!isValidZipvizIdentifier(context.threadRef))
    throw new Error("zipviz connector requires a runtime thread reference");
  if (!isValidZipvizIdentifier(context.nativeEventId))
    throw new Error("zipviz connector requires a stable runtime native event id");
  const timestamp = Math.floor(input.nowMs / 1000);
  return {
    [ZIPVIZ_RUNTIME_CONTEXT_HEADERS.threadRef]: context.threadRef,
    [ZIPVIZ_RUNTIME_CONTEXT_HEADERS.nativeEventId]: context.nativeEventId,
    [ZIPVIZ_RUNTIME_CONTEXT_HEADERS.timestamp]: String(timestamp),
    [ZIPVIZ_RUNTIME_CONTEXT_HEADERS.signature]: signZipvizRuntimeContext({
      secret,
      binding,
      threadRef: context.threadRef,
      nativeEventId: context.nativeEventId,
      timestamp,
    }),
  };
}
