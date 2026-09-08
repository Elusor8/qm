import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";

const mailbox = "alice.example.viz";
const conversationId = "conv-00000000-0000-4000-8000-000000000001";
const binding = {
  mailbox,
  actorPrincipalId: "U1",
  actorExternalId: "alice",
  adapterKind: "https://example.invalid/adapter",
  adapterInstance: "test",
};

for (const scenario of ["web", "slack", "capture-retry"] as const) {
  const surface = scenario === "slack" ? "slack" : "web";
  test(`wired ${scenario} opener captures the committed raw turn under its lease and projects after it completes`, async (t) => {
    const requests: Array<Record<string, any>> = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
      assert.equal(String(url), "https://mcp-projection.invalid/mcp");
      const request = JSON.parse(String(init.body));
      requests.push(request);
      const result =
        request.method === "tools/list"
          ? { tools: [{ name: "zipviz_conversation_open", inputSchema: { type: "object" } }] }
          : {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    snapshot: { conversation_id: conversationId, turns: 1, peer: "bob.example.viz" },
                    turn: {
                      message: "SIGNED_COMMITTED_BODY",
                      conversation: { id: conversationId, turn: 1, intent: "propose" },
                    },
                  }),
                },
              ],
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "projection-wiring-")), signingSecret: "projection-fixture" }),
    );
    t.after(async () => {
      built.mcpToolService.close();
      await built.runtime.stop();
    });
    await built.app.upsertDirectory([{ principalId: "U1", displayName: "Alice", type: "internal" }]);
    await built.app.upsertChannels(
      [{ channelId: "C1", name: "private", isPrivate: true }],
      [{ channelId: "C1", principalId: "U1" }],
    );
    await built.mcpServers.put({
      id: "zipviz",
      name: "ZipViz",
      url: "https://mcp-projection.invalid/mcp",
      auth: "none",
      enabled: true,
      readOnly: false,
      updatedAt: 0,
      updatedBy: "U1",
      zipviz: binding,
    });
    await built.mcpToolService.refresh();
    const name = built.mcpToolService.toolDefs()[0]!.name;
    const threadRef = `${surface}:U1:opener`;
    const deliveryTarget = surface === "web" ? threadRef : "C1:123.456";
    let failedCapture = false;
    if (scenario === "capture-retry") {
      const enqueue = built.deliveries.enqueue.bind(built.deliveries);
      t.mock.method(built.deliveries, "enqueue", async (input: Parameters<typeof enqueue>[0]) => {
        if (input.destination.type === "conversation-projection" && !failedCapture) {
          failedCapture = true;
          throw new Error("durable capture unavailable");
        }
        return enqueue(input);
      });
    }
    const request = {
      surface,
      actor: { externalId: "U1" },
      conversation: { kind: "channel" as const, threadRef, channelRef: "C1", audience: [{ externalId: "U1" }] },
      deliveryTarget,
      text: `!mcp ${name} ${JSON.stringify({ mailbox, peer: "bob.example.viz", message: "UNCOMMITTED_ARGUMENT" })}`,
    };
    const result = await built.app.turn(request);
    if (scenario === "capture-retry") {
      assert.equal(result.status, "ok", "capture failure cannot falsify the committed MCP operation");
      assert.equal((await built.deliveries.pending("conversation-projection")).length, 0);
      await built.conversationProjection.sweep();
    }
    assert.equal(result.status, "ok", result.reason);
    assert.ok(requests.some((request) => request.method === "tools/call"));
    const link = await built.conversationLinks.get({ owner: "U1", mailbox, conversationId });
    assert.equal(link?.openerSessionId, result.sessionId);
    assert.equal(link?.destination?.target, deliveryTarget);
    assert.equal(link?.ownerScopeId, "channel:C1");
    assert.equal(
      (await built.deliveries.pending("conversation-projection")).length,
      scenario === "capture-retry" ? 0 : 1,
    );
    assert.equal(requests.filter((r) => r.method === "tools/call").length, 1);
    await built.conversationProjection.sweep();
    assert.equal((await built.deliveries.pending("conversation-projection")).length, 0);
    if (surface === "web") {
      const projected = (await built.sessions.getEntries(result.sessionId!)).filter(
        (entry) => (entry.payload as { kind?: string })?.kind === "agent_conversation_projection",
      );
      assert.equal(projected.length, 1);
      assert.match(JSON.stringify(projected), /SIGNED_COMMITTED_BODY/);
      assert.doesNotMatch(JSON.stringify(projected), /UNCOMMITTED_ARGUMENT/);
      assert.equal(
        (await built.deliveries.pending("web")).filter((delivery) =>
          delivery.idempotencyKey.startsWith("zvconv:nudge:"),
        ).length,
        1,
      );
    } else {
      const posts: Array<Record<string, any>> = [];
      const client = {
        chat: {
          postMessage: async (args: Record<string, any>) => {
            posts.push(args);
            return { ts: "124.1", channel: args.channel };
          },
        },
      };
      const core = {
        claimDeliveries: (type: string, ttl: number) => built.app.pendingDeliveries(type, ttl),
        authorizeConversationDelivery: (id: string) => built.app.authorizeConversationDelivery(id),
        ackDelivery: (id: string) => built.app.ackDelivery(id),
      };
      const poller = createDeliveryPoller({
        core: core as never,
        bridge: { inFlightRuns: new Set() } as never,
        mirror: { mirrorSelfPost() {} } as never,
        threads: { mark() {} } as never,
        clientForIdentity: () => client,
      });
      await poller.pollDeliveries(client);
      const projected = posts.filter((post) => post.metadata?.event_payload?.idempotency_key?.startsWith("zvconv:"));
      assert.equal(projected.length, 1);
      assert.equal(projected[0]!.channel, "C1");
      assert.match(projected[0]!.text, /SIGNED_COMMITTED_BODY/);
    }
  });
}

for (const isError of [false, true]) {
  test(`wired receiving mailbox uses the bound owner's resolved DM and unclamped claim (error=${isError})`, async (t) => {
    const owner = "alice@example.test";
    const body = `PEER_PREFIX ${"x".repeat(70_000)} TAIL_RAW_CAPTURE`;
    const claim = JSON.stringify({
      claimed: [
        {
          from: "bob.example.viz",
          body,
          conversation: {
            conversation_id: conversationId,
            turn: 2,
            intent: "accept",
            state: "active",
            waiting_on: "us",
            reply_due: true,
          },
        },
      ],
    });
    t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
      assert.equal(String(url), "https://mcp-projection.invalid/mcp");
      const request = JSON.parse(String(init.body));
      const result =
        request.method === "tools/list"
          ? { tools: [{ name: "zipviz_inbox_claim", inputSchema: { type: "object" } }] }
          : { isError, content: [{ type: "text", text: claim }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "projection-receiver-")), signingSecret: "projection-fixture" }),
    );
    t.after(async () => {
      built.mcpToolService.close();
      await built.runtime.stop();
    });
    await built.app.upsertDirectory([{ principalId: owner, displayName: "Alice", type: "internal" }]);
    await built.mcpServers.put({
      id: "receiver",
      name: "Receiving mailbox",
      url: "https://mcp-projection.invalid/mcp",
      auth: "none",
      enabled: true,
      readOnly: false,
      updatedAt: 0,
      updatedBy: owner,
      zipviz: { ...binding, actorPrincipalId: owner },
    });
    await built.mcpToolService.refresh();
    const name = built.mcpToolService.toolDefs()[0]!.name;
    const result = await built.app.turn({
      surface: "webhook",
      actor: { externalId: owner },
      conversation: { kind: "dm", threadRef: "webhook:receiver" },
      triggered: true,
      text: `!mcp ${name} ${JSON.stringify({ mailbox })}`,
    });
    const jobs = await built.deliveries.pending("conversation-projection");
    if (isError) {
      assert.equal(jobs.length, 0);
      return;
    }
    assert.equal(result.status, "ok", result.reason);
    assert.equal(jobs.length, 1);
    assert.match(jobs[0]!.text, /TAIL_RAW_CAPTURE/);
    assert.ok((result.reply?.length ?? Infinity) < claim.length);
    await built.conversationProjection.sweep();
    const queued = await built.deliveries.pending("principal");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.destination.target, owner);
    const posts: Array<Record<string, any>> = [];
    const client = {
      users: {
        lookupByEmail: async (args: { email: string }) => {
          assert.equal(args.email, owner);
          return { user: { id: "U_RESOLVED_OWNER" } };
        },
      },
      conversations: {
        open: async (args: { users: string }) => {
          assert.equal(args.users, "U_RESOLVED_OWNER");
          return { channel: { id: "D_OWNER" } };
        },
      },
      chat: {
        postMessage: async (args: Record<string, any>) => {
          posts.push(args);
          return { ts: "456.1", channel: args.channel };
        },
      },
    };
    const core = {
      claimDeliveries: (type: string, ttl: number) => built.app.pendingDeliveries(type, ttl),
      authorizeConversationDelivery: (id: string) => built.app.authorizeConversationDelivery(id),
      ackDelivery: (id: string) => built.app.ackDelivery(id),
    };
    const poller = createDeliveryPoller({
      core: core as never,
      bridge: { inFlightRuns: new Set() } as never,
      mirror: { mirrorSelfPost() {} } as never,
      threads: { mark() {} } as never,
      clientForIdentity: () => client,
    });
    await poller.pollDeliveries(client);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.channel, "D_OWNER");
    assert.match(posts[0]!.text, /PEER_PREFIX/);
    assert.match(posts[0]!.text, /truncated/);
  });
}

test("a peer claim can return before the committed open response without losing the opening projection", async (t) => {
  let releaseOpen!: () => void;
  let committed!: () => void;
  const remoteCommitted = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const delayedResponse = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "capture-race-")), signingSecret: "projection-fixture" }),
  );
  t.after(() => built.mcpToolService.close());
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    let result;
    if (request.method === "tools/list")
      result = {
        tools: ["zipviz_conversation_open", "zipviz_inbox_claim"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      };
    else {
      if (request.params.name === "zipviz_conversation_open") {
        committed();
        await delayedResponse;
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                disposition: "new",
                snapshot: { conversation_id: conversationId, turns: 1, peer: "bob.example.viz" },
                turn: { message: "signed open", conversation: { id: conversationId, turn: 1, intent: "propose" } },
              }),
            },
          ],
        };
      } else
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                claimed: [
                  {
                    from: "bob.example.viz",
                    body: "signed peer response",
                    conversation: { conversation_id: conversationId, turn: 2, intent: "accept" },
                  },
                ],
              }),
            },
          ],
        };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  await built.mcpServers.put({
    id: "zipviz",
    name: "ZipViz",
    url: "https://mcp-projection.invalid/mcp",
    auth: "none",
    enabled: true,
    readOnly: false,
    updatedAt: 0,
    updatedBy: "U1",
    zipviz: binding,
  });
  await built.mcpToolService.refresh();
  const call = (remoteName: string, threadRef: string) =>
    built.mcpToolService.call(
      `zipviz_${remoteName}`,
      { mailbox, peer: "bob.example.viz", message: "argument" },
      {
        runtimeContext: { actorId: "U1", threadRef, nativeEventId: threadRef },
        onCallStart: (input) =>
          built.conversationProjection.begin(
            {
              owner: "U1",
              ownerScopeId: "personal:U1",
              threadRef,
              sessionId: threadRef,
              surface: "slack",
              destination: { type: "principal", target: "U1", onBehalfOf: "U1" },
            },
            input,
          ),
      },
    );
  const opening = call("zipviz_conversation_open", "opening-session");
  await remoteCommitted;
  await call("zipviz_inbox_claim", "webhook-session");
  await built.conversationProjection.sweep();
  assert.equal((await built.deliveries.pending("principal")).length, 0);
  releaseOpen();
  await opening;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await built.conversationProjection.sweep();
  const posts = await built.deliveries.pending("principal");
  assert.deepEqual(
    posts.map((d) => d.provenance?.conversation?.turn),
    [1, 2],
  );
  assert.match(posts[0]!.text, /signed open/);
  assert.match(posts[1]!.text, /signed peer response/);
});
