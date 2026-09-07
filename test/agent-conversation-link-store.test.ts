import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentConversationLinkStore } from "../src/conversations/agent-conversation-link-store.ts";
import { scopeId } from "../src/types.ts";

const CONVERSATION = "conv-0001";

function input(overrides: Record<string, unknown> = {}) {
  return {
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    conversationId: CONVERSATION,
    mailbox: "alice.example.viz",
    peer: "bob.external.viz",
    openerThreadRef: "ch:C1:1700000000.1",
    openerSessionId: "sess-1",
    surface: "slack",
    destination: { type: "slack", target: "C1:1700000000.1", audienceScopeId: scopeId("channel", "C1") },
    ...overrides,
  };
}

test("records the destination verbatim, keyed on the conversation id", async () => {
  const store = createAgentConversationLinkStore();
  const link = await store.record(input());

  assert.equal(link.conversationId, CONVERSATION);
  assert.equal(link.id, CONVERSATION, "the conversation id is the key, not a generated one");
  // Recorded, never reconstructed: a Session cannot yield a posting target.
  assert.deepEqual(link.destination, {
    type: "slack",
    target: "C1:1700000000.1",
    audienceScopeId: scopeId("channel", "C1"),
  });
  assert.deepEqual(await store.get(CONVERSATION), link);
});

// The observation that opens a conversation can be replayed. A replay must not
// mint a second binding or overwrite the destination already recorded.
test("is idempotent on the conversation id", async () => {
  const store = createAgentConversationLinkStore();
  const first = await store.record(input());
  const second = await store.record(input({ destination: { type: "slack", target: "C-OTHER" }, openerSessionId: "sess-2" }));

  assert.deepEqual(second, first);
  assert.equal((await store.list()).length, 1);
});

// The whole point of keying on the conversation id: an attested runtime does
// not send a thread ref at all, and the link must still be findable.
test("is findable when the opener's thread ref is absent, as under attestation", async () => {
  const store = createAgentConversationLinkStore();
  await store.record(input({ externalThreadRef: undefined }));

  const link = await store.get(CONVERSATION);
  assert.equal(link?.externalThreadRef, undefined);
  assert.equal(link?.conversationId, CONVERSATION);
});

test("advances each side's projected turn independently", async () => {
  const store = createAgentConversationLinkStore();
  await store.record(input());

  await store.advance(CONVERSATION, { lastProjectedInTurn: 2 });
  assert.equal((await store.get(CONVERSATION))?.lastProjectedInTurn, 2);
  assert.equal((await store.get(CONVERSATION))?.lastProjectedOutTurn, undefined);

  await store.advance(CONVERSATION, { lastProjectedOutTurn: 3 });
  assert.equal((await store.get(CONVERSATION))?.lastProjectedInTurn, 2, "in-turn must survive an out-turn advance");
  assert.equal((await store.get(CONVERSATION))?.lastProjectedOutTurn, 3);
});

// A refused projection tells the owner once. A twelve-turn negotiation into a
// channel they have left must not send twelve notices.
test("stamps the owner notice once and never again", async () => {
  const store = createAgentConversationLinkStore();
  await store.record(input());

  await store.noteSkip(CONVERSATION, "not visible", { notifiedOwner: true });
  const first = (await store.get(CONVERSATION))?.ownerNotifiedAt;
  assert.ok(typeof first === "number");

  await store.noteSkip(CONVERSATION, "still not visible", { notifiedOwner: true });
  assert.equal((await store.get(CONVERSATION))?.ownerNotifiedAt, first);
  assert.equal((await store.get(CONVERSATION))?.lastSkipNote, "still not visible");
});

test("advance and noteSkip are no-ops for an unknown conversation", async () => {
  const store = createAgentConversationLinkStore();
  await store.advance("conv-missing", { lastProjectedInTurn: 1 });
  await store.noteSkip("conv-missing", "gone");
  assert.equal((await store.list()).length, 0);
});

// assertNoEscalation is the trigger-store guard: a link must not claim a scope
// wider than the person creating it holds.
test("refuses a link whose scope exceeds the creator's", async () => {
  const store = createAgentConversationLinkStore();
  await assert.rejects(
    () => store.record(input({ owner: "U2", createdBy: "U1", ownerScopeId: scopeId("personal", "U2") })),
    /escalat|owner|scope/i,
  );
});
