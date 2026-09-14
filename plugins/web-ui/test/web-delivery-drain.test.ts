import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

interface Pending {
  id: string;
  idempotencyKey: string;
  createdAt: number;
  destination: { target: string };
}

let pending: Pending[] = [];
const acks: string[] = [];
const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  req.on("end", () => {
    const url = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    const ack = /^\/v1\/deliveries\/([^/?]+)\/ack(?:\?|$)/.exec(url);
    if (req.method === "POST" && ack) {
      const id = decodeURIComponent(ack[1]!);
      acks.push(id);
      pending = pending.filter((d) => d.id !== id);
      return void res.end(JSON.stringify({ ok: true }));
    }
    if (url.startsWith("/v1/deliveries")) return void res.end(JSON.stringify({ deliveries: pending }));
    res.end("{}");
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-delivery-drain-test";
process.env.WEB_UI_PRINCIPALS = "alice@example.test";

const { handler, drainWebDeliveries } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const EMAIL = "alice@example.test";

function captureWarnings(): { lines: () => string[]; restore: () => void } {
  const warn = mock.method(console, "warn", () => {});
  return {
    lines: () => warn.mock.calls.map((call) => call.arguments.map(String).join(" ")),
    restore: () => warn.mock.restore(),
  };
}

async function openDeliveryStream(): Promise<{ events: string[]; close: () => Promise<void> }> {
  const controller = new AbortController();
  const r = await fetch(`${base}/api/deliveries/events`, {
    headers: { cookie: `webuiuser=${encodeURIComponent(EMAIL)}` },
    signal: controller.signal,
  });
  assert.equal(r.status, 200);
  const events: string[] = [];
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      events.push(decoder.decode(value, { stream: true }));
    }
  })();
  return {
    events,
    close: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

test("an unparseable target is acked on the first poll with one warning that names no target or email", async () => {
  acks.length = 0;
  const stream = await openDeliveryStream();
  const warnings = captureWarnings();
  try {
    pending = [
      {
        id: "d-unparseable",
        idempotencyKey: `zvconv:nudge:${EMAIL}:3:1`,
        createdAt: Date.now(),
        destination: { target: `slack:${EMAIL}` },
      },
    ];
    await drainWebDeliveries();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(acks, ["d-unparseable"]);
    const lines = warnings.lines();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[web-ui\] delivery d-unparseable \(zvconv:nudge\) /);
    assert.doesNotMatch(lines[0]!, /example\.test|slack:/);
    assert.ok(!stream.events.join("").includes("event: delivery"), "no SSE for an undeliverable target");
  } finally {
    warnings.restore();
    await stream.close();
  }
});

test("the logged key kind stops at the first segment that is not a plain word", async () => {
  acks.length = 0;
  const warnings = captureWarnings();
  try {
    pending = [
      {
        id: "d-reach",
        idempotencyKey: `reach-denied:${EMAIL}|app|12`,
        createdAt: Date.now(),
        destination: { target: EMAIL },
      },
      { id: "d-bare", idempotencyKey: EMAIL, createdAt: Date.now(), destination: { target: "" } },
    ];
    await drainWebDeliveries();
    assert.deepEqual(acks, ["d-reach", "d-bare"]);
    assert.deepEqual(warnings.lines(), [
      "[web-ui] delivery d-reach (reach-denied) acking unsent: target is not a web thread",
      "[web-ui] delivery d-bare (unknown) acking unsent: target is not a web thread",
    ]);
  } finally {
    warnings.restore();
  }
});

test("a not-connected owner is not acked inside the give-up window, then acked with one warning", async () => {
  acks.length = 0;
  const warnings = captureWarnings();
  try {
    const delivery = {
      id: "d-offline",
      idempotencyKey: `zvconv:nudge:${EMAIL}:4:1`,
      createdAt: Date.now(),
      destination: { target: `web:${EMAIL}:thread-offline` },
    };
    pending = [delivery];
    await drainWebDeliveries();
    await drainWebDeliveries();
    assert.deepEqual(acks, []);
    assert.equal(warnings.lines().length, 0, "nothing is logged while the delivery waits");
    delivery.createdAt = Date.now() - 61_000;
    await drainWebDeliveries();
    assert.deepEqual(acks, ["d-offline"]);
    const lines = warnings.lines();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[web-ui\] delivery d-offline \(zvconv:nudge\) acking unsent: owner not connected$/);
  } finally {
    warnings.restore();
  }
});

test("a connected owner receives the nudge and the delivery is acked without a warning", async () => {
  acks.length = 0;
  const stream = await openDeliveryStream();
  const warnings = captureWarnings();
  try {
    pending = [
      {
        id: "d-connected",
        idempotencyKey: `zvconv:nudge:${EMAIL}:5:1`,
        createdAt: Date.now(),
        destination: { target: `web:${EMAIL}:thread-live` },
      },
    ];
    await drainWebDeliveries();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(acks, ["d-connected"]);
    assert.match(
      stream.events.join(""),
      /event: delivery\ndata: \{"threadRef":"web:alice@example\.test:thread-live"\}/,
    );
    assert.equal(warnings.lines().length, 0);
  } finally {
    warnings.restore();
    await stream.close();
  }
});

test("a recovery delivery is acked at once with no nudge and no warning", async () => {
  acks.length = 0;
  const stream = await openDeliveryStream();
  const warnings = captureWarnings();
  try {
    pending = [
      {
        id: "d-recovery",
        idempotencyKey: "run:r-1",
        createdAt: Date.now(),
        destination: { target: `web:${EMAIL}:thread-live` },
      },
    ];
    await drainWebDeliveries();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(acks, ["d-recovery"]);
    assert.ok(!stream.events.join("").includes("event: delivery"));
    assert.equal(warnings.lines().length, 0);
  } finally {
    warnings.restore();
    await stream.close();
  }
});
