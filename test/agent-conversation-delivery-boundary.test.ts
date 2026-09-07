import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentConversationLinkStore } from "../src/conversations/agent-conversation-link-store.ts";
import { createAgentConversationProjector } from "../src/conversations/agent-conversation-projector.ts";
import { createConversationDeliveryAuthorizer } from "../src/conversations/conversation-delivery.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";

async function fixture(kind: "slack" | "principal" | "notice") {
  const deliveries = createDeliveryStore();
  const links = createAgentConversationLinkStore();
  const side = { owner: "U1", mailbox: "alice.example.viz", conversationId: "conv-0001" };
  let member = kind !== "notice";
  const directory = { get: async () => null, channelMember: async () => member, groupMember: async () => member };
  const destination =
    kind === "principal"
      ? { type: "principal", target: "U1", audienceScopeId: "personal:U1" }
      : { type: "slack", target: "C1:123.456", audienceScopeId: "channel:C1" };
  await links.record({
    ...side,
    createdBy: "U1",
    ownerScopeId: kind === "principal" ? "personal:U1" : "channel:C1",
    openerThreadRef: "opener",
    openerSessionId: "opener",
    surface: "slack",
    destination,
  });
  const projector = createAgentConversationProjector({
    links,
    deliveries,
    directory,
    owner: "U1",
    ownerScopeId: "personal:U1",
    threadRef: "wake",
    sessionId: "wake",
    surface: "webhook",
    toolDefs: () => [
      {
        name: "claim",
        remoteName: "zipviz_inbox_claim",
        agentConversations: true,
        serverId: "zipviz",
        description: "",
        inputSchema: {},
        readOnly: false,
      },
    ],
  });
  await projector.observe({
    name: "claim",
    args: { mailbox: side.mailbox },
    resultText: JSON.stringify({
      claimed: [
        {
          from: "bob.example.viz",
          body: "BOUNDARY_SECRET",
          conversation: { conversation_id: side.conversationId, turn: 2, intent: "accept" },
        },
      ],
    }),
  });
  const posts: Array<Record<string, any>> = [];
  let scans = 0;
  const history = async () => {
    scans++;
    return { messages: posts.map((p, index) => ({ ...p, ts: String(index + 1) })) };
  };
  const client = {
    conversations: { open: async () => ({ channel: { id: "D1" } }), history, replies: history },
    chat: {
      postMessage: async (args: Record<string, any>) => {
        posts.push(args);
        return { ts: String(posts.length), channel: args.channel };
      },
    },
  };
  let loseAck = false;
  const core = {
    authorizeConversationDelivery: createConversationDeliveryAuthorizer({ deliveries, directory }),
    claimDeliveries: (type: string, ttl: number) => deliveries.claimPending(type, ttl),
    ackDelivery: async (id: string) => {
      if (loseAck) {
        loseAck = false;
        throw new Error("lost acknowledgement");
      }
      await deliveries.ack(id, Date.now());
    },
  };
  const newPoller = () =>
    createDeliveryPoller({
      core: core as never,
      bridge: { inFlightRuns: new Set() } as never,
      mirror: { mirrorSelfPost() {} } as never,
      threads: { mark() {} } as never,
      clientForIdentity: () => client,
    });
  return {
    deliveries,
    posts,
    client,
    core,
    newPoller,
    scans: () => scans,
    deny: () => {
      member = false;
    },
    loseAck: () => {
      loseAck = true;
    },
  };
}

for (const kind of ["slack", "principal", "notice"] as const) {
  test(`${kind} successful post with lost acknowledgement survives a new poller without duplication`, async (t) => {
    let now = 1_700_000_000_000;
    t.mock.method(Date, "now", () => now);
    const f = await fixture(kind);
    f.loseAck();
    await f.newPoller().pollDeliveries(f.client);
    assert.equal(f.posts.length, 1);
    assert.equal(f.scans(), 0, "first delivery must not scan history");
    assert.ok(f.posts[0]!.metadata.event_payload.idempotency_key.startsWith("zvconv:"));
    now += 15_001;
    await f.newPoller().pollDeliveries(f.client);
    assert.equal(f.posts.length, 1);
    assert.equal(f.scans(), 1);
    assert.equal((await f.deliveries.pending(kind === "slack" ? "slack" : "principal")).length, 0);
  });
}

test("revocation after queue claim blocks shared content and preserves one owner notice", async () => {
  const f = await fixture("slack");
  const claim = f.core.claimDeliveries;
  f.core.claimDeliveries = async (type, ttl) => {
    const rows = await claim(type, ttl);
    f.deny();
    return rows;
  };
  await f.newPoller().pollDeliveries(f.client);
  await f.newPoller().pollDeliveries(f.client);
  assert.equal(f.posts.filter((p) => p.channel === "C1").length, 0);
  assert.equal(f.posts.filter((p) => p.channel === "D1").length, 1);
  assert.doesNotMatch(JSON.stringify(f.posts), /BOUNDARY_SECRET/);
});

test("authority is checked again after a Slack rate limit before retrying the send", async () => {
  const f = await fixture("slack");
  let attempts = 0;
  f.client.chat.postMessage = async () => {
    attempts++;
    f.deny();
    throw Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 0 });
  };
  await f.newPoller().pollDeliveries(f.client);
  assert.equal(attempts, 1);
  assert.equal(f.posts.length, 0);
});

test("uncertain recovery has a bounded history cost and does not post when the scan is incomplete", async () => {
  const f = await fixture("principal");
  await f.deliveries.claimPending("principal", 0);
  let scans = 0;
  f.client.conversations.history = async () => {
    scans++;
    return { messages: [], response_metadata: { next_cursor: "more" } };
  };
  await f.newPoller().pollDeliveries(f.client);
  assert.equal(scans, 5);
  assert.equal(f.posts.length, 0);
  assert.equal((await f.deliveries.pending("principal")).length, 1);
});

test("legacy conversation deliveries without a durable principal binding fail closed", async () => {
  const f = await fixture("principal");
  const original = (await f.deliveries.pending("principal"))[0]!;
  await f.deliveries.ack(original.id, Date.now());
  await f.deliveries.enqueue({
    destination: original.destination,
    text: "UNBOUND_SECRET",
    idempotencyKey: "zvconv:legacy:2",
  });
  await f.newPoller().pollDeliveries(f.client);
  assert.equal(f.posts.length, 0);
});
