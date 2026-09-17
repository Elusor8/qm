import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const sessions: Record<string, { threadRef: string; scopeId: string }> = {
  "sess-mine": { threadRef: "web:alice:default", scopeId: "personal:alice" },
  "sess-shared": { threadRef: "web:alice:proj", scopeId: "group:proj-1" },
};

const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", body });
    const url = new URL(req.url ?? "/", "http://core");
    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && sessionMatch) {
      const viewer = url.searchParams.get("viewer");
      const session = sessions[decodeURIComponent(sessionMatch[1]!)];
      if (!session || viewer !== "alice") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "not_found" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ session: { id: sessionMatch[1], ...session }, entries: [] }));
    }
    if (req.method === "POST" && url.pathname === "/v1/turns") {
      res.writeHead(202, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "queued", runId: "run-1" }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "check-mail-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "check-mail-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

function findCall(from: number, method: string, pathname: string): Call | undefined {
  return calls.slice(from).find((c) => c.method === method && new URL(c.url, "http://core").pathname === pathname);
}

test("posts exactly the canned, triggered turn to the resolved session's threadRef", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/check-mail`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: "sess-mine" }),
  });
  assert.equal(r.status, 202);

  const sessionLookup = findCall(before, "GET", "/v1/sessions/sess-mine");
  assert.ok(sessionLookup, "the session was resolved via the viewer-gated relay");

  const turn = findCall(before, "POST", "/v1/turns");
  assert.ok(turn, "a turn was posted to core");
  assert.equal(turn!.body.text, "Check ZipViz mail.");
  assert.equal(turn!.body.triggered, true);
  assert.equal(turn!.body.surface, "web");
  assert.deepEqual(turn!.body.actor, { externalId: "alice" });
  assert.deepEqual(turn!.body.conversation, { kind: "dm", threadRef: "web:alice:default" });
  assert.equal(turn!.body.deliveryTarget, "web:alice:default");
});

test("ignores any client-supplied text, triggered, or threadRef", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/check-mail`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId: "sess-mine",
      text: "HACKED",
      triggered: false,
      threadRef: "web:alice:somewhere-else",
      actor: { externalId: "mallory" },
      deliveryTarget: "somewhere-else",
    }),
  });
  assert.equal(r.status, 202);
  const turn = findCall(before, "POST", "/v1/turns");
  assert.ok(turn);
  assert.equal(turn!.body.text, "Check ZipViz mail.");
  assert.equal(turn!.body.triggered, true);
  assert.deepEqual(turn!.body.actor, { externalId: "alice" });
  assert.equal((turn!.body.conversation as { threadRef: string }).threadRef, "web:alice:default");
  assert.equal(Object.keys(turn!.body).sort().join(","), "actor,conversation,deliveryTarget,surface,text,triggered");
});

test("rejects a sessionId the signed-in user cannot see, and posts no turn", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/check-mail`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: "sess-does-not-exist" }),
  });
  assert.equal(r.status, 404);
  assert.equal(findCall(before, "POST", "/v1/turns"), undefined, "no turn reaches core");
});

test("rejects a session outside the signed-in user's personal scope", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/check-mail`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: "sess-shared" }),
  });
  assert.equal(r.status, 403);
  assert.equal(findCall(before, "POST", "/v1/turns"), undefined, "no turn reaches core");
});

test("requires a sessionId in the body", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/check-mail`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
  assert.equal(calls.length, before, "nothing reached core");
});

test("requires an authenticated user", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/check-mail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "sess-mine" }),
  });
  assert.equal(r.status, 401);
  assert.equal(calls.length, before, "nothing reached core");
});
