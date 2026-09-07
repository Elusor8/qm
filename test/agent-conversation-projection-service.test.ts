import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgentConversationProjectionService,
  type ProjectionProgress,
} from "../src/conversations/agent-conversation-projection-service.ts";
import {
  createAgentConversationLinkStore,
  agentConversationLinkId,
} from "../src/conversations/agent-conversation-link-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";

const side = { owner: "U1", mailbox: "alice.example.viz", conversationId: "conv-1" };
const key = agentConversationLinkId(side);

function observation(turn: number, remoteName = "zipviz_conversation_send", message = `turn ${turn}`) {
  const name = `bound_${remoteName}`;
  return {
    name,
    args: {
      mailbox: side.mailbox,
      conversation_id: side.conversationId,
      expected_turn: 999,
      message: "uncommitted argument",
    },
    raw: {
      conversationBinding: { ...side, remoteName },
      text: JSON.stringify({
        disposition: "replayed-result",
        snapshot: { conversation_id: side.conversationId, turns: turn, peer: "bob.example.viz" },
        turn: { message, conversation: { id: side.conversationId, turn, intent: "accept" } },
      }),
    },
  };
}

async function fixture() {
  const links = createAgentConversationLinkStore();
  const deliveries = createDeliveryStore();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("web:opener", "dm", "personal:U1", undefined, "web");
  const progress = createMemoryMap<ProjectionProgress>();
  const deps = { links, deliveries, projectionSessions: sessions, progress, leaderLease: createNoopLeaderLease() };
  const context = {
    owner: side.owner,
    ownerScopeId: "personal:U1",
    threadRef: session.threadRef,
    sessionId: session.id,
    surface: "web",
    destination: { type: "web", target: session.threadRef, audienceScopeId: "personal:U1" },
  };
  return {
    ...deps,
    sessions,
    session,
    context,
    service: createAgentConversationProjectionService(deps),
    restart: () => createAgentConversationProjectionService(deps),
  };
}

test("held opener lease is retried by a new durable worker without repeating the raw observation", async (t) => {
  const f = await fixture();
  const { lease } = await f.sessions.acquireLease(f.session.id, "turn");
  assert.ok(lease);
  await f.service.capture(f.context, observation(1, "zipviz_conversation_open"));
  assert.ok(await f.links.get(side), "registration persists while the opener owns its lease");
  await f.service.sweep();
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 0);
  assert.equal((await f.deliveries.pending("conversation-projection")).length, 1);
  await f.service.stop();
  await f.sessions.releaseLease(lease);
  const getEntries = f.sessions.getEntries.bind(f.sessions);
  t.mock.method(f.sessions, "getEntries", async () => {
    throw new Error("full history scan forbidden");
  });
  await f.restart().sweep();
  const entries = await getEntries(f.session.id);
  assert.equal(entries.length, 1);
  assert.match(JSON.stringify(entries), /turn 1/);
  assert.doesNotMatch(JSON.stringify(entries), /uncommitted argument/);
  assert.equal((await f.deliveries.pending("web")).length, 1);
  assert.equal((await f.deliveries.pending("conversation-projection")).length, 0);
});

test("queued turns retain protocol order across a gap, restart, concurrent sweep and old replay", async () => {
  const f = await fixture();
  await f.service.capture(f.context, observation(1, "zipviz_conversation_open"));
  await f.service.capture(f.context, observation(3));
  await Promise.all([f.service.sweep(), f.service.sweep()]);
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
  assert.match((await f.progress.get(key))!.lastSkipNote!, /waiting for turn 2/);
  await f.restart().capture(f.context, observation(2));
  await f.restart().sweep();
  const entries = await f.sessions.getEntries(f.session.id);
  assert.deepEqual(
    entries.map((e) => (e.payload as { ts: string }).ts.split(":").at(-1)),
    ["1", "2", "3"],
  );
  await f.restart().capture(f.context, observation(1, "zipviz_conversation_open"));
  await f.restart().sweep();
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 3);
  assert.equal((await f.progress.get(key))!.lastTurn, 3);
});

test("lost web nudge persistence retries after restart with one transcript entry", async (t) => {
  const f = await fixture();
  await f.service.capture(f.context, observation(1, "zipviz_conversation_open"));
  const enqueue = f.deliveries.enqueue.bind(f.deliveries);
  t.mock.method(f.deliveries, "enqueue", async (input: Parameters<typeof enqueue>[0]) => {
    if (input.destination.type === "web") throw new Error("nudge unavailable");
    return enqueue(input);
  });
  await f.service.sweep();
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
  assert.equal((await f.progress.get(key))!.lastTurn, 0);
  t.mock.restoreAll();
  await f.restart().sweep();
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
  assert.equal((await f.deliveries.pending("web")).length, 1);
});

test("capture rejects missing or mismatched signed identity and never invents a turn from expected_turn", async () => {
  const f = await fixture();
  const obs = observation(1);
  await f.service.capture(f.context, { ...obs, raw: { text: obs.raw.text } });
  await assert.rejects(f.service.capture({ ...f.context, owner: "U2" }, obs), /principal/);
  await assert.rejects(f.service.capture(f.context, { ...obs, args: { mailbox: "other.example.viz" } }), /mailbox/);
  await assert.rejects(f.service.capture(f.context, { ...obs, raw: { ...obs.raw, text: "{}" } }), /authoritative/);
  assert.equal((await f.deliveries.pending("conversation-projection")).length, 0);
});

test("unlinked receiving owner starts at the first captured turn with no historical backfill", async () => {
  const f = await fixture();
  const obs = observation(8, "zipviz_inbox_claim");
  obs.raw.text = JSON.stringify({
    claimed: [
      {
        from: "bob.example.viz",
        body: "received",
        conversation: { conversation_id: side.conversationId, turn: 8, intent: "accept" },
      },
    ],
  });
  await f.service.capture({ ...f.context, destination: undefined, surface: "webhook" }, obs);
  await f.service.sweep();
  const posted = await f.deliveries.pending("principal");
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.destination.target, "U1");
  assert.equal((await f.progress.get(key))!.baselineTurn, 7);
});

test("long-lived and terminal conversations project every captured turn incrementally", async () => {
  const f = await fixture();
  for (let turn = 1; turn <= 20; turn++) {
    const remote = turn === 1 ? "zipviz_conversation_open" : "zipviz_conversation_send";
    const obs = observation(turn, remote);
    if (turn % 2 === 0) {
      obs.raw.conversationBinding.remoteName = "zipviz_inbox_claim";
      obs.raw.text = JSON.stringify({
        claimed: [
          {
            from: "bob.example.viz",
            body: `turn ${turn}`,
            conversation: {
              conversation_id: side.conversationId,
              turn,
              intent: turn === 20 ? "complete" : "accept",
              state: turn === 20 ? "completed" : "active",
            },
          },
        ],
      });
    }
    await f.service.capture(f.context, obs);
    await f.service.sweep();
    assert.equal((await f.sessions.getEntries(f.session.id)).length, turn);
  }
  assert.equal((await f.deliveries.pending("web")).length, 20);
  assert.equal((await f.progress.get(key))!.lastTurn, 20);
  const entries = await f.sessions.getEntries(f.session.id);
  assert.match(JSON.stringify(entries.at(-1)), /complete/);
  assert.ok(entries.every((entry) => (entry.payload as { kind: string }).kind === "agent_conversation_projection"));
});

test("adoption registers the actual response without a peer or fabricated history", async () => {
  const f = await fixture();
  const obs = observation(0, "zipviz_conversation_adopt");
  obs.raw.text = JSON.stringify({
    mailbox: side.mailbox,
    conversation_id: side.conversationId,
    binding_role: "ingress-owner",
  });
  await f.service.capture(f.context, obs);
  const link = await f.links.get(side);
  assert.equal(link?.destination?.target, f.session.threadRef);
  assert.equal(link?.peer, undefined);
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 0);
  assert.equal((await f.deliveries.pending("conversation-projection")).length, 0);
  await f.service.capture(f.context, observation(9));
  await f.service.sweep();
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
});

test("an explicit no-destination opening stays silent through durable retry", async () => {
  const f = await fixture();
  await f.service.capture({ ...f.context, destination: undefined }, observation(1, "zipviz_conversation_open"));
  await f.restart().sweep();
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 0);
  assert.equal((await f.deliveries.pending("principal")).length, 0);
  assert.equal((await f.links.get(side))?.destination, undefined);
});
