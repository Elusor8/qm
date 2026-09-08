import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("capture inspection and recovery require org admin and accept only retained capture identity", async (t) => {
  const built = buildApp(testConfig());
  t.after(() => built.mcpToolService.close());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    conversationProjection: built.conversationProjection,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://localhost:${(server.address() as AddressInfo).port}/v1/admin/conversation-captures/`;
  const headers = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
  assert.equal((await fetch(`${base}unknown`)).status, 403);
  assert.equal(
    (
      await fetch(`${base}unknown/recover`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${base}unknown`, { headers })).status, 404);
  const context = {
    owner: "U1",
    ownerScopeId: "personal:U1",
    threadRef: "thread",
    sessionId: "session",
    surface: "webhook",
  };
  await built.conversationProjection.begin(context, {
    name: "bound_send",
    args: { mailbox: "alice.example.viz" },
    conversationBinding: { owner: "U1", mailbox: "alice.example.viz", remoteName: "zipviz_conversation_send" },
  });
  const captureId = (await built.deliveries.pending("conversation-capture"))[0]!.destination.target;
  assert.equal((await fetch(`${base}${captureId}`, { headers })).status, 200);
  const listed = await fetch(base.slice(0, -1), { headers });
  assert.equal(listed.status, 200);
  assert.ok(
    ((await listed.json()) as { captures: Array<{ id: string }> }).captures.some((record) => record.id === captureId),
  );
  const recovery = await fetch(`${base}${captureId}/recover`, {
    method: "POST",
    headers,
    body: JSON.stringify({ raw: { text: "forged" }, lastTurn: 99 }),
  });
  assert.equal(recovery.status, 409);
  assert.match(await recovery.text(), /no retained authoritative result/);
  assert.equal((await built.deliveries.pending("conversation-projection")).length, 0);
});
