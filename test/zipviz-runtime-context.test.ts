import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
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
  type ZipvizBinding,
} from "../src/mcp/zipviz-runtime-context.ts";
import { scopeId, type TurnRequest, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const SIGNING_SECRET = "qm-runtime-secret-32-characters-x";
const MAILBOX = "gary.yc.viz";
const ACTOR_EXTERNAL_ID = "qm-gary";
const REMOTE_TOOL = "zipviz_qm_conversation_send";
const NAMESPACED_TOOL = "zipviz_zipviz_qm_conversation_send";

function contractSignature(input: {
  secret: string;
  mailbox: string;
  actorExternalId: string;
  adapterInstance: string;
  threadRef: string;
  nativeEventId: string;
  timestamp: number;
}): string {
  const canonical = JSON.stringify([
    "zipviz-qm-runtime-context",
    "v1",
    input.mailbox,
    input.actorExternalId,
    input.adapterInstance,
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

function dm(text: string): TurnRequest {
  return {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
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
  await built.mcpServers.put(record(url, { mailbox: MAILBOX, actorExternalId: ACTOR_EXTERNAL_ID, actorPrincipalId }));
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

test("canonical signing bytes match the published QM runtime context vector", () => {
  const binding: ZipvizBinding = {
    mailbox: MAILBOX,
    actorExternalId: ACTOR_EXTERNAL_ID,
    actorPrincipalId: "internal:U1",
  };
  const claim = {
    threadRef: "agent:main:webhook:mailbox-gary",
    nativeEventId: "qm-turn-42",
    timestamp: 1_800_000_000,
  };
  const signature = signZipvizRuntimeContext({ secret: SIGNING_SECRET, binding, ...claim });
  assert.equal(signature, "v1=2abc66160c39210f1aa814b6d4c39bf67f0db53c862a3c36a5641fe4df6a3bee");
  assert.equal(
    signature,
    contractSignature({
      secret: SIGNING_SECRET,
      mailbox: MAILBOX,
      actorExternalId: ACTOR_EXTERNAL_ID,
      adapterInstance: "qm-reference",
      ...claim,
    }),
  );

  const tampered = [
    signZipvizRuntimeContext({ secret: `${SIGNING_SECRET}x`, binding, ...claim }),
    signZipvizRuntimeContext({ secret: SIGNING_SECRET, binding: { ...binding, mailbox: "other.mailbox" }, ...claim }),
    signZipvizRuntimeContext({
      secret: SIGNING_SECRET,
      binding: { ...binding, actorExternalId: "qm-someone-else" },
      ...claim,
    }),
    signZipvizRuntimeContext({ secret: SIGNING_SECRET, binding, ...claim, threadRef: "agent:main:webhook:other" }),
    signZipvizRuntimeContext({ secret: SIGNING_SECRET, binding, ...claim, nativeEventId: "qm-turn-43" }),
    signZipvizRuntimeContext({ secret: SIGNING_SECRET, binding, ...claim, timestamp: claim.timestamp + 1 }),
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
        mailbox: MAILBOX,
        actorExternalId: ACTOR_EXTERNAL_ID,
        adapterInstance: "qm-reference",
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
    await store.put(
      record(zipviz.url, { mailbox: MAILBOX, actorExternalId: ACTOR_EXTERNAL_ID, actorPrincipalId: "U1" }),
    );
    await service.refresh();

    await assert.rejects(
      () => serviceToolContext(service, { threadRef: "dm:U1:t1" }).callMcpTool(NAMESPACED_TOOL, {}),
      /stable QM native event id/,
    );
    await assert.rejects(
      () => serviceToolContext(service, { runId: "run-1" }).callMcpTool(NAMESPACED_TOOL, {}),
      /QM thread reference/,
    );
    await assert.rejects(
      () =>
        serviceToolContext(service, { threadRef: "dm:U1:t1", runId: "run-1", createdBy: "U2" }).callMcpTool(
          NAMESPACED_TOOL,
          {},
        ),
      /not bound to the acting QM principal/,
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
    await store.put(
      record(zipviz.url, { mailbox: MAILBOX, actorExternalId: ACTOR_EXTERNAL_ID, actorPrincipalId: "U1" }),
    );
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
          mailbox: MAILBOX,
          actorExternalId: ACTOR_EXTERNAL_ID,
          adapterInstance: "qm-reference",
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
