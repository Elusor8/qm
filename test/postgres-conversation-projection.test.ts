import { exerciseProjectionFairness } from "./projection-fairness-contract.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresLeaderLease } from "../src/persistence/leader-lease.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createAgentConversationLinkStore } from "../src/conversations/agent-conversation-link-store.ts";
import {
  createAgentConversationProjectionService,
  type ProjectionProgress,
} from "../src/conversations/agent-conversation-projection-service.ts";
import type { AgentConversationLink } from "../src/types.ts";

const url = process.env.DATABASE_URL;

test(
  "Postgres projection survives writer shutdown, held lease, new stores and concurrent workers",
  { skip: url ? false : "requires isolated DATABASE_URL" },
  async (t) => {
    const owner = "U1";
    const mailbox = "alice.example.viz";
    const conversationId = `conv-${randomUUID()}`;
    const side = { owner, mailbox, conversationId };
    const make = () => {
      const maps = createPostgresMapFactory(url!);
      const links = createAgentConversationLinkStore(maps.map<AgentConversationLink>("agent_conversation_links"));
      const sessions = createPostgresSessionStore(url!);
      const deliveries = createPostgresDeliveryStore(url!);
      const service = createAgentConversationProjectionService({
        links,
        deliveries,
        projectionSessions: sessions,
        progress: maps.map<ProjectionProgress>("agent_conversation_projection_progress"),
        leaderLease: createPostgresLeaderLease(maps.pool),
      });
      t.after(async () => {
        await service.stop();
        await maps.pool.close();
      });
      return { links, sessions, deliveries, service };
    };
    const writer = make();
    const session = await writer.sessions.getOrCreateByThread(
      `web:U1:${conversationId}`,
      "dm",
      "personal:U1",
      undefined,
      "web",
    );
    const context = {
      owner,
      ownerScopeId: "personal:U1",
      threadRef: session.threadRef,
      sessionId: session.id,
      surface: "web",
      destination: { type: "web", target: session.threadRef, audienceScopeId: "personal:U1" },
    };
    const observation = {
      name: "open",
      args: { mailbox },
      raw: {
        conversationBinding: { owner, mailbox, remoteName: "zipviz_conversation_open" },
        text: JSON.stringify({
          snapshot: { conversation_id: conversationId, turns: 1, peer: "bob.example.viz" },
          turn: { message: "committed", conversation: { id: conversationId, turn: 1, intent: "propose" } },
        }),
      },
    };
    const { lease } = await writer.sessions.acquireLease(session.id, "turn");
    assert.ok(lease);
    await writer.service.capture(context, observation);
    await writer.service.sweep();
    assert.equal((await writer.sessions.getEntries(session.id)).length, 0);
    await writer.service.stop();
    await writer.sessions.releaseLease(lease);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const reader = make();
    const competitor = make();
    t.mock.method(reader.sessions, "getEntries", async () => {
      throw new Error("full transcript scan forbidden");
    });
    t.mock.method(competitor.sessions, "getEntries", async () => {
      throw new Error("full transcript scan forbidden");
    });
    await Promise.all([reader.service.sweep(), competitor.service.sweep()]);
    assert.equal((await writer.sessions.getEntries(session.id)).length, 1);
    await reader.service.capture(context, observation);
    await competitor.service.sweep();
    assert.equal((await writer.sessions.getEntries(session.id)).length, 1);
    const nudges = (await writer.deliveries.pending("web")).filter(
      (delivery) => delivery.destination.target === session.threadRef,
    );
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]!.text, "");
    await Promise.all([
      reader.links.advance(side, { lastProjectedOutTurn: 4 }),
      competitor.links.advance(side, { lastProjectedOutTurn: 2 }),
    ]);
    assert.equal((await writer.links.get(side))!.lastProjectedOutTurn, 4);
  },
);

test(
  "Postgres bounded retries remain fair across workers",
  { skip: url ? false : "requires isolated DATABASE_URL" },
  async (t) => {
    const maps = createPostgresMapFactory(url!);
    t.after(() => maps.pool.close());
    await exerciseProjectionFairness({
      links: createAgentConversationLinkStore(maps.map<AgentConversationLink>("agent_conversation_links")),
      deliveries: createPostgresDeliveryStore(url!),
      projectionSessions: createPostgresSessionStore(url!),
      progress: maps.map<ProjectionProgress>("agent_conversation_projection_progress"),
      leaderLease: createPostgresLeaderLease(maps.pool),
    });
  },
);
