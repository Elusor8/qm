import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  createPostgresProjectionReaderStore,
  projectionReaderAudienceKey,
} from "../src/conversations/conversation-projection-reader-store.ts";

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
    "DROP TABLE IF EXISTS agent_conversation_projection_skips, agent_conversation_projection_outbox, agent_conversation_projection_readers CASCADE",
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
  const store = createPostgresProjectionReaderStore(URL!);
  const checkpoint = await store.get(audience);
  assert.equal(
    await store.acceptPage({
      audience,
      expectedVersion: checkpoint.version,
      jobs: [],
      skips: [],
      afterCursor: "cursor-current",
    }),
    true,
  );
  assert.equal(
    await store.acceptPage({
      audience,
      expectedVersion: checkpoint.version,
      jobs: [],
      skips: [],
      afterCursor: "cursor-stale",
    }),
    false,
  );
  assert.equal((await store.get(audience)).afterCursor, "cursor-current");
});
