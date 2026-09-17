import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkMailSessionId } from "../src/check-mail.ts";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

const personal = { sessionId: "s-main", scopeId: "personal:stuart" };
const project = { sessionId: "s-proj", scopeId: "project:acme" };
const empty = { sessionId: null, scopeId: null };

test("full-screen chat targets the main conversation only when it is the user's personal chat", () => {
  assert.equal(checkMailSessionId("stuart", false, undefined, personal), "s-main");
  assert.equal(checkMailSessionId("stuart", false, undefined, project), null);
  assert.equal(checkMailSessionId("stuart", false, undefined, empty), null);
  assert.equal(checkMailSessionId("someone-else", false, undefined, personal), null);
});

test("split view targets the focused pane, never the stale main conversation", () => {
  const focused = { sessionId: "s-pane", scopeId: "personal:stuart" };
  assert.equal(checkMailSessionId("stuart", true, focused, personal), "s-pane");
  assert.equal(checkMailSessionId("stuart", true, { sessionId: "s-pane", scopeId: "project:acme" }, personal), null);
  assert.equal(checkMailSessionId("stuart", true, undefined, personal), null);
});

test("the shell resolves the check-mail target through the shared helper with the focused pane", () => {
  const body = shell.match(/function checkMailSessionId\(\): string \| null \{[^]*?\n\}/)?.[0] ?? "";
  assert.ok(body, "checkMailSessionId exists in shell.ts");
  assert.match(body, /focusedPaneSession\(\)/);
  assert.match(body, /splitState\.active/);
  assert.match(body, /mainConversation\(\)\.state/);
});

test("mounting or switching a session rerenders the sidebar so the check-mail button tracks the active chat", () => {
  const body = chat.match(/function syncLocation\(\): void \{[^]*?\n {2}\}/)?.[0] ?? "";
  assert.ok(body, "syncLocation exists");
  assert.match(body, /renderSidebarTop\(\)/);
  for (const mount of ["mountContinuable", "adoptActiveSessionFromList", "mountReadOnly"]) {
    const fn = chat.match(new RegExp(`function ${mount}\\([^]*?\\n {2}\\}`))?.[0] ?? "";
    assert.ok(fn, `${mount} exists`);
    assert.match(fn, /syncLocation\(\)/, `${mount} must flow through syncLocation`);
  }
});

test("focusing another split pane rerenders the sidebar", () => {
  const handler = split.match(/api\.onDidActivePanelChange\(\(e\) => \{[^]*?\n {2}\}\);/)?.[0] ?? "";
  assert.ok(handler, "active panel handler exists");
  assert.match(handler, /splitState\.focusedId = e\.panel\?\.id \?\? null/);
  assert.match(handler, /renderSidebarTop\(\)/);
});
