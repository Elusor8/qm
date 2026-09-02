import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  signZipvizRuntimeContext,
  ZIPVIZ_RUNTIME_CONTEXT_HEADERS,
  zipvizCanonicalContextBytes,
  type ZipvizBinding,
} from "../src/mcp/zipviz-runtime-context.ts";
import { scopeId, type TurnRequest, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const SIGNING_SECRET = "qm-runtime-secret-32-characters-x";
const MAILBOX = "gary.yc.viz";
const ACTOR_EXTERNAL_ID = "qm-gary";
const REMOTE_TOOL = "conversation_mutate";
const NAMESPACED_TOOL = "zipviz_conversation_mutate";
const VECTOR = JSON.parse(readFileSync(new URL("./fixtures/runtime_context_v1.json", import.meta.url), "utf8")) as {
  version: string;
  secret: string;
  timestamp: number;
  binding: {
    adapter_kind: string;
    adapter_instance: string;
    mailbox: string;
    actor_external_id: string;
  };
  thread_ref: string;
  native_event_id: string;
  canonical: string;
  signature: string;
};
const ADAPTER_KIND = VECTOR.binding.adapter_kind;
const ADAPTER_INSTANCE = VECTOR.binding.adapter_instance;

function contractSignature(input: {
  secret: string;
  adapterKind: string;
  adapterInstance: string;
  mailbox: string;
  actorExternalId: string;
  threadRef: string;
  nativeEventId: string;
  timestamp: number;
}): string {
  const canonical = JSON.stringify([
    "zipviz-runtime-context",
    "v1",
    input.adapterKind,
    input.adapterInstance,
    input.mailbox,
    input.actorExternalId,
    input.threadRef,
    input.nativeEventId,
  ]);
  return `v1=${createHmac("sha256", input.secret).update(`v1:${input.timestamp}:${canonical}`).digest("hex")}`;
}

interface CapturedCall {
  headers: Record<string, string | string[] | undefined>;
  body: { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
}

async function startZipvizServer(): Promise<{ url: string; calls: CapturedCall[]; close: () => Promise<void> }> {
  const calls: CapturedCall[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as CapturedCall["body"] & { id: number };
      calls.push({ headers: req.headers, body });
      const result =
        body.method === "tools/list"
          ? { tools: [{ name: REMOTE_TOOL, description: "post to a zipviz conversation", inputSchema: {} }] }
          : { content: [{ type: "text", text: "delivered" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function toolCalls(calls: CapturedCall[]): CapturedCall[] {
  return calls.filter((c) => c.body.method === "tools/call");
}

function zipvizHeaders(call: CapturedCall): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.headers)) {
    if (k.toLowerCase().startsWith("x-zipviz-")) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function record(url: string, zipviz?: ZipvizBinding): McpServer {
  return {
    id: "zipviz",
    name: "ZipViz",
    url,
    auth: "none",
    ...(zipviz ? { zipviz } : {}),
    readOnly: false,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
  };
}

function binding(actorPrincipalId: string): ZipvizBinding {
  return {
    mailbox: MAILBOX,
    actorExternalId: ACTOR_EXTERNAL_ID,
    actorPrincipalId,
    adapterKind: ADAPTER_KIND,
    adapterInstance: ADAPTER_INSTANCE,
  };
}

function dm(text: string, readOnly = false): TurnRequest {
  return {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
    ...(readOnly ? { readOnly: true } : {}),
  };
}

async function boundApp(url: string, opts: { secret?: string } = {}) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "zipviz-")),
      ...(opts.secret === undefined ? {} : { signingSecret: opts.secret }),
    }),
  );
  const actorPrincipalId = built.identity.resolve({ externalId: "U1" }).id;
  await built.mcpServers.put(record(url, binding(actorPrincipalId)));
  await built.mcpToolService.refresh();
  return { built, actorPrincipalId };
}

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

function serviceToolContext(service: ReturnType<typeof createMcpToolService>, extra: Partial<ToolContextDeps>) {
  const scope = scopeId("personal", "U1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  return createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => handle,
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    mcp: service,
    ...extra,
  });
}

function boundService(url: string, secret?: string) {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({
    servers: store,
    ...(secret === undefined ? {} : { signingSecret: secret }),
    refreshIntervalMs: 3_600_000,
  });
  return { store, service };
}

test("canonical signing bytes match the shared generic runtime context vector", () => {
  const configured = binding("internal:U1");
  const claim = {
    threadRef: VECTOR.thread_ref,
    nativeEventId: VECTOR.native_event_id,
    timestamp: VECTOR.timestamp,
  };
  const signature = signZipvizRuntimeContext({ secret: VECTOR.secret, binding: configured, ...claim });
  assert.deepEqual(ZIPVIZ_RUNTIME_CONTEXT_HEADERS, {
    threadRef: "x-zipviz-runtime-thread-ref",
    nativeEventId: "x-zipviz-runtime-native-event-id",
    timestamp: "x-zipviz-runtime-context-timestamp",
    signature: "x-zipviz-runtime-context-signature",
  });
  assert.equal(zipvizCanonicalContextBytes(configured, claim), VECTOR.canonical);
  assert.equal(signature, VECTOR.signature);
  assert.equal(
    signature,
    contractSignature({
      secret: VECTOR.secret,
      adapterKind: VECTOR.binding.adapter_kind,
      adapterInstance: VECTOR.binding.adapter_instance,
      mailbox: VECTOR.binding.mailbox,
      actorExternalId: VECTOR.binding.actor_external_id,
      ...claim,
    }),
  );

  const tampered = [
    signZipvizRuntimeContext({ secret: `${VECTOR.secret}x`, binding: configured, ...claim }),
    signZipvizRuntimeContext({
      secret: VECTOR.secret,
      binding: { ...configured, adapterKind: "https://zipviz.ai/adapters/other" },
      ...claim,
    }),
    signZipvizRuntimeContext({
      secret: VECTOR.secret,
      binding: { ...configured, adapterInstance: "qm-runtime-other" },
      ...claim,
    }),
    signZipvizRuntimeContext({ secret: VECTOR.secret, binding: { ...configured, mailbox: "other.mailbox" }, ...claim }),
    signZipvizRuntimeContext({
      secret: VECTOR.secret,
      binding: { ...configured, actorExternalId: "qm-someone-else" },
      ...claim,
    }),
    signZipvizRuntimeContext({
      secret: VECTOR.secret,
      binding: configured,
      ...claim,
      threadRef: "agent:main:webhook:other",
    }),
    signZipvizRuntimeContext({ secret: VECTOR.secret, binding: configured, ...claim, nativeEventId: "qm-turn-43" }),
    signZipvizRuntimeContext({ secret: VECTOR.secret, binding: configured, ...claim, timestamp: claim.timestamp + 1 }),
  ];
  for (const other of tampered) assert.notEqual(other, signature);
  assert.equal(new Set(tampered).size, tampered.length);
});

test("a real QM turn signs the runtime context onto the bound ZipViz connector call", async () => {
  const zipviz = await startZipvizServer();
  try {
    const { built } = await boundApp(zipviz.url, { secret: SIGNING_SECRET });
    const before = Math.floor(Date.now() / 1000);
    const result = await built.app.turn(dm(`!mcp ${NAMESPACED_TOOL} {"body":"hello"}`));
    assert.equal(result.status, "ok", result.reason);
    assert.match(result.reply ?? "", /mcp: delivered/);

    const calls = toolCalls(zipviz.calls);
    assert.equal(calls.length, 1);
    const headers = zipvizHeaders(calls[0]!);
    assert.deepEqual(Object.keys(headers).sort(), Object.values(ZIPVIZ_RUNTIME_CONTEXT_HEADERS).sort());

    assert.equal(headers[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.threadRef], "dm:U1:t1");
    const timestamp = Number(headers[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.timestamp]);
    assert.ok(timestamp >= before && timestamp <= Math.floor(Date.now() / 1000) + 1);

    const nativeEventId = headers[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.nativeEventId]!;
    const run = await built.runs.get(nativeEventId);
    assert.ok(run, "the native event id is the durable QM run id");
    assert.equal(run.request.conversation.threadRef, "dm:U1:t1");

    assert.equal(
      headers[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.signature],
      contractSignature({
        secret: SIGNING_SECRET,
        adapterKind: ADAPTER_KIND,
        adapterInstance: ADAPTER_INSTANCE,
        mailbox: MAILBOX,
        actorExternalId: ACTOR_EXTERNAL_ID,
        threadRef: "dm:U1:t1",
        nativeEventId,
        timestamp,
      }),
    );
    assert.deepEqual(calls[0]!.body.params?.arguments, { body: "hello" });
  } finally {
    await zipviz.close();
  }
});

test("a read-only QM turn cannot call a mutating MCP connector", async () => {
  const zipviz = await startZipvizServer();
  try {
    const { built } = await boundApp(zipviz.url, { secret: SIGNING_SECRET });
    const result = await built.app.turn(dm(`!mcp ${NAMESPACED_TOOL} {"body":"hello"}`, true));
    assert.equal(result.status, "ok", result.reason);
    assert.equal(result.reply, "[strict/read-only posture: that tool is unavailable]");
    assert.equal(toolCalls(zipviz.calls).length, 0);
  } finally {
    await zipviz.close();
  }
});

test("a read-only QM turn can call an unbound read-only MCP connector", async () => {
  const zipviz = await startZipvizServer();
  try {
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "zipviz-read-only-")), signingSecret: SIGNING_SECRET }),
    );
    await built.mcpServers.put({ ...record(zipviz.url), readOnly: true });
    await built.mcpToolService.refresh();
    const result = await built.app.turn(dm(`!mcp ${NAMESPACED_TOOL} {"body":"hello"}`, true));
    assert.equal(result.status, "ok", result.reason);
    assert.equal(result.reply, "mcp: delivered");
    const calls = toolCalls(zipviz.calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(zipvizHeaders(calls[0]!), {});
  } finally {
    await zipviz.close();
  }
});

test("an unbound MCP connector receives none of the zipviz runtime headers", async () => {
  const zipviz = await startZipvizServer();
  try {
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "zipviz-plain-")), signingSecret: SIGNING_SECRET }),
    );
    await built.mcpServers.put(record(zipviz.url));
    await built.mcpToolService.refresh();
    const result = await built.app.turn(dm(`!mcp ${NAMESPACED_TOOL} {"body":"hello"}`));
    assert.equal(result.status, "ok", result.reason);
    const calls = toolCalls(zipviz.calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(zipvizHeaders(calls[0]!), {});
  } finally {
    await zipviz.close();
  }
});

test("an unbound MCP connector preserves caller-owned arguments with reserved-looking names", async () => {
  const zipviz = await startZipvizServer();
  try {
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "zipviz-unbound-args-")), signingSecret: SIGNING_SECRET }),
    );
    await built.mcpServers.put(record(zipviz.url));
    await built.mcpToolService.refresh();
    const result = await built.app.turn(dm(`!mcp ${NAMESPACED_TOOL} {"thread_ref":"connector-owned"}`));
    assert.equal(result.status, "ok", result.reason);
    const calls = toolCalls(zipviz.calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.body.params?.arguments, { thread_ref: "connector-owned" });
    assert.deepEqual(zipvizHeaders(calls[0]!), {});
  } finally {
    await zipviz.close();
  }
});

test("model-supplied runtime context fields are rejected before the outbound call", async () => {
  const zipviz = await startZipvizServer();
  try {
    const { built } = await boundApp(zipviz.url, { secret: SIGNING_SECRET });
    for (const forged of [
      '{"thread_ref":"agent:main:webhook:mailbox-gary"}',
      '{"native_event_id":"qm-turn-42"}',
      '{"runtime_context":{"mailbox":"gary.yc.viz"}}',
    ]) {
      const result = await built.app.turn(dm(`!mcp ${NAMESPACED_TOOL} ${forged}`));
      assert.equal(result.status, "ok", result.reason);
      assert.match(result.reply ?? "", /not a caller-supplied argument/);
    }
    assert.equal(toolCalls(zipviz.calls).length, 0);
  } finally {
    await zipviz.close();
  }
});

test("a bound connector without the core signing secret fails before any outbound mutation", async () => {
  const zipviz = await startZipvizServer();
  try {
    const { built } = await boundApp(zipviz.url, {});
    const result = await built.app.turn(dm(`!mcp ${NAMESPACED_TOOL} {"body":"hello"}`));
    assert.equal(result.status, "ok", result.reason);
    assert.match(result.reply ?? "", /requires the core signing secret/);
    assert.equal(toolCalls(zipviz.calls).length, 0);
  } finally {
    await zipviz.close();
  }
});

test("a bound connector fails closed without thread, event, or the bound principal", async () => {
  const zipviz = await startZipvizServer();
  const { store, service } = boundService(zipviz.url, SIGNING_SECRET);
  try {
    await store.put(record(zipviz.url, binding("U1")));
    await service.refresh();

    await assert.rejects(
      () => serviceToolContext(service, { threadRef: "dm:U1:t1" }).callMcpTool(NAMESPACED_TOOL, {}),
      /stable runtime native event id/,
    );
    await assert.rejects(
      () => serviceToolContext(service, { runId: "run-1" }).callMcpTool(NAMESPACED_TOOL, {}),
      /runtime thread reference/,
    );
    await assert.rejects(
      () =>
        serviceToolContext(service, { threadRef: "dm:U1:t1", runId: "run-1", createdBy: "U2" }).callMcpTool(
          NAMESPACED_TOOL,
          {},
        ),
      /not bound to the acting runtime principal/,
    );
    assert.equal(toolCalls(zipviz.calls).length, 0);
  } finally {
    service.close();
    await zipviz.close();
  }
});

test("a retried logical turn reuses the native event id; a new turn gets a new one", async () => {
  const zipviz = await startZipvizServer();
  const { store, service } = boundService(zipviz.url, SIGNING_SECRET);
  try {
    await store.put(record(zipviz.url, binding("U1")));
    await service.refresh();
    const call = (runId: string, attempt: number) =>
      serviceToolContext(service, { threadRef: "dm:U1:t1", runId, attempt }).callMcpTool(NAMESPACED_TOOL, {});

    await call("run-a", 1);
    await call("run-a", 2);
    await call("run-b", 1);

    const ids = toolCalls(zipviz.calls).map(
      (c) => zipvizHeaders(c)[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.nativeEventId] as string,
    );
    assert.deepEqual(ids, ["run-a", "run-a", "run-b"]);
    for (const c of toolCalls(zipviz.calls)) {
      const headers = zipvizHeaders(c);
      assert.equal(
        headers[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.signature],
        contractSignature({
          secret: SIGNING_SECRET,
          adapterKind: ADAPTER_KIND,
          adapterInstance: ADAPTER_INSTANCE,
          mailbox: MAILBOX,
          actorExternalId: ACTOR_EXTERNAL_ID,
          threadRef: "dm:U1:t1",
          nativeEventId: headers[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.nativeEventId]!,
          timestamp: Number(headers[ZIPVIZ_RUNTIME_CONTEXT_HEADERS.timestamp]),
        }),
      );
    }
  } finally {
    service.close();
    await zipviz.close();
  }
});
