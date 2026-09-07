import type { SessionStore } from "../src/sessions/session-store.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentConversationProjectionService } from "../src/conversations/agent-conversation-projection-service.ts";

export async function exerciseProjectionFairness(
  deps: Parameters<typeof createAgentConversationProjectionService>[0] & { projectionSessions: SessionStore },
) {
  const service = createAgentConversationProjectionService(deps);
  const prefix = randomUUID();
  const held = [];
  const sessionIds = [];
  const pending = deps.deliveries.pending.bind(deps.deliveries);
  let largestBatch = 0;
  const monitored = createAgentConversationProjectionService({
    ...deps,
    deliveries: {
      ...deps.deliveries,
      pending: async (type, opts) => {
        assert.ok(opts, "the worker must request bounded ready work");
        assert.equal(opts.limit, 32);
        const rows = await pending(type, opts);
        largestBatch = Math.max(largestBatch, rows.length);
        assert.ok(rows.length <= opts.limit);
        return rows;
      },
    },
  });
  try {
    for (let index = 0; index < 4; index++) {
      const conversationId = `conv-${prefix}-${index}`;
      const session = await deps.projectionSessions!.getOrCreateByThread(
        `web:${prefix}:${index}`,
        "dm",
        "personal:U1",
        undefined,
        "web",
      );
      sessionIds.push(session.id);
      if (index < 3) {
        const { lease } = await deps.projectionSessions!.acquireLease(session.id, "turn");
        assert.ok(lease);
        held.push(lease);
      }
      for (let turn = 1; turn <= (index < 3 ? 2 : 1); turn++) {
        await service.capture(
          {
            owner: "U1",
            ownerScopeId: "personal:U1",
            threadRef: session.threadRef,
            sessionId: session.id,
            surface: index < 3 ? "web" : "slack",
            destination:
              index < 3
                ? { type: "web", target: session.threadRef, audienceScopeId: "personal:U1" }
                : { type: "principal", target: "U1" },
          },
          {
            name: "signed",
            args: { mailbox: "u1.example.viz" },
            raw: {
              conversationBinding: {
                owner: "U1",
                mailbox: "u1.example.viz",
                remoteName: turn === 1 ? "zipviz_conversation_open" : "zipviz_conversation_send",
              },
              text: JSON.stringify({
                snapshot: { conversation_id: conversationId, turns: turn, peer: "peer.example.viz" },
                turn: {
                  message: `${prefix} turn ${turn}`,
                  conversation: { id: conversationId, turn, intent: "propose" },
                },
              }),
            },
          },
        );
      }
    }
    for (let sweep = 0; sweep < 4; sweep++) await monitored.sweep();
    assert.equal(
      (await pending("principal")).filter((d) => d.text.includes(prefix)).length,
      1,
      "healthy work progresses while unrelated leases remain held",
    );
    for (const id of sessionIds.slice(0, 3)) assert.equal((await deps.projectionSessions!.getEntries(id)).length, 0);
    for (const lease of held.splice(0)) await deps.projectionSessions!.releaseLease(lease);
    await service.stop();
    for (let sweep = 0; sweep < 3; sweep++) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await monitored.sweep();
    }
    for (const id of sessionIds.slice(0, 3))
      assert.deepEqual(
        (await deps.projectionSessions!.getEntries(id)).map((e) => (e.payload as { ts: string }).ts.split(":").at(-1)),
        ["1", "2"],
      );
    assert.ok(largestBatch <= 32);
  } finally {
    for (const lease of held) await deps.projectionSessions!.releaseLease(lease);
    await service.stop();
    await monitored.stop();
  }
}
