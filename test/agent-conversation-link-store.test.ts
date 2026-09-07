import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentConversationLinkId,
  createAgentConversationLinkStore,
} from "../src/conversations/agent-conversation-link-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type AgentConversationLink } from "../src/types.ts";

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

test("records the destination verbatim, keyed on conversation, mailbox and principal", async () => {
  const store = createAgentConversationLinkStore();
  const link = await store.record(input());

  assert.equal(link.conversationId, CONVERSATION);
  assert.equal(link.id, agentConversationLinkId(input()), "the key includes the mailbox and principal side");
  assert.deepEqual(link.destination, {
    type: "slack",
    target: "C1:1700000000.1",
    audienceScopeId: scopeId("channel", "C1"),
  });
  assert.deepEqual(await store.get(input()), link);
});

test("side-qualified records and progress remain independent", async () => {
  const store = createAgentConversationLinkStore();
  const sides = [input(), input({ mailbox: "bob.external.viz" }), input({ owner: "U2", createdBy: "U2" })];
  const links = await Promise.all(
    sides.map((side, index) => store.record({ ...side, openerSessionId: `session-${index}` })),
  );
  assert.equal(new Set(links.map((link) => link.id)).size, 3);
  await store.advance(sides[0]!, { lastProjectedInTurn: 2 });
  await store.noteSkip(sides[1]!, "unavailable", { notifiedOwner: true });
  assert.equal((await store.get(sides[0]!))?.ownerNotifiedAt, undefined);
  assert.equal((await store.get(sides[1]!))?.lastProjectedInTurn, undefined);
  assert.deepEqual(await store.get(sides[2]!), links[2]);
});

test("an unqualified legacy record is never used as a side's destination", async () => {
  const backing = createMemoryMap<AgentConversationLink>();
  const store = createAgentConversationLinkStore(backing);
  await backing.put(CONVERSATION, { ...input(), id: CONVERSATION, createdAt: 1, enabled: true });
  assert.equal(await store.get(input()), null);
  const current = await store.record(input({ openerSessionId: "fresh" }));
  assert.equal(current.openerSessionId, "fresh");
  assert.notEqual(current.id, CONVERSATION);
});

test("is idempotent on the conversation id", async () => {
  const store = createAgentConversationLinkStore();
  const first = await store.record(input());
  const second = await store.record(
    input({ destination: { type: "slack", target: "C-OTHER" }, openerSessionId: "sess-2" }),
  );

  assert.deepEqual(second, first);
  assert.equal((await store.list()).length, 1);
});

test("is findable when the opener's thread ref is absent, as under attestation", async () => {
  const store = createAgentConversationLinkStore();
  await store.record(input({ externalThreadRef: undefined }));

  const link = await store.get(input());
  assert.equal(link?.externalThreadRef, undefined);
  assert.equal(link?.conversationId, CONVERSATION);
});

test("advances each side's projected turn independently", async () => {
  const store = createAgentConversationLinkStore();
  await store.record(input());

  await store.advance(input(), { lastProjectedInTurn: 2 });
  assert.equal((await store.get(input()))?.lastProjectedInTurn, 2);
  assert.equal((await store.get(input()))?.lastProjectedOutTurn, undefined);

  await store.advance(input(), { lastProjectedOutTurn: 3 });
  assert.equal((await store.get(input()))?.lastProjectedInTurn, 2, "in-turn must survive an out-turn advance");
  assert.equal((await store.get(input()))?.lastProjectedOutTurn, 3);
});

test("stamps the owner notice once and never again", async () => {
  const store = createAgentConversationLinkStore();
  await store.record(input());

  await store.noteSkip(input(), "not visible", { notifiedOwner: true });
  const first = (await store.get(input()))?.ownerNotifiedAt;
  assert.ok(typeof first === "number");

  await store.noteSkip(input(), "still not visible", { notifiedOwner: true });
  assert.equal((await store.get(input()))?.ownerNotifiedAt, first);
  assert.equal((await store.get(input()))?.lastSkipNote, "still not visible");
});

test("concurrent registrations retain the first opener and destination", async () => {
  const backing = createMemoryMap<AgentConversationLink>();
  const first = createAgentConversationLinkStore(backing);
  const second = createAgentConversationLinkStore(backing);
  const [original, replay] = await Promise.all([
    first.record(input()),
    second.record(input({ openerSessionId: "sess-2", destination: { type: "slack", target: "C-OTHER" } })),
  ]);

  assert.deepEqual(replay, original);
  assert.deepEqual(await first.get(input()), original);
  assert.equal(original.openerSessionId, "sess-1");
  assert.deepEqual(original.destination, input().destination);
});

test("concurrent inbound and outbound advances preserve both fields", async () => {
  const backing = createMemoryMap<AgentConversationLink>();
  const first = createAgentConversationLinkStore(backing);
  const second = createAgentConversationLinkStore(backing);
  const original = await first.record(input());

  await Promise.all([
    first.advance(input(), { lastProjectedInTurn: 2 }),
    second.advance(input(), { lastProjectedOutTurn: 3 }),
  ]);

  assert.deepEqual(await first.get(input()), {
    ...original,
    lastProjectedInTurn: 2,
    lastProjectedOutTurn: 3,
  });
});

for (const notifiedOwner of [false, true]) {
  test(`concurrent progress and skip preserve both mutations (notifiedOwner=${notifiedOwner})`, async () => {
    const backing = createMemoryMap<AgentConversationLink>();
    const first = createAgentConversationLinkStore(backing);
    const second = createAgentConversationLinkStore(backing);
    const original = await first.record(input());

    await Promise.all([
      first.advance(input(), { lastProjectedInTurn: 2 }),
      second.noteSkip(input(), "not visible", { notifiedOwner }),
    ]);

    const link = await first.get(input());
    assert.equal(typeof link?.ownerNotifiedAt, notifiedOwner ? "number" : "undefined");
    assert.deepEqual(link, {
      ...original,
      lastProjectedInTurn: 2,
      lastSkipNote: "not visible",
      ...(notifiedOwner ? { ownerNotifiedAt: link?.ownerNotifiedAt } : {}),
    });
  });
}

test("concurrent owner notices retain the first timestamp", async (t) => {
  const backing = createMemoryMap<AgentConversationLink>();
  const first = createAgentConversationLinkStore(backing);
  const second = createAgentConversationLinkStore(backing);
  await first.record(input());
  let now = 100;
  t.mock.method(Date, "now", () => ++now);

  await Promise.all([
    first.noteSkip(input(), "not visible", { notifiedOwner: true }),
    second.noteSkip(input(), "still not visible", { notifiedOwner: true }),
  ]);

  const link = await first.get(input());
  assert.equal(link?.ownerNotifiedAt, 101);
  assert.equal(link?.lastSkipNote, "still not visible");
});

test("advance and noteSkip are no-ops for an unknown conversation", async () => {
  const store = createAgentConversationLinkStore();
  await store.advance(input({ conversationId: "conv-missing" }), { lastProjectedInTurn: 1 });
  await store.noteSkip(input({ conversationId: "conv-missing" }), "gone");
  await store.noteSkip(input({ conversationId: "conv-missing" }), "gone", { notifiedOwner: true });
  assert.equal((await store.list()).length, 0);
});

test("refuses a link whose scope exceeds the creator's", async () => {
  const store = createAgentConversationLinkStore();
  await assert.rejects(
    () => store.record(input({ owner: "U2", createdBy: "U1", ownerScopeId: scopeId("personal", "U2") })),
    /escalat|owner|scope/i,
  );
});
