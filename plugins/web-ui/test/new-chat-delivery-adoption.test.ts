import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(e: { data: string }) => void>>();
  onopen: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  close(): void {}
}

test("a delivery nudge adopts a brand-new chat's session and refetches its transcript", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    EventSource: FakeEventSource,
    fetch: globalThis.fetch,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const other = { id: "sess-other", threadRef: "web:tester:other", scopeId: "personal:tester", title: "Other" };
  let serverSessions: Array<{ id: string; threadRef: string; scopeId: string; title: string | null }> = [other];
  let listGate: Promise<void> | null = null;
  const listFetches: number[] = [];
  const transcriptFetches: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/sessions") {
      listFetches.push(Date.now());
      const gate = listGate;
      const sessions = () => Response.json({ sessions: serverSessions });
      return gate ? gate.then(sessions) : sessions();
    }
    const approvals = /^\/api\/sessions\/([^/?]+)\/approvals$/.exec(path);
    if (approvals) return Response.json({ approvals: [] });
    const transcript = /^\/api\/sessions\/([^/?]+)(?:\?|$)/.exec(path);
    if (transcript) {
      const id = decodeURIComponent(transcript[1]!);
      transcriptFetches.push(id);
      return Response.json({ session: serverSessions.find((s) => s.id === id) ?? null, entries: [] });
    }
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    if (path.startsWith("/api/runtime-config"))
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: ["pi"],
        modelsByHarness: {},
        modelCatalog: {},
        orgDefault: { harnessId: "pi", modelId: "", revision: 1 },
        scopeOverride: null,
        effective: { harnessId: "pi", modelId: "" },
        upgradeAvailable: false,
      });
    return Response.json({});
  };

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell.ts");
    const { mainConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    appState.me = { user: "tester", org: "test" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    document.body.append(appState.mainEl);
    sessionsState.list = [other];
    sessionsState.loaded = true;
    const conv = mainConversation();
    const nudge = (threadRef: string): void => {
      const stream = FakeEventSource.instances.find((es) => es.url.endsWith("/api/deliveries/events"));
      assert.ok(stream, "the chat opens the delivery stream");
      stream.emit("delivery", { threadRef });
    };
    const reset = (): void => {
      listFetches.length = 0;
      transcriptFetches.length = 0;
    };

    await t.test("a new chat adopts its session from the refreshed list and fetches the transcript", async () => {
      const threadRef = conv.newChat();
      await settle();
      assert.equal(conv.state.sessionId, null);
      serverSessions = [other, { id: "sess-new", threadRef, scopeId: "personal:tester", title: null }];
      reset();
      nudge(threadRef);
      await settle();
      assert.equal(listFetches.length, 1, "the chat reuses the list refresh the nudge already started");
      assert.equal(conv.state.sessionId, "sess-new");
      assert.deepEqual(transcriptFetches, ["sess-new"]);
    });

    await t.test("a nudge for a different thread leaves the new chat alone", async () => {
      const threadRef = conv.newChat();
      await settle();
      serverSessions = [other, { id: "sess-mine", threadRef, scopeId: "personal:tester", title: null }];
      reset();
      nudge("web:tester:somewhere-else");
      await settle();
      assert.equal(conv.state.sessionId, null);
      assert.deepEqual(transcriptFetches, []);
    });

    await t.test("a streaming chat ignores the nudge", async () => {
      const threadRef = conv.newChat();
      await settle();
      serverSessions = [other, { id: "sess-streaming", threadRef, scopeId: "personal:tester", title: null }];
      const agentState = conv.state.agent!.state as { isStreaming: boolean };
      agentState.isStreaming = true;
      try {
        reset();
        nudge(threadRef);
        await settle();
        assert.equal(conv.state.sessionId, null);
        assert.deepEqual(transcriptFetches, []);
      } finally {
        agentState.isStreaming = false;
      }
    });

    await t.test("a refreshed list without the chat's session fetches nothing and settles quietly", async () => {
      conv.newChat();
      await settle();
      serverSessions = [other];
      reset();
      nudge(conv.state.threadRef!);
      await settle();
      await settle();
      assert.equal(conv.state.sessionId, null);
      assert.deepEqual(transcriptFetches, []);
      assert.equal(listFetches.length, 1, "no retry loop");
      assert.deepEqual(unhandled, []);
    });

    await t.test("switching chats while the list refresh is in flight never adopts onto the new chat", async () => {
      const first = conv.newChat();
      await settle();
      serverSessions = [other, { id: "sess-first", threadRef: first, scopeId: "personal:tester", title: null }];
      const gate = deferred();
      listGate = gate.promise;
      try {
        reset();
        nudge(first);
        const second = conv.newChat();
        gate.release();
        await settle();
        assert.equal(conv.state.threadRef, second);
        assert.equal(conv.state.sessionId, null);
        assert.deepEqual(transcriptFetches, []);
      } finally {
        listGate = null;
      }
    });

    await t.test("a sidebar-opened chat refetches its transcript without waiting for the list", async () => {
      const threadRef = "web:tester:opened";
      serverSessions = [other, { id: "sess-opened", threadRef, scopeId: "personal:tester", title: "Opened" }];
      conv.mountContinuable(threadRef, "sess-opened", "personal:tester", []);
      await settle();
      const gate = deferred();
      listGate = gate.promise;
      try {
        reset();
        nudge(threadRef);
        await settle();
        assert.deepEqual(transcriptFetches, ["sess-opened"], "fetched while the list refresh is still pending");
        assert.equal(conv.state.sessionId, "sess-opened");
      } finally {
        gate.release();
        listGate = null;
        await settle();
      }
    });
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
