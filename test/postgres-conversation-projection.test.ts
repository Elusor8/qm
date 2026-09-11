import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createAgentConversationLinkStore } from "../src/conversations/agent-conversation-link-store.ts";
import { createAgentConversationProjector } from "../src/conversations/agent-conversation-projector.ts";
import type { ConversationProjectionEvent } from "../src/conversations/conversation-projection-event.ts";
import {
  createPostgresProjectionReaderStore,
  projectionReaderAudienceKey,
  retireLegacyConversationProjection,
} from "../src/conversations/conversation-projection-reader-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL to run projection reader Postgres tests";
const audience = {
  mailbox: "pg-reader.example.viz",
  adapterKind: "https://example.invalid/adapter",
  adapterInstance: "qm",
  externalScope: "thread",
  externalPrincipalRef: "alice",
};

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query(
    "DROP TABLE IF EXISTS agent_conversation_projection_holds, agent_conversation_projection_event_index, agent_conversation_projection_skips, agent_conversation_projection_outbox, agent_conversation_projection_readers CASCADE",
  );
  await pool.end();
});

test("Postgres reader atomically versions checkpoint, outbox and bounded skip evidence", { skip }, async () => {
  const store = createPostgresProjectionReaderStore(URL!);
  const key = projectionReaderAudienceKey(audience);
  assert.equal(
    await store.acceptPage({
      audience,
      expectedVersion: 0,
      jobs: [
        {
          id: "event:1",
          audienceKey: key,
          eventId: "event",
          projectionRevision: 1,
          destinationRevision: 1,
          payload: { body: "processing copy" },
          createdAt: 1,
          availableAt: 0,
          attempts: 0,
          state: "ready",
          subscriptionKey: "subscription-1",
          msgId: "msg-1",
        },
      ],
      skips: Array.from({ length: 110 }, (_, index) => ({
        projectionRevision: index + 2,
        msgId: `msg-${index}`,
        code: "E_PROOF_UNAVAILABLE",
        subscriptionKey: `subscription-${index}`,
      })),
      afterCursor: "cursor-111",
    }),
    true,
  );
  assert.equal((await store.get(audience)).afterCursor, "cursor-111");
  assert.equal((await store.pending(10, Date.now())).length, 1);
  assert.equal((await store.skips(audience)).length, 100);
  assert.equal(await store.held(key, "subscription-0"), true);
  assert.equal(await store.held(key, "subscription-109"), true);
  assert.equal(await store.held(key, "unrelated"), false);
  assert.equal(await store.releaseGap(audience, "msg-0", "operator accepted incomplete history"), true);
  assert.equal(await store.held(key, "subscription-0"), false);
});

test("Postgres concurrent reader versions cannot regress accepted progress", { skip }, async () => {
  const concurrentAudience = { ...audience, externalPrincipalRef: "concurrent-reader" };
  const first = createPostgresProjectionReaderStore(URL!);
  const second = createPostgresProjectionReaderStore(URL!);
  const results = await Promise.all(
    [first, second].map((store, index) =>
      store.acceptPage({
        audience: concurrentAudience,
        expectedVersion: 0,
        jobs: [],
        skips: [],
        afterCursor: `cursor-${index}`,
      }),
    ),
  );
  assert.deepEqual(results.sort(), [false, true]);
  const checkpoint = await first.get(concurrentAudience);
  assert.equal(checkpoint.version, 1);
  assert.match(checkpoint.afterCursor ?? "", /^cursor-[01]$/);
});

test("Postgres unbound work and expiry evidence survive store restarts", { skip }, async () => {
  const key = projectionReaderAudienceKey(audience);
  const first = createPostgresProjectionReaderStore(URL!);
  const checkpoint = await first.get(audience);
  await first.acceptPage({
    audience,
    expectedVersion: checkpoint.version,
    jobs: [
      {
        id: "unbound:event",
        audienceKey: key,
        eventId: "unbound-event",
        projectionRevision: 200,
        destinationRevision: 0,
        payload: { body: "unbound body" },
        createdAt: 1,
        availableAt: 0,
        attempts: 0,
        state: "awaiting_binding",
        subscriptionKey: "unbound-subscription",
        msgId: "unbound-msg",
      },
    ],
    skips: [],
    afterCursor: "cursor-unbound",
  });
  const restarted = createPostgresProjectionReaderStore(URL!);
  assert.equal(
    (await restarted.pending(10, Date.now())).some((row) => row.id === "unbound:event"),
    true,
  );
  await restarted.prune(2);
  const afterPruneRestart = createPostgresProjectionReaderStore(URL!);
  const evidence = (await afterPruneRestart.allOutbox(100)).find((row) => row.id === "unbound:event")!;
  assert.equal(evidence.state, "expired");
  assert.deepEqual(evidence.payload, { expired: true, eventId: "unbound-event", projectionRevision: 200 });
});

test("legacy capture retirement migrates bindings once and preserves conversation links", { skip }, async () => {
  const pg = createPgPool(URL!, []);
  await pg.query("CREATE TABLE IF NOT EXISTS agent_conversation_captures(id TEXT PRIMARY KEY,json JSONB NOT NULL)");
  await pg.query("CREATE TABLE IF NOT EXISTS agent_conversation_links(id TEXT PRIMARY KEY,json JSONB NOT NULL)");
  await pg.query("TRUNCATE agent_conversation_captures,agent_conversation_links");
  await pg.query("INSERT INTO agent_conversation_links(id,json) VALUES('link-1','{\"conversationId\":\"conv-1\"}')");
  await pg.query(`INSERT INTO agent_conversation_captures(id,json) VALUES('capture-1',$1)`, [
    JSON.stringify({
      context: {
        owner: "U1",
        ownerScopeId: "personal:U1",
        threadRef: "slack:C1:1",
        sessionId: "session-1",
        surface: "slack",
      },
      call: {
        serverId: "zipviz",
        runtimeContext: { threadRef: "slack:C1:1" },
        conversationBinding: { mailbox: audience.mailbox, remoteName: "zipviz_conversation_open" },
      },
      createdAt: 1,
    }),
  ]);
  await retireLegacyConversationProjection(pg);
  await retireLegacyConversationProjection(pg);
  assert.equal((await pg.q("SELECT COUNT(*)::int AS n FROM agent_conversation_projection_pending_bindings"))[0]!.n, 1);
  assert.equal((await pg.q("SELECT COUNT(*)::int AS n FROM agent_conversation_links"))[0]!.n, 1);
});

test(
  "Postgres session boundary preserves contiguous projection order and in-place revisions across restart",
  { skip },
  async () => {
    const stamp = Date.now();
    const threadRef = `web:projection-order:${stamp}`;
    const subscriptionKey = `subscription:${stamp}`;
    const first = createPostgresSessionStore(URL!, { now: () => stamp });
    const session = await first.getOrCreateByThread(threadRef, "dm", scopeId("personal", "U1"), undefined, "web");
    const apply = async (
      store: ReturnType<typeof createPostgresSessionStore>,
      turn: number,
      revision: number,
      eventId: string,
    ) => {
      let lease = null;
      for (let attempt = 0; attempt < 20 && !lease; attempt += 1) {
        lease = (await store.acquireLease(session.id, "backfill")).lease;
        if (!lease) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.ok(lease);
      const marker = `zvconv:${subscriptionKey}:${turn}`;
      try {
        return await store.applyProjection(lease, {
          subscriptionKey,
          marker,
          turn,
          revision,
          scopeLabel: session.scopeId,
          entry: {
            type: "user",
            payload: { ts: marker, overheard: true, projectionRevision: revision, eventId, text: eventId },
            scopeLabel: session.scopeId,
          },
        });
      } finally {
        await store.releaseLease(lease);
      }
    };

    const reverse = await Promise.all([apply(first, 8, 1, "event-a"), apply(first, 7, 1, "event-z")]);
    assert.deepEqual(
      reverse.map((result) => result.status),
      ["blocked", "blocked"],
    );
    assert.equal((await first.getEntries(session.id)).length, 0);

    const restarted = createPostgresSessionStore(URL!, { now: () => stamp });
    assert.equal((await apply(restarted, 3, 1, "gap-turn-3")).status, "blocked");
    assert.equal((await apply(restarted, 1, 1, "turn-1")).status, "inserted");
    assert.equal((await apply(restarted, 3, 1, "gap-turn-3")).status, "blocked");
    assert.equal((await apply(restarted, 2, 1, "turn-2")).status, "inserted");
    assert.equal((await apply(createPostgresSessionStore(URL!), 3, 1, "turn-3")).status, "inserted");

    const beforeRevision = await restarted.getEntries(session.id);
    const turnTwoSeq = beforeRevision.find(
      (entry) => (entry.payload as { eventId?: string }).eventId === "turn-2",
    )!.seq;
    assert.equal((await apply(restarted, 2, 2, "turn-2-revised")).status, "updated");
    assert.equal((await apply(restarted, 2, 1, "turn-2-stale")).status, "unchanged");
    const entries = await createPostgresSessionStore(URL!).getEntries(session.id);
    assert.deepEqual(
      entries.map((entry) => (entry.payload as { eventId: string }).eventId),
      ["turn-1", "turn-2-revised", "turn-3"],
    );
    assert.equal(entries[1]!.seq, turnTwoSeq);
  },
);

test("Postgres real projector recovers an invisible skipped turn at a higher revision", { skip }, async () => {
  const stamp = Date.now();
  const owner = "U1";
  const conversationId = `conv-skip-revision-${stamp}`;
  const threadRef = `web:skip-revision:${stamp}`;
  const ownerScopeId = scopeId("group", `G-${stamp}`);
  const sessions = createPostgresSessionStore(URL!);
  const session = await sessions.getOrCreateByThread(threadRef, "group", ownerScopeId, undefined, "web");
  const links = createAgentConversationLinkStore();
  const deliveries = createDeliveryStore();
  let visible = false;
  const directory = {
    get: async () => null,
    channelMember: async () => visible,
    groupMember: async () => visible,
    listChannelsFor: async () => [],
  };
  const destination = { type: "web", target: threadRef, audienceScopeId: ownerScopeId } as const;
  await links.record({
    owner,
    createdBy: owner,
    ownerScopeId,
    conversationId,
    mailbox: audience.mailbox,
    peer: "bob.example.viz",
    openerThreadRef: threadRef,
    openerSessionId: session.id,
    surface: "web",
    destination,
  });
  const link = await links.get({ owner, mailbox: audience.mailbox, conversationId });
  assert.ok(link);
  const projector = createAgentConversationProjector({
    links,
    deliveries,
    projectionSessions: sessions,
    directory,
    toolDefs: () => [],
    owner,
    ownerScopeId,
    threadRef,
    sessionId: session.id,
    surface: "web",
    destination,
  });
  const event = (revision: number): ConversationProjectionEvent => ({
    event_id: `event-${conversationId}`,
    projection_revision: revision,
    source: "zipviz-signed-v3",
    authoritative: true,
    mailbox: audience.mailbox,
    conversation_id: conversationId,
    turn: 1,
    side: "us",
    from: audience.mailbox,
    to: "bob.example.viz",
    msg_id: `msg-${conversationId}`,
    body: revision === 1 ? "invisible" : "visible revision",
    body_trust: "own",
    ledger_status: "committed",
    signed: {
      envelope_v: 3,
      signature: "sig",
      timestamp: "2026-09-11T00:00:00Z",
      expires_at: "2026-09-12T00:00:00Z",
      reply_to: null,
      intent: "propose",
      state: "active",
      goal_ref: "goal",
      authority_claim: null,
      acting_for_claim: null,
      reply_by: null,
      wake: null,
      outcome_code: null,
      human_summary: null,
    },
    receipt: {
      present: revision > 1,
      status: revision > 1 ? "accepted" : null,
      received_at: null,
      signed_receipt: null,
    },
    timing: {},
    correlation: {
      adapter_kind: audience.adapterKind,
      adapter_instance: audience.adapterInstance,
      external_scope: audience.externalScope,
      external_conversation_ref: threadRef,
      external_event_id: null,
      disposition: null,
    },
  });

  assert.equal(await projector.projectEvent(event(1), link, link.createdAt), "undeliverable");
  const skipped = (await sessions.getEntries(session.id)).find(
    (entry) => (entry.payload as { kind?: string }).kind === "agent_conversation_projection_skip",
  );
  assert.ok(skipped);
  assert.equal((skipped.payload as { projectionRevision?: number }).projectionRevision, 1);
  visible = true;
  assert.equal(await projector.projectEvent(event(2), link, link.createdAt), "projected");
  const entries = await createPostgresSessionStore(URL!).getEntries(session.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.seq, skipped.seq);
  assert.equal((entries[0]!.payload as { kind?: string }).kind, "agent_conversation_projection");
  assert.equal((entries[0]!.payload as { projectionRevision?: number }).projectionRevision, 2);
  assert.match((entries[0]!.payload as { text?: string }).text ?? "", /visible revision/);
});
