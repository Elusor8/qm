import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };

test("MCP server writes reject unknown binding principals and persist the resolved canonical principal", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-mcp-")) }));
  await built.directory.replace([{ principalId: "Agent@Example.com", displayName: "Agent", type: "internal" }]);
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    directory: built.directory,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const body = (actorPrincipalId: string) => ({
    name: "ZipViz",
    url: "https://mail.agents.zipviz.ai/mcp",
    auth: "none",
    readOnly: false,
    enabled: true,
    validate: false,
    zipviz: {
      adapterKind: "https://zipviz.ai/adapters/qm",
      adapterInstance: "qm-runtime-australia-1",
      mailbox: "gary.yc.viz",
      actorExternalId: "qm-gary",
      actorPrincipalId,
    },
  });
  try {
    const invalid = await fetch(`${base}/v1/admin/mcp-servers/zipviz`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(body("missing@example.com")),
    });
    assert.equal(invalid.status, 400);
    assert.equal(await built.mcpServers.get("zipviz"), null);

    const valid = await fetch(`${base}/v1/admin/mcp-servers/zipviz`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(body("agent@example.com")),
    });
    assert.equal(valid.status, 200, await valid.text());
    assert.deepEqual((await built.mcpServers.get("zipviz"))?.zipviz, {
      adapterKind: "https://zipviz.ai/adapters/qm",
      adapterInstance: "qm-runtime-australia-1",
      mailbox: "gary.yc.viz",
      actorExternalId: "qm-gary",
      actorPrincipalId: "Agent@Example.com",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP server writes accept an email-auth internal principal absent from the synced directory", async () => {
  // An email sign-in deployment without Slack has an empty synced directory;
  // its only internal members come from AUTH_ALLOWED_EMAILS. The binding must
  // resolve against that merged view while still rejecting unknown and guest ids.
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "admin-mcp-email-")),
      emailAuthPrincipals: ["operator@example.com"],
    }),
  );
  await built.directory.replace([{ principalId: "Visitor@Example.com", displayName: "Visitor", type: "guest" }]);
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    directory: built.directory,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const put = (actorPrincipalId: string) =>
    fetch(`${base}/v1/admin/mcp-servers/zipviz`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        name: "ZipViz",
        url: "https://mail.agents.zipviz.ai/mcp",
        auth: "none",
        readOnly: false,
        enabled: true,
        validate: false,
        zipviz: {
          adapterKind: "https://zipviz.ai/adapters/qm",
          adapterInstance: "qm-reference",
          mailbox: "operator.example.viz",
          actorExternalId: "operator@example.com",
          actorPrincipalId,
        },
      }),
    });
  try {
    assert.equal((await put("nobody@example.com")).status, 400);
    assert.equal((await put("visitor@example.com")).status, 400, "a guest directory member is not internal");
    assert.equal(await built.mcpServers.get("zipviz"), null);

    const valid = await put("Operator@Example.com");
    assert.equal(valid.status, 200, await valid.text());
    assert.equal((await built.mcpServers.get("zipviz"))?.zipviz?.actorPrincipalId, "operator@example.com");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
