import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";

const value = JSON.stringify({
  providers: [
    {
      id: "gbrain",
      type: "mcp",
      url: "http://qm-gbrain-relay.flycast:48081",
      read: { tool: "read_brain", clientIdEnv: "BRAIN_RO_CLIENT_ID", clientSecretEnv: "BRAIN_RO_CLIENT_SECRET" },
      write: { tool: "write_brain", clientIdEnv: "BRAIN_RW_CLIENT_ID", clientSecretEnv: "BRAIN_RW_CLIENT_SECRET" },
    },
  ],
  routes: [
    { provider: "default", scopes: ["personal", "channel", "group"], capture: "automatic" },
    { provider: "gbrain", scopes: ["org"], capture: "explicit", manage: false, label: "Organization" },
  ],
});

test("provider config resolves MCP credentials and scope routes", () => {
  const config = parseMemoryProviderConfig(value, {
    BRAIN_RO_CLIENT_ID: "ro",
    BRAIN_RO_CLIENT_SECRET: "ro-secret",
    BRAIN_RW_CLIENT_ID: "rw",
    BRAIN_RW_CLIENT_SECRET: "rw-secret",
  });
  assert.equal(config?.providers[0]?.read.auth.clientId, "ro");
  assert.equal(config?.providers[0]?.write?.auth.clientId, "rw");
  assert.deepEqual(
    config?.routes.map(({ provider, scopes, capture }) => ({ provider, scopes, capture })),
    [
      { provider: "default", scopes: ["personal", "channel", "group"], capture: "automatic" },
      { provider: "gbrain", scopes: ["org"], capture: "explicit" },
    ],
  );
});

test("provider config rejects unknown providers and public cleartext MCP URLs", () => {
  assert.throws(
    () =>
      parseMemoryProviderConfig(
        JSON.stringify({ providers: [], routes: [{ provider: "missing", scopes: ["org"] }] }),
        {},
      ),
    /unknown memory provider/,
  );
  assert.throws(
    () =>
      parseMemoryProviderConfig(value.replace("qm-gbrain-relay.flycast", "example.com"), {
        BRAIN_RO_CLIENT_ID: "ro",
        BRAIN_RO_CLIENT_SECRET: "x",
        BRAIN_RW_CLIENT_ID: "rw",
        BRAIN_RW_CLIENT_SECRET: "x",
      }),
    /HTTPS or a recognized private HTTP host/,
  );
});
