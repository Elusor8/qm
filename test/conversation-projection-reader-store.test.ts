import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemoryProjectionReaderStore,
  projectionReaderAudienceKey,
} from "../src/conversations/conversation-projection-reader-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";

const audience = {
  mailbox: "alice.example.viz",
  adapterKind: "https://example.invalid/adapter",
  adapterInstance: "qm",
  externalScope: "thread",
  externalPrincipalRef: "alice",
};

function job(revision: number) {
  return {
    id: "event:destination",
    audienceKey: projectionReaderAudienceKey(audience),
    eventId: "event",
    projectionRevision: revision,
    destinationRevision: 1,
    payload: { revision },
    createdAt: revision,
    availableAt: 0,
    attempts: 0,
  };
}

test("reader checkpoint accepts outbox work and skip evidence as one versioned page", async () => {
  const store = createMemoryProjectionReaderStore();
  assert.equal(
    await store.acceptPage({
      audience,
      expectedVersion: 0,
      jobs: [job(1)],
      skips: [{ projectionRevision: 2, msgId: "missing", code: "E_RETAINED_EVENT_GAP" }],
      afterCursor: "cursor-2",
    }),
    true,
  );
  assert.deepEqual(await store.get(audience), {
    ...audience,
    afterCursor: "cursor-2",
    version: 1,
    updatedAt: (await store.get(audience)).updatedAt,
  });
  assert.equal((await store.pending(10, Date.now()))[0]!.projectionRevision, 1);
  assert.deepEqual(await store.skips(audience), [
    { projectionRevision: 2, msgId: "missing", code: "E_RETAINED_EVENT_GAP" },
  ]);
});

test("concurrent readers cannot regress a checkpoint and a later event revision replaces pending work", async () => {
  const store = createMemoryProjectionReaderStore();
  assert.equal(
    await store.acceptPage({ audience, expectedVersion: 0, jobs: [job(1)], skips: [], afterCursor: "cursor-1" }),
    true,
  );
  assert.equal(
    await store.acceptPage({ audience, expectedVersion: 0, jobs: [], skips: [], afterCursor: "stale" }),
    false,
  );
  assert.equal(
    await store.acceptPage({ audience, expectedVersion: 1, jobs: [job(3)], skips: [], afterCursor: "cursor-3" }),
    true,
  );
  assert.equal((await store.pending(10, Date.now()))[0]!.projectionRevision, 3);
  assert.equal((await store.get(audience)).afterCursor, "cursor-3");
});

test("reader recovery reset is audience scoped and leaves accepted outbox work available", async () => {
  const store = createMemoryProjectionReaderStore();
  await store.acceptPage({ audience, expectedVersion: 0, jobs: [job(1)], skips: [], afterCursor: "cursor-1" });
  assert.equal(await store.reset(audience, 1, "E_STALE_CURSOR", "retained history changed"), true);
  const checkpoint = await store.get(audience);
  assert.equal(checkpoint.afterCursor, null);
  assert.equal(checkpoint.recoveryCode, "E_STALE_CURSOR");
  assert.equal((await store.pending(10, Date.now())).length, 1);
  assert.equal((await store.get({ ...audience, externalPrincipalRef: "mallory" })).version, 0);
});

test("a later projection revision reuses the logical delivery and preserves its external message identity", async () => {
  const deliveries = createDeliveryStore();
  let wakeups = 0;
  deliveries.onEnqueue(() => {
    wakeups += 1;
  });
  const base = {
    destination: { type: "slack", target: "C1" } as const,
    idempotencyKey: "zvconv:event:event-1:destination:1",
    provenance: {
      trigger: "conversation",
      surface: "slack",
      fireKey: "event-1",
      sourceScopeId: "channel:C1",
      sourceThreadRef: "slack:C1:1",
      conversation: {
        conversationId: "conversation-1",
        mailbox: audience.mailbox,
        owner: "U1",
        ownerScopeId: "channel:C1",
        turn: 1,
        projectionRevision: 1,
      },
    } as const,
  };
  const first = await deliveries.enqueueProjection({ ...base, text: "committed", projectionRevision: 1 });
  await deliveries.ack(first.id, 1, undefined, { messageRef: "123.456", channelRef: "C1" });
  const revised = await deliveries.enqueueProjection({
    ...base,
    text: "committed with receipt",
    projectionRevision: 2,
    provenance: {
      ...base.provenance,
      conversation: { ...base.provenance.conversation, projectionRevision: 2 },
    },
  });
  assert.equal(revised.id, first.id);
  assert.equal(revised.deliveredAt, null);
  assert.equal(revised.destination.editRef, "123.456");
  assert.equal(revised.text, "committed with receipt");
  assert.equal(wakeups, 2);
});
