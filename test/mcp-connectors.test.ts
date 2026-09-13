import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, mcpResultText, type McpFetch } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

function jsonResponse(body: unknown, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
  };
}

const TOOLS = [
  { name: "query", description: "Run a query", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "update", description: "Write a record", inputSchema: { type: "object", properties: {} } },
];

function fakeServerFetch(opts?: { requireBearer?: string; sse?: boolean }): { fetch: McpFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    if (opts?.requireBearer && init.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const req = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    const result =
      req.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: `ran ${req.params.name}` }] };
    const envelope = { jsonrpc: "2.0", id: req.id, result };
    if (opts?.sse) {
      return jsonResponse(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, 200, "text/event-stream");
    }
    return jsonResponse(envelope);
  };
  return { fetch, calls };
}

function server(partial?: Partial<McpServer>): McpServer {
  return {
    id: "crm",
    name: "CRM",
    url: "https://mcp.example.com/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("mcp client lists tools and calls one over plain JSON", async () => {
  const { fetch } = fakeServerFetch();
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["query", "update"],
  );
  const result = await client.callTool("query", { q: "hi" });
  assert.equal(mcpResultText(result), "ran query");
});

test("mcp client parses SSE-framed responses", async () => {
  const { fetch } = fakeServerFetch({ sse: true });
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
});

test("mcp client sends bearer auth", async () => {
  const { fetch } = fakeServerFetch({ requireBearer: "sekret" });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "sekret" },
    fetchImpl: fetch,
  });
  assert.equal((await client.listTools()).length, 2);
  const bad = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => bad.listTools(), /HTTP 401/);
});

test("server id validation", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});

test("tool service exposes namespaced tools and calls through", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const defs = service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["crm_query", "crm_update"]);
  assert.ok(defs.every((d) => d.readOnly));
  const out = await service.call("crm_query", { q: "hello" }, { principalId: "internal:U1" });
  assert.equal(out, "ran query");
  service.close();
});

test("read-only calls check the current server posture before outbound dispatch", async () => {
  const backing = createMemoryMap<McpServer>();
  const store = createMcpServerStore(backing);
  const { fetch, calls } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();

  assert.equal(await service.call("crm_query", {}, { readOnly: true }), "ran query");
  await backing.put("crm", server({ readOnly: false }));
  assert.ok(service.toolDefs().every((def) => def.readOnly));
  const callsBeforeBlockedAttempt = calls.length;

  await assert.rejects(() => service.call("crm_update", {}, { readOnly: true }), /unavailable in read-only turns/);
  assert.equal(calls.length, callsBeforeBlockedAttempt);
  assert.equal(await service.call("crm_update", {}), "ran update");

  await service.refresh();
  assert.ok(service.toolDefs().every((def) => !def.readOnly));
  await backing.put("crm", server({ readOnly: true }));
  assert.equal(await service.call("crm_query", {}, { readOnly: true }), "ran query");
  service.close();
});

test("disabled server's tools disappear and calls fail", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

test("marks ZipViz-bound tools as observable, and only those", async () => {
  const { fetch } = fakeServerFetch();
  const store = createMcpServerStore(createMemoryMap());
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server({ id: "crm" }));
  await store.put(
    server({
      id: "zipviz",
      name: "ZipViz",
      zipviz: { mailbox: "alice.example.viz", adapterKind: "k", adapterInstance: "i", principalRef: "p" },
    } as never),
  );
  await service.refresh();

  const defs = service.toolDefs();
  assert.equal(defs.find((d) => d.name === "zipviz_query")?.agentConversations, true);
  assert.equal(defs.find((d) => d.name === "crm_query")?.agentConversations, false);
});

test("a projection hint failure never refuses remote dispatch", async (t) => {
  const { fetch, calls } = fakeServerFetch();
  const store = createMcpServerStore(createMemoryMap());
  const service = createMcpToolService({ servers: store, fetchImpl: fetch });
  t.after(() => service.close());
  await store.put(server());
  await service.refresh();
  const count = calls.length;
  const out = await service.call(
    "crm_query",
    {},
    {
      onCallStart: async () => {
        throw new Error("projection database unavailable");
      },
    },
  );
  assert.equal(out, "ran query");
  assert.equal(calls.length, count + 1);
});

test("authorized machine reads preserve large projection pages while model calls stay clamped", async (t) => {
  const body = "x".repeat(70_000);
  const page = JSON.stringify({ events: [{ body }, { body: "second" }], skipped: [], has_more: false });
  const fetch: McpFetch = async (_url, init) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params?: { name?: string } };
    const result =
      request.method === "tools/list"
        ? { tools: [{ name: "zipviz_conversation_projection_events", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: page }] };
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  };
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fetch,
    signingSecret: "x".repeat(32),
    refreshIntervalMs: 3600_000,
  });
  t.after(() => service.close());
  await store.put(
    server({
      id: "zipviz",
      readOnly: false,
      zipviz: {
        mailbox: "alice.example.viz",
        adapterKind: "https://example.invalid/adapter",
        adapterInstance: "qm",
        actorExternalId: "alice",
        actorPrincipalId: "U1",
      },
    }),
  );
  await service.refresh();
  const options = {
    principalId: "U1",
    runtimeContext: { actorId: "U1", threadRef: "slack:C1:1", nativeEventId: "projection-read" },
  };
  const machine = await service.machineRead("zipviz_zipviz_conversation_projection_events", {}, options);
  assert.equal(JSON.parse(machine).events[0].body.length, 70_000);
  const model = await service.call("zipviz_zipviz_conversation_projection_events", {}, options);
  assert.equal(model.length, 60_012);
  assert.match(model, /\[truncated\]$/);
  assert.throws(() => JSON.parse(model));
});

for (const failure of ["throw", "reject", "pending"] as const) {
  test(`post-success projection ${failure} does not change or delay remote success`, { timeout: 2_000 }, async (t) => {
    const { fetch } = fakeServerFetch();
    const store = createMcpServerStore(createMemoryMap<McpServer>());
    const service = createMcpToolService({ servers: store, fetchImpl: fetch });
    t.after(() => service.close());
    await store.put(server());
    await service.refresh();
    const pending = Promise.withResolvers<void>();
    t.after(() => pending.resolve());
    let observed = false;
    const result = await service.call(
      "crm_query",
      { q: "hello" },
      {
        onCallSuccess: (call) => {
          observed = true;
          assert.deepEqual(Object.keys(call).sort(), [
            "args",
            "conversationBinding",
            "name",
            "runtimeContext",
            "serverId",
          ]);
          if (failure === "throw") throw new Error("projection unavailable");
          if (failure === "reject") return Promise.reject(new Error("projection unavailable"));
          return pending.promise;
        },
      },
    );
    assert.equal(result, "ran query");
    assert.equal(observed, true);
  });
}

test("failed remote calls do not emit post-success hints", async (t) => {
  const { fetch } = fakeServerFetch();
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({
    servers: store,
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === "tools/call")
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { isError: true, content: [{ type: "text", text: "remote failure" }] },
        });
      return fetch(url, init);
    },
  });
  t.after(() => service.close());
  await store.put(server());
  await service.refresh();
  let successes = 0;
  await assert.rejects(
    service.call(
      "crm_query",
      {},
      {
        onCallSuccess: () => {
          successes += 1;
        },
      },
    ),
    /remote failure/,
  );
  assert.equal(successes, 0);
});
