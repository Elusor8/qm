import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEARCH_PRINCIPALS_HEADER,
  createCoreSearch,
  createHttpSearchBackend,
  type SearchBackend,
} from "../src/search/core-search.ts";
import { createIntersectionBackend } from "../src/search/backends.ts";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
const principals = [
  { id: "alice@example.com", type: "internal" as const },
  { id: "bob@example.com", type: "internal" as const },
];
test("core search canonicalizes the principal floor and isolates failures", async () => {
  const seen: string[][] = [];
  const backend = (name: string, fail = false): SearchBackend => ({
    name,
    async search(r) {
      seen.push(r.principals.map((p) => p.id));
      if (fail) throw new Error("down");
      return [{ id: name, type: "page", snippet: r.query }];
    },
  });
  const result = await createCoreSearch([backend("one"), backend("bad", true), backend("two")]).search({
    query: "plan",
    principals: [principals[1]!, principals[0]!, principals[0]!],
  });
  assert.deepEqual(seen, Array(3).fill(["alice@example.com", "bob@example.com"]));
  assert.deepEqual(
    result.hits.map((h) => h.backend),
    ["one", "two"],
  );
  assert.deepEqual(result.failedBackends, ["bad"]);
});
test("intersection backend requires visibility to every principal", async () => {
  const backend = createIntersectionBackend({
    name: "files",
    key: (h) => h.id,
    searchForPrincipal: async (p) =>
      p.id.startsWith("alice")
        ? [
            { id: "shared", type: "file", snippet: "x" },
            { id: "private", type: "file", snippet: "x" },
          ]
        : [{ id: "shared", type: "file", snippet: "x" }],
  });
  assert.deepEqual(
    (await backend.search({ query: "x", principals, limit: 20 })).map((h) => h.id),
    ["shared"],
  );
});
test("HTTP backend forwards the principal list in one header", async () => {
  let header = "";
  const server = createHttpServer(async (req, res) => {
    header = String(req.headers[SEARCH_PRINCIPALS_HEADER] ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ hits: [{ id: "1", type: "page", snippet: "x" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    await createHttpSearchBackend({ name: "brain", url: `http://127.0.0.1:${port}` }).search({
      query: "x",
      principals,
      limit: 5,
    });
    assert.deepEqual(
      JSON.parse(header),
      principals.map((p) => p.id),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("POST /v1/search derives principals from capability and shared scopes fail closed", async () => {
  const seen: string[][] = [];
  const external: SearchBackend = {
    name: "external",
    async search(r) {
      seen.push(r.principals.map((p) => p.id));
      return [];
    },
  };
  const secret = "search-route-secret".repeat(3);
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "search-")), signingSecret: secret }), {
    searchBackends: [external],
  });
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "private", isPrivate: true }],
    principals.map((p) => ({ channelId: "C1", principalId: p.id })),
  );
  const server = createServer(built.app, { signingSecret: secret, auditLog: built.auditLog });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = async (members?: typeof principals) =>
    mintCapabilityToken(
      {
        actorId: principals[0]!.id,
        scopeId: scopeId("channel", "C1"),
        ...(members ? { members } : {}),
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      secret,
    );
  const post = async (cap: string) =>
    fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify({ query: "plan" }),
    });
  try {
    assert.equal((await post(await token(principals))).status, 200);
    assert.deepEqual(seen, [["alice@example.com", "bob@example.com"]]);
    assert.equal((await post(await token())).status, 409);
    assert.equal(seen.length, 1);
    const event = (await built.auditLog.events()).find((e) => e.action === "search.query");
    assert.ok(event);
    assert.doesNotMatch(event.detail ?? "", /plan/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
