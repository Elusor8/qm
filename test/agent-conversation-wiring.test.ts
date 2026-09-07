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

for (const surface of ["web", "slack"] as const) {
  test(`wired ${surface} opener captures the committed raw turn under its lease and projects after it completes`, async (t) => {
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
    const result = await built.app.turn({
      surface,
      actor: { externalId: "U1" },
      conversation: { kind: "channel", threadRef, channelRef: "C1", audience: [{ externalId: "U1" }] },
      deliveryTarget,
      text: `!mcp ${name} ${JSON.stringify({ mailbox, peer: "bob.example.viz", message: "UNCOMMITTED_ARGUMENT" })}`,
    });
    assert.equal(result.status, "ok", result.reason);
    assert.ok(requests.some((request) => request.method === "tools/call"));
    const link = await built.conversationLinks.get({ owner: "U1", mailbox, conversationId });
    assert.equal(link?.openerSessionId, result.sessionId);
    assert.equal(link?.destination?.target, deliveryTarget);
    assert.equal(link?.ownerScopeId, "channel:C1");
    assert.equal((await built.deliveries.pending("conversation-projection")).length, 1);
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
