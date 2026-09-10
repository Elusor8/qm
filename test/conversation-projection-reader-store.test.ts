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
    state: "ready" as const,
    subscriptionKey: "subscription-1",
    msgId: "msg-1",
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
  assert.equal(checkpoint.afterCursor, "cursor-1");
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

test("a correlated gap holds only its subscription while reader work for another subscription remains available", async () => {
  const store = createMemoryProjectionReaderStore();
  await store.acceptPage({ audience, expectedVersion: 0, jobs: [job(1)], skips: [], afterCursor: "cursor-1" });
  await store.ack(job(1).id, 1);
  const subscriptionKey = await store.subscriptionForMsg(audience, "msg-1");
  assert.equal(subscriptionKey, "subscription-1");
  const other = { ...job(2), id: "event-2", eventId: "event-2", msgId: "msg-2", subscriptionKey: "subscription-2" };
  await store.acceptPage({
    audience,
    expectedVersion: 1,
    jobs: [other],
    skips: [{ projectionRevision: 3, msgId: "msg-1", code: "E_RETAINED_EVENT_GAP", subscriptionKey: subscriptionKey! }],
    afterCursor: "cursor-3",
  });
  assert.equal(await store.held(projectionReaderAudienceKey(audience), "subscription-1"), true);
  assert.equal(await store.held(projectionReaderAudienceKey(audience), "subscription-2"), false);
  assert.deepEqual(
    (await store.pending(10, Date.now())).map((row) => row.id),
    ["event-2"],
  );
});

test("expired unbound work loses its body without acknowledgement or silent hold release", async () => {
  const store = createMemoryProjectionReaderStore();
  const unbound = {
    ...job(1),
    state: "awaiting_binding" as const,
    payload: { body: "sensitive processing copy" },
    createdAt: 1,
  };
  await store.acceptPage({ audience, expectedVersion: 0, jobs: [unbound], skips: [], afterCursor: "cursor-1" });
  assert.deepEqual(await store.prune(2), { expiredOutbox: 1, deletedSkips: 0 });
  assert.equal((await store.pending(10, Date.now())).length, 0);
  const evidence = (await store.allOutbox(10))[0]!;
  assert.equal(evidence.state, "expired");
  assert.deepEqual(evidence.payload, { expired: true, eventId: "event", projectionRevision: 1 });
});

test("rejected delivery processing copies retain provenance but expire message content", async () => {
  const deliveries = createDeliveryStore();
  const rejected = await deliveries.enqueue({
    destination: { type: "slack", target: "C1" },
    text: JSON.stringify({ failure: "invalid_blocks", body: "sensitive body" }),
    idempotencyKey: "delivery-failure:projection-1",
    shadow: true,
    provenance: {
      trigger: "conversation",
      surface: "slack",
      fireKey: "event-1",
      sourceScopeId: "channel:C1",
      sourceThreadRef: "slack:C1:1",
    },
  });
  assert.equal(await deliveries.pruneRejectedConversationCopies(rejected.createdAt + 1), 1);
  const retained = await deliveries.get(rejected.id);
  assert.equal(retained?.deliveredAt, null);
  assert.equal(retained?.provenance?.fireKey, "event-1");
  assert.equal(retained?.text, '{"expired":true,"kind":"conversation-delivery-rejection"}');
  for (let index = 0; index < 100; index += 1)
    await deliveries.enqueue({
      destination: { type: "slack", target: "C1" },
      text: `rejected ${index}`,
      idempotencyKey: `delivery-failure:projection-${index + 2}`,
      shadow: true,
    });
  await deliveries.pruneRejectedConversationCopies(Date.now() + 1);
  assert.equal((await deliveries.listShadow({ limit: 200 })).length, 100);
});
