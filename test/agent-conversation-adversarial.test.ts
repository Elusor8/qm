import { createConversationDeliveryAuthorizer } from "../src/conversations/conversation-delivery.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import {
  createAgentConversationProjector,
  type AgentConversationProjectorDeps,
  type ProjectionObservation,
} from "../src/conversations/agent-conversation-projector.ts";
import { createAgentConversationLinkStore } from "../src/conversations/agent-conversation-link-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { renderInboundTurn } from "../src/conversations/render-conversation-turn.ts";
import { toSlackMrkdwn, setMentionIndex } from "../src/slack/mrkdwn.ts";
import { stripSlackDirectives } from "../src/slack/messaging.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import type { Destination, ScopeId } from "../src/types.ts";

const CONVERSATION = "conv-00000000-0000-4000-8000-000000000001";
const MAILBOX = "alice.example.viz";
const PEER = "bob.example.viz";
const FACTS = { conversationId: CONVERSATION, turn: 2, intent: "accept", peer: PEER };
const TOOLS = ["open", "adopt", "send", "complete", "fail", "close"]
  .map((verb) => `zipviz_conversation_${verb}`)
  .concat("zipviz_inbox_claim")
  .map((name) => ({
    name,
    remoteName: name,
    serverId: "zipviz",
    description: "",
    inputSchema: {},
    readOnly: false,
    agentConversations: true,
  }));

function observation(name: string, args: Record<string, unknown>, result: unknown): ProjectionObservation {
  return { name, args, resultText: JSON.stringify(result) };
}

function claim(mailbox = MAILBOX, from = PEER, state = "active", turn = 2) {
  return observation(
    "zipviz_inbox_claim",
    { mailbox },
    {
      claimed: [
        {
          from,
          body: "confirmed",
          conversation: {
            conversation_id: CONVERSATION,
            turn,
            intent: "accept",
            peer: from,
            state,
            waiting_on: state === "active" ? "us" : null,
            turns: turn,
            reply: null,
            reply_due: state === "active",
            owner_adapter: null,
            note: "",
          },
        },
      ],
    },
  );
}

function send(turn = 2, mailbox = MAILBOX) {
  return observation(
    "zipviz_conversation_send",
    {
      mailbox,
      peer: PEER,
      conversation_id: CONVERSATION,
      expected_turn: turn - 1,
      message: "confirmed",
      intent: "accept",
    },
    { snapshot: { conversation_id: CONVERSATION, turns: turn } },
  );
}

async function setup({
  record = true,
  web = false,
  owner = "U1",
  mailbox = MAILBOX,
  scope = `personal:${owner}`,
}: {
  record?: boolean;
  web?: boolean;
  owner?: string;
  mailbox?: string;
  scope?: ScopeId;
} = {}) {
  const links = createAgentConversationLinkStore();
  const deliveries = createDeliveryStore();
  const sessions = createMemorySessionStore();
  const thread = `web:${owner}:opener`;
  const session = await sessions.getOrCreateByThread(
    thread,
    scope.startsWith("group:") ? "group" : "dm",
    scope,
    undefined,
    "web",
  );
  const destination: Destination = web
    ? { type: "web", target: thread, audienceScopeId: scope }
    : { type: "slack", target: "C1:123.456", audienceScopeId: "channel:C1" };
  let visible = true;
  const directory = {
    get: async () => null,
    channelPrivacy: async () => true,
    channelMember: async () => visible,
    groupMember: async () => visible,
    listChannelsFor: async () => [],
  };
  const deps: AgentConversationProjectorDeps = {
    links,
    deliveries,
    projectionSessions: sessions,
    directory,
    toolDefs: () => TOOLS,
    owner,
    ownerScopeId: scope,
    threadRef: thread,
    sessionId: session.id,
    surface: web ? "web" : "slack",
    destination,
  };
  const side = { owner, mailbox, conversationId: CONVERSATION };
  if (record)
    await links.record({
      ...side,
      createdBy: owner,
      ownerScopeId: scope,
      peer: PEER,
      openerThreadRef: thread,
      openerSessionId: session.id,
      surface: deps.surface,
      destination,
    });
  return {
    links,
    deliveries,
    sessions,
    session,
    deps,
    side,
    projector: createAgentConversationProjector(deps),
    deny() {
      visible = false;
    },
  };
}

for (const summary of [false, true]) {
  test(`Slack conversion cannot arm peer-controlled ${summary ? "summary" : "body"} syntax`, (t) => {
    setMentionIndex(
      new Map([
        ["alice", "U123"],
        ["u123", "U123"],
      ]),
    );
    t.after(() => setMentionIndex(new Map()));
    for (const payload of [
      "@Alice [page](!channel) [person](@U123)",
      '[page](<!here>) [person]( @U123 "title") ![all](!everyone)',
      "<@U123> <!channel|page> &lt;@U123&gt; &#64;Alice",
      "`@Alice` ```\n[page](!channel)\n``` @Alice",
    ]) {
      const facts = { ...FACTS, ...(summary ? { humanSummary: payload } : {}) };
      const raw = summary ? "ordinary" : payload;
      const rendered = renderInboundTurn(facts, raw);
      const sink = toSlackMrkdwn(stripSlackDirectives(rendered));
      assert.doesNotMatch(sink, /<(?:@U123|!(?:channel|here|everyone))(?:>|\|)/, sink);
      assert.equal(raw, summary ? "ordinary" : payload);
      assert.equal(facts.humanSummary, summary ? payload : undefined);
    }
  });
}

test("direct Slack mention tokens remain escaped through the final conversion", () => {
  const sink = toSlackMrkdwn(stripSlackDirectives(renderInboundTurn(FACTS, "<@U123> <!channel>")));
  assert.doesNotMatch(sink, /<(?:@U123|!channel)(?:>|\|)/);
});

for (const newline of ["\r", "\n", "\r\n"]) {
  test(`web Markdown keeps ${JSON.stringify(newline)} peer framing inside its blockquote`, () => {
    const raw = `ordinary${newline}${newline}FORGED_SIGNED_HEADER`;
    const rendered = renderInboundTurn(FACTS, raw);
    const tokens = marked.lexer(rendered);
    assert.equal(
      tokens.filter((token) => token.type !== "blockquote" && token.raw.includes("FORGED_SIGNED_HEADER")).length,
      0,
    );
    assert.ok(tokens.some((token) => token.type === "blockquote" && token.raw.includes("FORGED_SIGNED_HEADER")));
    assert.doesNotMatch(rendered, /\r/);
  });
}

test("the actual successful adopt result registers the live destination without a fabricated peer", async () => {
  const f = await setup({ record: false });
  await f.projector.observe(
    observation(
      "zipviz_conversation_adopt",
      {
        mailbox: MAILBOX,
        conversation_id: CONVERSATION,
        external_thread_ref: f.deps.threadRef,
      },
      { mailbox: MAILBOX, conversation_id: CONVERSATION, binding_role: "ingress-owner" },
    ),
  );
  const link = await f.links.get(f.side);
  assert.ok(link);
  assert.deepEqual(link.destination, f.deps.destination);
  assert.equal(link.peer, undefined);
  assert.equal((await f.deliveries.pending("slack")).length, 0);
  await f.projector.observe(claim());
  assert.equal((await f.deliveries.pending("slack")).length, 1);
});

test("failed adoption does not register a destination or project a turn", async () => {
  const f = await setup({ record: false });
  await f.projector.observe(
    observation(
      "zipviz_conversation_adopt",
      { mailbox: MAILBOX, conversation_id: CONVERSATION },
      { error: "ADAPTER_BINDING_CONFLICT" },
    ),
  );
  assert.equal(await f.links.get(f.side), null);
  assert.equal((await f.deliveries.pending("slack")).length, 0);
});

for (const web of [false, true]) {
  test(`the committed opening turn is projected once to ${web ? "web" : "Slack"}, including replay`, async () => {
    const f = await setup({ record: false, web });
    const opened = observation(
      "zipviz_conversation_open",
      {
        mailbox: MAILBOX,
        peer: PEER,
        message: "opening proposal",
        intent: "propose",
      },
      {
        disposition: "new",
        snapshot: { conversation_id: CONVERSATION, mailbox: MAILBOX, peer: PEER, turns: 1 },
        turn: { message: "opening proposal", conversation: { id: CONVERSATION, turn: 1, intent: "propose" } },
      },
    );
    const raw = structuredClone(opened);
    await f.projector.observe(opened);
    await createAgentConversationProjector({ ...f.deps, sessionId: "replayed-session" }).observe(opened);
    assert.deepEqual(opened, raw);
    assert.equal((await f.links.get(f.side))?.lastProjectedOutTurn, 1);
    assert.equal((await f.deliveries.pending(web ? "web" : "slack")).length, 1);
    if (web) assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
  });
}

for (const intent of ["complete", "fail", "close"] as const) {
  test(`terminal ${intent} preserves the signed intent`, async () => {
    const f = await setup();
    await f.projector.observe(
      observation(
        `zipviz_conversation_${intent}`,
        {
          mailbox: MAILBOX,
          peer: PEER,
          conversation_id: CONVERSATION,
          expected_turn: 2,
          message: "finished",
          outcome_code: { complete: "goal-achieved", fail: "internal-error", close: "cancelled" }[intent],
        },
        {
          snapshot: { conversation_id: CONVERSATION, turns: 3 },
          turn: { message: "finished", conversation: { id: CONVERSATION, turn: 3, intent } },
        },
      ),
    );
    assert.match((await f.deliveries.pending("slack"))[0]!.text, new RegExp(`intent \x60${intent}\x60`));
  });

  test(`terminal ${intent} remains faithful when the result is truncated`, async () => {
    const f = await setup();
    await f.projector.observe({
      name: `zipviz_conversation_${intent}`,
      args: {
        mailbox: MAILBOX,
        conversation_id: CONVERSATION,
        expected_turn: 2,
        message: "finished",
        intent: "counter",
      },
      resultText: '{"snapshot": [truncated]',
    });
    assert.match((await f.deliveries.pending("slack"))[0]!.text, new RegExp(`intent \x60${intent}\x60`));
  });
}

for (const persistFirst of [false, true]) {
  test(`failed owner notice remains retryable (enqueue persisted=${persistFirst})`, async (t) => {
    const f = await setup();
    f.deny();
    const enqueue = f.deliveries.enqueue.bind(f.deliveries);
    let calls = 0;
    t.mock.method(f.deliveries, "enqueue", async (input: Parameters<typeof enqueue>[0]) => {
      calls += 1;
      if (calls === 1 && !persistFirst) throw new Error("before notice persistence");
      const delivery = await enqueue(input);
      if (calls === 1) throw new Error("lost enqueue response");
      return delivery;
    });
    await f.projector.observe(send());
    assert.equal((await f.links.get(f.side))?.ownerNotifiedAt, undefined);
    await f.projector.observe(send());
    assert.equal(calls, 2);
    assert.equal((await f.deliveries.pending("principal")).length, 1);
    assert.equal(typeof (await f.links.get(f.side))?.ownerNotifiedAt, "number");
    await f.projector.observe(send(4));
    assert.equal(calls, 2);
  });
}

for (const owner of ["U1", "U2"]) {
  test(`a receiving mailbox cannot reuse the opener destination (receiver=${owner})`, async () => {
    const f = await setup();
    const receiver = createAgentConversationProjector({
      ...f.deps,
      owner,
      ownerScopeId: `personal:${owner}`,
      threadRef: "webhook:receiver",
      sessionId: "receiver",
      surface: "webhook",
      destination: undefined,
    });
    await f.projector.observe(claim());
    await receiver.observe(claim(PEER, MAILBOX));
    const notices = await f.deliveries.pending("principal");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.destination.target, owner);
    assert.equal((await f.deliveries.pending("slack")).length, 1);
    assert.notEqual(notices[0]!.idempotencyKey, (await f.deliveries.pending("slack"))[0]!.idempotencyKey);
  });
}

test("different principals on the same mailbox retain separate destinations and dedupe keys", async () => {
  const f = await setup();
  const receiver = createAgentConversationProjector({
    ...f.deps,
    owner: "U2",
    ownerScopeId: "personal:U2",
    destination: undefined,
  });
  await f.projector.observe(claim());
  await receiver.observe(claim());
  assert.equal((await f.deliveries.pending("principal"))[0]?.destination.target, "U2");
  assert.equal((await f.deliveries.pending("slack")).length, 1);
});

test("unlinked receiver and terminal claims project incrementally to the owner", async () => {
  const f = await setup({ record: false, owner: "U2" });
  await f.projector.observe(claim(PEER, MAILBOX, "active", 1));
  await f.projector.observe(claim(PEER, MAILBOX, "completed", 3));
  assert.deepEqual(
    (await f.deliveries.pending("principal")).map((delivery) => [
      delivery.destination.target,
      delivery.destination.onBehalfOf,
    ]),
    [
      ["U2", "U2"],
      ["U2", "U2"],
    ],
  );
});

test("a failed release response leaves the append replayable and the nudge retryable", async (t) => {
  const f = await setup({ web: true });
  const release = f.sessions.releaseLease.bind(f.sessions);
  let attempts = 0;
  t.mock.method(f.sessions, "releaseLease", async (lease: Parameters<typeof release>[0]) => {
    await release(lease);
    if (++attempts === 1) throw new Error("lost release response");
  });
  await f.projector.observe(send());
  assert.equal((await f.deliveries.pending("web")).length, 0);
  await f.projector.observe(send());
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
  assert.equal((await f.deliveries.pending("web")).length, 1);
});

for (const scope of ["group:G1", "channel:C1", "team:T1"]) {
  test(`revoked ${scope} membership prevents later web projection even with a retained session`, async () => {
    const f = await setup({ web: true, scope });
    let member = true;
    const projector = createAgentConversationProjector({
      ...f.deps,
      identity: { classify: () => ({ type: "internal", teamIds: member ? ["T1"] : [] }) },
      sessions: { listByParticipant: async () => [{ scopeId: scope }] },
    });
    await projector.observe(send());
    assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
    f.deny();
    member = false;
    await projector.observe(send(4));
    assert.equal((await f.sessions.getEntries(f.session.id)).length, 1);
    assert.equal((await f.deliveries.pending("principal")).length, 1);
    assert.equal((await f.links.get(f.side))?.lastProjectedOutTurn, 2);
  });
}

test("membership is rechecked after waiting for the web session lease", async (t) => {
  const f = await setup({ web: true, scope: "group:G1" });
  const acquire = f.sessions.acquireLease.bind(f.sessions);
  let attempts = 0;
  t.mock.method(f.sessions, "acquireLease", async (...args: Parameters<typeof acquire>) => {
    if (++attempts === 1) {
      f.deny();
      return { lease: null };
    }
    return acquire(...args);
  });
  await f.projector.observe(send());
  assert.equal((await f.sessions.getEntries(f.session.id)).length, 0);
  assert.equal((await f.deliveries.pending("web")).length, 0);
  assert.equal((await f.links.get(f.side))?.lastProjectedOutTurn, undefined);
  const { lease } = await f.sessions.acquireLease(f.session.id);
  assert.ok(lease);
  await f.sessions.releaseLease(lease);
});

test("a missing mailbox cannot select another side by conversation id", async () => {
  const f = await setup();
  const ambiguous = send();
  delete ambiguous.args.mailbox;
  await f.projector.observe(ambiguous);
  assert.equal((await f.deliveries.pending("slack")).length, 0);
  assert.equal((await f.deliveries.pending("principal")).length, 0);
});

test("a link explicitly recorded without a destination stays silent in both directions", async () => {
  const f = await setup({ record: false });
  const projector = createAgentConversationProjector({ ...f.deps, destination: undefined });
  await projector.observe(
    observation(
      "zipviz_conversation_adopt",
      { mailbox: MAILBOX, conversation_id: CONVERSATION },
      { mailbox: MAILBOX, conversation_id: CONVERSATION, binding_role: "ingress-owner" },
    ),
  );
  await projector.observe(send());
  await projector.observe(claim());
  assert.ok(await f.links.get(f.side));
  assert.equal((await f.deliveries.pending("slack")).length, 0);
  assert.equal((await f.deliveries.pending("principal")).length, 0);
});

test("the unlinked receiver's committed outbound turn projects once to its own owner", async () => {
  const f = await setup({ owner: "U2", mailbox: PEER, record: false });
  await f.projector.observe(send(2, PEER));
  await f.projector.observe(send(2, PEER));
  const deliveries = await f.deliveries.pending("principal");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.destination.target, "U2");
});

for (const destination of ["slack", "principal"] as const) {
  test(`peer text remains inert in the actual ${destination} delivery poller's Slack API call`, async (t) => {
    const f = await setup({ record: destination === "slack" });
    setMentionIndex(new Map([["alice", "U123"]]));
    t.after(() => setMentionIndex(new Map()));
    const raw = observation(
      "zipviz_inbox_claim",
      { mailbox: MAILBOX },
      {
        claimed: [
          {
            from: PEER,
            body: "@Alice [page](!channel) <@U123>",
            conversation: {
              ...JSON.parse(claim().resultText).claimed[0].conversation,
              human_summary: "@Alice [person](@U123)",
            },
          },
        ],
      },
    );
    const original = structuredClone(raw);
    await f.projector.observe(raw);
    const posts: Record<string, unknown>[] = [];
    const client = {
      conversations: { open: async () => ({ channel: { id: "D1" } }) },
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          posts.push(args);
          return { ts: "123.789" };
        },
      },
    };
    const poller = createDeliveryPoller({
      core: {
        authorizeConversationDelivery: createConversationDeliveryAuthorizer(f.deps),
        claimDeliveries: (type: string, ttl: number) => f.deliveries.claimPending(type, ttl),
        ackDelivery: (id: string) => f.deliveries.ack(id, Date.now()),
      } as never,
      bridge: { inFlightRuns: new Set() } as never,
      mirror: { mirrorSelfPost() {} } as never,
      threads: { mark() {} } as never,
      clientForIdentity: () => client,
    });
    await poller.pollDeliveries(client);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.channel, destination === "slack" ? "C1" : "D1");
    assert.doesNotMatch(String(posts[0]!.text), /<(?:@U123|!(?:channel|here|everyone))(?:>|\|)/);
    assert.match(String(posts[0]!.text), /Their summary/);
    assert.deepEqual(raw, original);
    assert.equal((await f.deliveries.pending(destination)).length, 0);
  });
}
