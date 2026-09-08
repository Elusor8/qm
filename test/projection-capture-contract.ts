import type { Delivery } from "../src/types.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { createAgentConversationProjectionService } from "../src/conversations/agent-conversation-projection-service.ts";
import { agentConversationLinkId } from "../src/conversations/agent-conversation-link-store.ts";

export async function exerciseProjectionCapture(
  t: TestContext,
  deps: Parameters<typeof createAgentConversationProjectionService>[0],
) {
  const service = () => createAgentConversationProjectionService(deps);
  const owner = `capture-${randomUUID()}`;
  const mailbox = `${owner}.example.viz`;
  const context = {
    owner,
    ownerScopeId: `personal:${owner}`,
    threadRef: `web:${owner}:test`,
    sessionId: "session",
    surface: "webhook",
  };
  const side = { owner, mailbox, conversationId: `conv-${randomUUID()}` };
  const key = agentConversationLinkId(side);
  const observation = (turn: number) => ({
    name: "bound_send",
    args: { mailbox, conversation_id: side.conversationId },
    raw: {
      conversationBinding: { owner, mailbox, remoteName: "zipviz_conversation_send" },
      text: JSON.stringify({
        disposition: "new",
        snapshot: { conversation_id: side.conversationId, turns: turn, peer: "peer.example.viz" },
        turn: { message: `signed turn ${turn}`, conversation: { id: side.conversationId, turn, intent: "accept" } },
      }),
    },
  });
  const begin = (worker: ReturnType<typeof service>, turn: number) => {
    const input = observation(turn);
    return worker.begin(context, {
      name: input.name,
      args: input.args,
      conversationBinding: input.raw.conversationBinding,
    });
  };
  const posts = async () =>
    (await deps.deliveries.pending("principal")).filter((d) => d.provenance?.conversation?.sideKey === key);
  const later = () => new Promise((resolve) => setTimeout(resolve, 1_100));

  await t.test("in-flight first calls retain N when N+1 returns first, across restart", async () => {
    const first = await begin(service(), 5);
    const second = await begin(service(), 6);
    await second!.result(observation(6).raw);
    await service().sweep();
    assert.equal((await posts()).length, 0);
    await first!.result(observation(5).raw);
    await later();
    await service().sweep();
    assert.deepEqual(
      (await posts()).map((d) => d.provenance!.conversation!.turn),
      [5, 6],
    );
    assert.equal((await deps.progress.get(key))!.baselineTurn, 4);
    await service().capture(context, observation(3));
    await service().capture(context, observation(5));
    await service().sweep();
    assert.equal((await posts()).length, 2);
  });

  await t.test("retained raw result repairs failed enqueue after restart without a remote retry", async () => {
    const enqueue = deps.deliveries.enqueue.bind(deps.deliveries);
    const failure = t.mock.method(deps.deliveries, "enqueue", async (input: Parameters<typeof enqueue>[0]) => {
      if (input.destination.type === "conversation-projection") throw new Error("queue unavailable");
      return enqueue(input);
    });
    await assert.rejects(service().capture(context, observation(7)), /queue unavailable/);
    const pending = (await deps.deliveries.pending("conversation-capture")).find((d) => d.deliveredAt === null);
    assert.ok(pending);
    failure.mock.restore();
    await service().sweep();
    assert.equal((await posts()).length, 3);
    assert.match((await posts())[2]!.text, /signed turn 7/);
  });

  await t.test("explicit recovery fills a missing turn from retained evidence and never skips the gap", async () => {
    await service().capture(context, observation(8));
    const job = (await deps.deliveries.pending("conversation-projection")).find((d) => JSON.parse(d.text).turn === 8)!;
    await deps.deliveries.ack(job.id, Date.now());
    const journals = await deps.deliveries.pending("conversation-capture");
    let captureId = "";
    for (const delivery of journals) {
      const record = await service().inspect(delivery.destination.target);
      if (record?.raw?.text === observation(8).raw.text) {
        captureId = delivery.destination.target;
        await deps.deliveries.ack(delivery.id, Date.now());
      }
    }
    assert.ok(captureId);
    await service().capture(context, observation(9));
    await service().sweep();
    assert.equal((await deps.progress.get(key))!.lastTurn, 7);
    await service().recover(captureId);
    await later();
    await service().sweep();
    assert.deepEqual(
      (await posts()).map((d) => d.provenance!.conversation!.turn),
      [5, 6, 7, 8, 9],
    );
    await service().recover(captureId);
    await service().sweep();
    assert.equal((await posts()).length, 5);
  });

  await t.test("poison rows are quarantined once with evidence and valid work behind them progresses", async () => {
    const poisoned: Delivery[] = [];
    for (let i = 0; i < 32; i++)
      poisoned.push(
        await deps.deliveries.enqueue({
          destination: { type: "conversation-projection", target: key },
          text: `broken-${i}`,
          idempotencyKey: `poison:${randomUUID()}`,
        }),
      );
    await service().capture(context, observation(10));
    await service().sweep();
    await service().sweep();
    assert.equal((await deps.progress.get(key))!.lastTurn, 10);
    const dead = (await deps.deliveries.pending("conversation-projection-quarantine")).filter((d) =>
      poisoned.some((p) => p.id === d.destination.target),
    );
    assert.equal(dead.length, 32);
    assert.ok(dead.every((d) => JSON.parse(d.text).sourceText.startsWith("broken-")));
    await later();
    await service().sweep();
    assert.ok(
      (await Promise.all(poisoned.map((p) => deps.deliveries.get(p.id)))).every((d) => d!.deliveredAt !== null),
    );
    assert.equal(
      (await deps.deliveries.pending("conversation-projection-quarantine")).filter((d) =>
        poisoned.some((p) => p.id === d.destination.target),
      ).length,
      32,
    );
  });

  await t.test("security rejection remains durable and cannot be recovered into a projection", async () => {
    const input = observation(11);
    await assert.rejects(service().capture({ ...context, owner: "wrong" }, input), /principal/);
    const journal = (await deps.deliveries.pending("conversation-capture")).at(-1)!;
    const record = await service().inspect(journal.destination.target);
    assert.equal(record!.state, "rejected");
    assert.equal(record!.raw!.text, input.raw.text);
    await assert.rejects(service().recover(journal.destination.target), /principal/);
    await service().sweep();
    assert.equal((await deps.progress.get(key))!.lastTurn, 10);
  });

  await t.test("unknown remote outcome retains intent and refuses to invent a recovery result", async () => {
    const call = await begin(service(), 11);
    const journal = (await deps.deliveries.pending("conversation-capture")).at(-1)!;
    await call!.failed(new Error("response lost"));
    assert.equal((await service().inspect(journal.destination.target))!.state, "uncertain");
    await assert.rejects(service().recover(journal.destination.target), /no retained authoritative result/);
    assert.equal((await deps.progress.get(key))!.lastTurn, 10);
    await call!.result(observation(11).raw);
  });
  await t.test("concurrent first captures and independent participants keep separate baselines", async () => {
    const cid = `conv-${randomUUID()}`;
    const input = (turn: number) => {
      const value = observation(turn);
      value.args.conversation_id = cid;
      value.raw.text = value.raw.text.replaceAll(side.conversationId, cid);
      return value;
    };
    const a = input(12),
      b = input(13);
    const first = await service().begin(context, { ...a, conversationBinding: a.raw.conversationBinding });
    const second = await service().begin(context, { ...b, conversationBinding: b.raw.conversationBinding });
    await Promise.all([second!.result(b.raw), first!.result(a.raw)]);
    await service().sweep();
    const newKey = agentConversationLinkId({ ...side, conversationId: cid });
    const received = (await deps.deliveries.pending("principal")).filter(
      (d) => d.provenance?.conversation?.sideKey === newKey,
    );
    assert.deepEqual(
      received.map((d) => d.provenance!.conversation!.turn),
      [12, 13],
    );
    const pending = await begin(service(), 11);
    const other = observation(4);
    other.raw.conversationBinding.owner = `${owner}-other`;
    other.raw.conversationBinding.mailbox = `other.${mailbox}`;
    other.args.mailbox = other.raw.conversationBinding.mailbox;
    const otherContext = {
      ...context,
      owner: other.raw.conversationBinding.owner,
      ownerScopeId: `personal:${other.raw.conversationBinding.owner}`,
    };
    await service().capture(otherContext, other);
    await service().sweep();
    const otherKey = agentConversationLinkId({
      owner: otherContext.owner,
      mailbox: other.args.mailbox,
      conversationId: side.conversationId,
    });
    assert.equal((await deps.progress.get(otherKey))!.lastTurn, 4);
    await pending!.result(observation(11).raw);
  });

  await t.test("a later historical capture cannot extend the initial baseline backwards", async () => {
    const cid = `conv-${randomUUID()}`;
    const input = (turn: number) => {
      const value = observation(turn);
      value.args.conversation_id = cid;
      value.raw.text = value.raw.text.replaceAll(side.conversationId, cid);
      return value;
    };
    await service().capture(context, input(8));
    await service().capture(context, input(3));
    await service().sweep();
    const newKey = agentConversationLinkId({ ...side, conversationId: cid });
    assert.equal((await deps.progress.get(newKey))!.baselineTurn, 7);
    assert.deepEqual(
      (await deps.deliveries.pending("principal"))
        .filter((d) => d.provenance?.conversation?.sideKey === newKey)
        .map((d) => d.provenance!.conversation!.turn),
      [8],
    );
  });

  await t.test(
    "lost initial response holds its cohort across restart while an independent side progresses",
    async () => {
      const lostOwner = `${owner}-lost`;
      const lostMailbox = `lost.${mailbox}`;
      const lostContext = { ...context, owner: lostOwner, ownerScopeId: `personal:${lostOwner}` };
      const input = (turn: number) => {
        const value = observation(turn);
        value.args.mailbox = lostMailbox;
        value.raw.conversationBinding.owner = lostOwner;
        value.raw.conversationBinding.mailbox = lostMailbox;
        return value;
      };
      const first = input(1);
      const opener = await service().begin(lostContext, {
        ...first,
        conversationBinding: first.raw.conversationBinding,
      });
      const journal = (await deps.deliveries.pending("conversation-capture")).at(-1)!;
      await service().capture(lostContext, input(2));
      await opener!.failed(new Error("committed response lost"));
      const lostKey = agentConversationLinkId({ ...side, owner: lostOwner, mailbox: lostMailbox });
      for (let i = 0; i < 2; i++) {
        await later();
        await service().sweep();
        assert.equal((await deps.progress.get(lostKey))!.initializing, true);
        assert.equal(
          (await deps.deliveries.pending("principal")).filter((d) => d.provenance?.conversation?.sideKey === lostKey)
            .length,
          0,
        );
        assert.equal((await service().inspect(journal.destination.target))!.state, "uncertain");
        await assert.rejects(service().recover(journal.destination.target), /no retained authoritative result/);
      }
      await service().capture(context, observation(12));
      await service().sweep();
      assert.equal((await deps.progress.get(key))!.lastTurn, 12);
    },
  );

  await t.test("lost quarantine acknowledgement retries idempotently after restart", async () => {
    const poisoned = await deps.deliveries.enqueue({
      destination: { type: "conversation-projection", target: key },
      text: "invalid",
      idempotencyKey: `poison:${randomUUID()}`,
    });
    const ack = deps.deliveries.ack.bind(deps.deliveries);
    const failure = t.mock.method(deps.deliveries, "ack", async (...args: Parameters<typeof ack>) => {
      if (args[0] === poisoned.id) throw new Error("ack lost");
      return ack(...args);
    });
    await assert.rejects(service().sweep(), /ack lost/);
    failure.mock.restore();
    await later();
    await service().sweep();
    assert.equal(
      (await deps.deliveries.pending("conversation-projection-quarantine")).filter(
        (d) => d.destination.target === poisoned.id,
      ).length,
      1,
    );
    assert.notEqual((await deps.deliveries.get(poisoned.id))!.deliveredAt, null);
  });
}
