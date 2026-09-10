import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  createPostgresProjectionReaderStore,
  projectionReaderAudienceKey,
  retireLegacyConversationProjection,
} from "../src/conversations/conversation-projection-reader-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
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
    "DROP TABLE IF EXISTS agent_conversation_projection_event_index, agent_conversation_projection_skips, agent_conversation_projection_outbox, agent_conversation_projection_readers CASCADE",
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
      })),
      afterCursor: "cursor-111",
    }),
    true,
  );
  assert.equal((await store.get(audience)).afterCursor, "cursor-111");
  assert.equal((await store.pending(10, Date.now())).length, 1);
  assert.equal((await store.skips(audience)).length, 100);
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

test("Postgres web projection revisions survive restart in the same entry", { skip }, async () => {
  const threadRef = `web:projection-revision:${Date.now()}`;
  const marker = `zvconv:revision:${Date.now()}`;
  const first = createPostgresSessionStore(URL!);
  const session = await first.getOrCreateByThread(threadRef, "dm", scopeId("personal", "U1"), undefined, "web");
  const firstLease = (await first.acquireLease(session.id, "backfill")).lease!;
  await first.upsertProjection!(firstLease, marker, 1, {
    type: "user",
    payload: { ts: marker, overheard: true, projectionRevision: 1, text: "committed" },
    scopeLabel: session.scopeId,
  });
  await first.releaseLease(firstLease);
  const restarted = createPostgresSessionStore(URL!);
  const secondLease = (await restarted.acquireLease(session.id, "backfill")).lease!;
  await restarted.upsertProjection!(secondLease, marker, 2, {
    type: "user",
    payload: { ts: marker, overheard: true, projectionRevision: 2, text: "receipt delivered" },
    scopeLabel: session.scopeId,
  });
  await restarted.upsertProjection!(secondLease, marker, 1, {
    type: "user",
    payload: { ts: marker, overheard: true, projectionRevision: 1, text: "stale" },
    scopeLabel: session.scopeId,
  });
  await restarted.releaseLease(secondLease);
  const entries = await restarted.getEntries(session.id);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.payload, {
    ts: marker,
    overheard: true,
    projectionRevision: 2,
    text: "receipt delivered",
  });
});
