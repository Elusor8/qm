import { runTrigger } from "../src/triggers/run-trigger.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { test } from "node:test";
import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";

for (const kind of ["channel", "group", "dm"] as const) {
  test(`human ${kind} ingress delivers without a synthetic surfaceTools flag`, async (t) => {
    const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "review-ordinary-")) }));
    try {
      await built.app.upsertDirectory([{ principalId: "U1", displayName: "Alice", type: "internal" }]);
      await built.app.upsertChannels(
        [{ channelId: "C1", name: "room", isPrivate: true }],
        [{ channelId: "C1", principalId: "U1" }],
      );
      if (kind === "group") await built.app.upsertGroups([{ groupId: "C1", principalId: "U1" }]);
      const result = await built.app.turn({
        surface: "slack",
        actor: { externalId: "U1" },
        liveActor: true,
        triggerTs: "123.456",
        conversation: {
          kind,
          threadRef: kind === "dm" ? "dm:D1:123.456" : "ch:C1:123.456",
          ...(kind !== "dm" ? { channelRef: "C1", audience: [{ externalId: "U1" }] } : {}),
        },
        deliveryTarget: kind === "dm" ? "D1:123.456" : "C1:123.456",
        text: kind !== "dm" ? "!post Ordinary assistant response" : "Normal reply control",
      });
      assert.ok(["ok", "silent"].includes(result.status), JSON.stringify(result));
      const before = await built.deliveries.pending("slack");
      assert.equal(before.length, 1, JSON.stringify(before));
      if (kind !== "dm") assert.equal(before[0]!.provenance!.trigger, "conversation");
      assert.equal(before[0]!.provenance?.conversation, undefined);
      const posts: any[] = [];
      const client = {
        chat: {
          postMessage: async (args: any) => {
            posts.push(args);
            return { ts: "124.1", channel: args.channel };
          },
        },
        conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
      };
      const poller = createDeliveryPoller({
        core: {
          claimDeliveries: (type: string, ttl: number) => built.app.pendingDeliveries(type, ttl),
          authorizeConversationDelivery: (id: string) => built.app.authorizeConversationDelivery(id),
          ackDelivery: (id: string) => built.app.ackDelivery(id),
        } as never,
        bridge: { inFlightRuns: new Set() } as never,
        mirror: { mirrorSelfPost() {} } as never,
        threads: { mark() {} } as never,
        clientForIdentity: () => client,
      });
      const realNow = Date.now;
      t.mock.method(Date, "now", () => realNow() + 120_000);
      try {
        await poller.pollDeliveries(client);
      } finally {
        t.mock.restoreAll();
      }
      assert.equal(posts.length, 1);
      assert.equal((await built.deliveries.pending("slack")).length, 0);
      assert.equal(before[0]!.claimAttempts, undefined);
    } finally {
      built.mcpToolService.close();
      await built.runtime.stop();
    }
  });
}

test("monitor liveDelivery remains deliverable through runTrigger", async (t) => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "review-ordinary-")) }));
  try {
    await built.app.upsertDirectory([{ principalId: "U1", displayName: "Alice", type: "internal" }]);
    await built.app.upsertChannels(
      [{ channelId: "C1", name: "room", isPrivate: true }],
      [{ channelId: "C1", principalId: "U1" }],
    );
    let result: any;
    await runTrigger(
      {
        deliveries: built.deliveries,
        idempotency: createIdempotencyStore(createMemoryMap()),
        identity: createIdentityService(),
        run: async (req) => {
          assert.equal(req.triggered, true);
          assert.equal(req.surfaceTools, true);
          result = await built.app.turn(req);
          return result;
        },
      },
      {
        owner: "U1",
        ownerScopeId: "channel:C1",
        surface: "monitor",
        fireKey: "monitor:diagnostic:1",
        input: "!post Monitor control",
        threadRef: "C1:123.456",
        destination: { type: "slack", target: "C1:123.456", audienceScopeId: "channel:C1" },
      },
    );
    assert.ok(["ok", "silent"].includes(result.status), JSON.stringify(result));
    const before = await built.deliveries.pending("slack");
    assert.equal(before.length, 1, JSON.stringify(before));
    assert.equal(before[0]!.provenance!.trigger, "monitor");
    assert.equal(before[0]!.provenance?.conversation, undefined);
    const posts: any[] = [];
    const client = {
      chat: {
        postMessage: async (args: any) => {
          posts.push(args);
          return { ts: "124.1", channel: args.channel };
        },
      },
      conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
    };
    const poller = createDeliveryPoller({
      core: {
        claimDeliveries: (type: string, ttl: number) => built.app.pendingDeliveries(type, ttl),
        authorizeConversationDelivery: (id: string) => built.app.authorizeConversationDelivery(id),
        ackDelivery: (id: string) => built.app.ackDelivery(id),
      } as never,
      bridge: { inFlightRuns: new Set() } as never,
      mirror: { mirrorSelfPost() {} } as never,
      threads: { mark() {} } as never,
      clientForIdentity: () => client,
    });
    const realNow = Date.now;
    t.mock.method(Date, "now", () => realNow() + 120_000);
    try {
      await poller.pollDeliveries(client);
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(posts.length, 1);
    assert.equal((await built.deliveries.pending("slack")).length, 0);
  } finally {
    built.mcpToolService.close();
    await built.runtime.stop();
  }
});
