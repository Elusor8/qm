import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readerStore from "../src/conversations/conversation-projection-reader-store.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { testConfig } from "./support/test-config.ts";

const mailbox = "alice.example.viz";
const conversationId = "conv-00000000-0000-4000-8000-000000000001";
const binding = {
  mailbox,
  actorPrincipalId: "U1",
  actorExternalId: "alice",
  adapterKind: "https://example.invalid/adapter",
  adapterInstance: "test",
};

function event(turn: number, side: "us" | "them", revision: number) {
  return {
    event_id: `event-${turn}`,
    projection_revision: revision,
    source: "zipviz-signed-v3",
    authoritative: true,
    mailbox,
    conversation_id: conversationId,
    turn,
    side,
    from: side === "us" ? mailbox : "bob.example.viz",
    to: side === "us" ? "bob.example.viz" : mailbox,
    msg_id: `msg-${turn}`,
    body: "SIGNED OUTBOUND",
    body_trust: "own",
    ledger_status: "committed",
    signed: {
      envelope_v: 3,
      signature: "sig",
      timestamp: "2026-09-10T00:00:00Z",
      expires_at: "2026-09-11T00:00:00Z",
      reply_to: null,
      intent: turn === 1 ? "propose" : "accept",
      state: "active",
      goal_ref: "goal",
      authority_claim: null,
      acting_for_claim: null,
      reply_by: null,
      wake: null,
      outcome_code: null,
      human_summary: null,
    },
    receipt: { present: false, status: null, received_at: null, signed_receipt: null },
    timing: { sender_timestamp: "2026-09-10T00:00:00Z" },
    correlation: {
      adapter_kind: binding.adapterKind,
      adapter_instance: binding.adapterInstance,
      external_scope: "thread",
      external_conversation_ref: "slack:U1:open",
      external_event_id: "native-open",
      disposition: "new",
    },
  };
}

test("a drop that fails after the watermark advanced is retried instead of stranding the turn", async (t) => {
  let dropFailures = 1;
  mock.module("../src/conversations/conversation-projection-reader-store.ts", {
    namedExports: {
      ...readerStore,
      createMemoryProjectionReaderStore: () => {
        const store = readerStore.createMemoryProjectionReaderStore();
        return {
          ...store,
          drop: async (...args: Parameters<readerStore.ProjectionReaderStore["drop"]>) => {
            if (dropFailures > 0) {
              dropFailures -= 1;
              throw new Error("durable skip write failed");
            }
            return store.drop(...args);
          },
        };
      },
    },
  });
  let projectionReads = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    let result: unknown = { content: [{ type: "text", text: "{}" }] };
    if (request.method === "tools/list")
      result = { tools: [{ name: "zipviz_conversation_projection_events", inputSchema: { type: "object" } }] };
    else if (request.params.name === "zipviz_conversation_projection_events") {
      const read = projectionReads++;
      const events = [[event(1, "us", 1)], [event(2, "us", 2)], [event(3, "us", 3)]][read] ?? [];
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mailbox,
              events,
              skipped: [],
              next_cursor: null,
              high_water_cursor: `cursor-${read}`,
              has_more: false,
            }),
          },
        ],
      };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  const { buildApp } = await import("../src/wiring.ts");
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ledger-drop-retry-")), signingSecret: "x".repeat(32) }),
  );
  t.after(async () => {
    built.mcpToolService.close();
    await built.runtime.stop();
  });
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Owner", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Ops", ownerId: "U2" });
  await built.projects.addMember(project.id, "U2", "U1");
  const groupRef = projectGroupRef(project.id);
  await built.mcpServers.put({
    id: "zipviz",
    name: "ZipViz",
    url: "https://mcp-projection.invalid/mcp",
    auth: "none",
    enabled: true,
    readOnly: false,
    updatedAt: 0,
    updatedBy: "U1",
    zipviz: binding,
  });
  await built.mcpToolService.refresh();
  await built.conversationProjection.hint(
    {
      owner: "U1",
      ownerScopeId: "personal:U1",
      threadRef: "slack:U1:open",
      sessionId: "session-open",
      surface: "slack",
      destination: { type: "group", target: groupRef },
    },
    {
      name: "zipviz_zipviz_conversation_open",
      serverId: "zipviz",
      runtimeContext: { actorId: "U1", threadRef: "slack:U1:open", nativeEventId: "native-open" },
      args: { mailbox },
      conversationBinding: { owner: "U1", mailbox, remoteName: "zipviz_conversation_open" },
    },
  );
  await built.projects.removeMember(project.id, "U2", "U1");
  await built.conversationProjection.sweep();
  const stranded = await built.conversationProjection.diagnostics();
  assert.equal(stranded.outbox.length, 1);
  assert.equal((stranded.readers[0]?.skips ?? []).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await built.conversationProjection.sweep();
  const recovered = await built.conversationProjection.diagnostics();
  assert.equal(recovered.outbox.length, 0);
  assert.deepEqual(
    (recovered.readers[0]?.skips ?? []).map((skip) => [skip.msgId, skip.code]).sort(),
    [
      ["msg-1", "E_TURN_BEHIND_WATERMARK"],
      ["msg-2", "E_DESTINATION_UNAVAILABLE"],
    ],
  );
  await built.projects.addMember(project.id, "U2", "U1");
  await built.conversationProjection.sweep();
  await built.conversationProjection.sweep();
  assert.deepEqual(
    (await built.deliveries.pending("group")).map((row) => row.provenance?.conversation?.turn),
    [3],
  );
  assert.equal((await built.conversationProjection.diagnostics()).outbox.length, 0);
});
