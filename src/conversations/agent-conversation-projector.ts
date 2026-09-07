import { conversationDestinationVisible, conversationNotice } from "./conversation-delivery.ts";
import type { AgentConversationLink, Destination, ScopeId, Session } from "../types.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { principalDestination, reachEnqueue } from "../reach/reach.ts";
import type { VisibilityDeps } from "../triggers/trigger-visibility.ts";
import { createCanWriteScope, type ScopeMembershipDeps } from "../resolution/scope-membership.ts";
import type { Lease, NewEntry } from "../sessions/session-store.ts";
import { swallow } from "../util/errors.ts";
import {
  agentConversationLinkId,
  type AgentConversationIdentity,
  type AgentConversationLinkStore,
} from "./agent-conversation-link-store.ts";
import { renderInboundTurn, renderOutboundTurn, type ConversationTurnFacts } from "./render-conversation-turn.ts";

const OPENS = new Set(["zipviz_conversation_open", "zipviz_conversation_adopt"]);
const SENDS = new Set([
  "zipviz_conversation_send",
  "zipviz_conversation_complete",
  "zipviz_conversation_fail",
  "zipviz_conversation_close",
]);
const CLAIMS = new Set(["zipviz_inbox_claim"]);

const TEXT_SINKS = new Set(["slack", "principal", "group"]);

export interface ProjectionObservation {
  name: string;
  args: Record<string, unknown>;
  resultText: string;
}

interface ProjectionSessions {
  getByThread(threadRef: string): Promise<Session | null>;
  acquireLease(
    sessionId: string,
    holder?: "turn" | "compaction" | "fork" | "backfill",
  ): Promise<{ lease: Lease | null }>;
  releaseLease(lease: Lease): Promise<void>;
  append(lease: Lease, entry: NewEntry): Promise<unknown>;
  hasProjectionMarker?(sessionId: string, ts: string): Promise<boolean>;
  getEntries(
    sessionId: string,
    opts?: { sinceSeq?: number },
  ): Promise<ReadonlyArray<{ type: string; payload: unknown }>>;
}

export interface AgentConversationProjectorDeps
  extends VisibilityDeps, Pick<ScopeMembershipDeps, "identity" | "managedGroups"> {
  links: AgentConversationLinkStore;
  deliveries: DeliveryStore;
  projectionSessions?: ProjectionSessions;
  toolDefs: () => readonly McpToolDescriptor[];
  owner: string;
  ownerScopeId: ScopeId;
  threadRef: string;
  sessionId: string;
  surface: string;
  destination?: Destination;
}

export interface AgentConversationProjector {
  observe(observation: ProjectionObservation): Promise<void>;
  project(observation: ProjectionObservation): Promise<void>;
  register(observation: ProjectionObservation, remoteName: string): Promise<AgentConversationLink | null>;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectionMarker(identity: AgentConversationIdentity, turn: number): string {
  return `zvconv:${agentConversationLinkId(identity)}:${turn}`;
}

export function createAgentConversationProjector(deps: AgentConversationProjectorDeps): AgentConversationProjector {
  const canWriteScope = createCanWriteScope(deps);

  function side(
    observation: ProjectionObservation,
    conversationId: string,
    result?: Record<string, unknown> | null,
  ): AgentConversationIdentity | null {
    const snapshot = result?.snapshot as Record<string, unknown> | undefined;
    const mailbox = str(observation.args.mailbox) ?? str(result?.mailbox) ?? str(snapshot?.mailbox);
    if (!mailbox) return null;
    return { conversationId, mailbox, owner: deps.owner };
  }

  function provenance(identity: AgentConversationIdentity, turn: number, ownerScopeId = deps.ownerScopeId) {
    return {
      trigger: "conversation" as const,
      conversation: {
        conversationId: identity.conversationId,
        mailbox: identity.mailbox,
        owner: identity.owner,
        ownerScopeId,
        sideKey: agentConversationLinkId(identity),
        turn,
      },
      surface: deps.surface,
      fireKey: projectionMarker(identity, turn),
      sourceScopeId: deps.ownerScopeId,
      sourceThreadRef: deps.threadRef,
      sourceSessionId: deps.sessionId,
    };
  }

  async function deliverable(owner: string, ownerScopeId: ScopeId, destination: Destination): Promise<boolean> {
    return conversationDestinationVisible(deps, owner, ownerScopeId, destination);
  }

  async function noticeOnce(identity: AgentConversationIdentity, note: string): Promise<void> {
    const link = await deps.links.get(identity);
    if (link?.ownerNotifiedAt !== undefined) {
      await deps.links.noteSkip(identity, note);
      return;
    }
    await deps.links.noteSkip(identity, note);
    await deps.deliveries.enqueue(conversationNotice(identity, provenance(identity, 0)));
    await deps.links.noteSkip(identity, note, { notifiedOwner: true });
  }

  async function postToSession(link: AgentConversationLink, turn: number, text: string): Promise<boolean> {
    const sessions = deps.projectionSessions;
    if (!sessions) return false;
    const session = await sessions.getByThread(link.openerThreadRef);
    if (!session || session.id !== link.openerSessionId) return false;

    let lease: Lease | null = null;
    for (let attempt = 0; attempt < 5 && !lease; attempt += 1) {
      lease = (await sessions.acquireLease(session.id, "backfill")).lease;
      if (!lease) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!lease) return false;
    const marker = projectionMarker(link, turn);
    try {
      if (
        !(await canWriteScope(link.owner, session.scopeId)) ||
        !link.destination ||
        !(await deliverable(link.owner, link.ownerScopeId, link.destination))
      )
        return false;
      const already = sessions.hasProjectionMarker
        ? await sessions.hasProjectionMarker(session.id, marker)
        : (await sessions.getEntries(session.id)).some(
            (entry) => entry.type === "user" && (entry.payload as { ts?: unknown } | null)?.ts === marker,
          );
      if (!already) {
        await sessions.append(lease, {
          type: "user",
          payload: {
            kind: "agent_conversation_projection",
            overheard: true,
            ts: marker,
            name: `signed conversation with ${link.peer ?? "the peer"}`,
            text,
          },
          scopeLabel: link.ownerScopeId,
        });
      }
    } finally {
      await sessions.releaseLease(lease);
    }
    await deps.deliveries.enqueue({
      destination: { type: "web", target: link.openerThreadRef },
      text: "",
      idempotencyKey: `zvconv:nudge:${agentConversationLinkId(link)}:${turn}`,
    });
    return true;
  }

  async function post(link: AgentConversationLink, direction: "in" | "out", turn: number, text: string): Promise<void> {
    const destination = link.destination;
    if (!destination) return;
    const advance = () =>
      deps.links.advance(link, direction === "in" ? { lastProjectedInTurn: turn } : { lastProjectedOutTurn: turn });

    if (!(await deliverable(link.owner, link.ownerScopeId, destination))) {
      await noticeOnce(link, "the destination is no longer visible to you");
      return;
    }
    if (!TEXT_SINKS.has(destination.type)) {
      if (await postToSession(link, turn, text)) {
        await advance();
        return;
      }
      await deps.links.noteSkip(link, `could not project into the ${destination.type} surface`);
      throw new Error(`could not project into the ${destination.type} surface`);
    }
    await reachEnqueue({
      deliveries: deps.deliveries,
      destination,
      text,
      idempotencyKey: `zvconv:${direction}:${agentConversationLinkId(link)}:${turn}`,
      provenance: provenance(link, turn, link.ownerScopeId),
    });
    await advance();
  }

  async function register(
    observation: ProjectionObservation,
    remoteName: string,
  ): Promise<AgentConversationLink | null> {
    const result = parseJson(observation.resultText);
    if (!result || result.error) return null;
    const snapshot = result?.snapshot as Record<string, unknown> | undefined;
    const adopted = remoteName === "zipviz_conversation_adopt" && result.binding_role === "ingress-owner";
    const conversationId = adopted ? str(result.conversation_id) : str(snapshot?.conversation_id);
    if (!conversationId) return null;
    if (remoteName === "zipviz_conversation_adopt" && !adopted) return null;
    const identity = side(observation, conversationId, result);
    if (!identity) return null;
    const peer = str(snapshot?.peer) ?? str(observation.args.peer);

    return deps.links.record({
      ...identity,
      createdBy: deps.owner,
      ownerScopeId: deps.ownerScopeId,
      ...(peer ? { peer } : {}),
      ...(str(observation.args.external_thread_ref)
        ? { externalThreadRef: str(observation.args.external_thread_ref)! }
        : {}),
      openerThreadRef: deps.threadRef,
      openerSessionId: deps.sessionId,
      surface: deps.surface,
      ...(deps.destination ? { destination: deps.destination } : {}),
      ...(deps.destination ? {} : { lastSkipNote: "opened from a turn with no destination; nothing to project into" }),
    });
  }

  async function postToOwner(
    identity: AgentConversationIdentity,
    direction: "in" | "out",
    turn: number,
    text: string,
  ): Promise<void> {
    await reachEnqueue({
      deliveries: deps.deliveries,
      destination: principalDestination(identity.owner, identity.owner),
      text,
      idempotencyKey: `zvconv:${direction}:${agentConversationLinkId(identity)}:${turn}`,
      provenance: provenance(identity, turn),
    });
  }

  async function projectOutbound(observation: ProjectionObservation, remoteName: string): Promise<void> {
    const result = parseJson(observation.resultText);
    if (result?.error) return;
    const snapshot = result?.snapshot as Record<string, unknown> | undefined;
    const conversationId = str(observation.args.conversation_id) ?? str(snapshot?.conversation_id);
    if (!conversationId) return;
    const identity = side(observation, conversationId, result);
    if (!identity) return;
    const link = await deps.links.get(identity);

    const turnRecord = result?.turn as Record<string, unknown> | undefined;
    const signed = turnRecord?.conversation as Record<string, unknown> | undefined;
    const message = str(turnRecord?.message) ?? str(observation.args.message) ?? "";
    const turn = num(signed?.turn) ?? num(snapshot?.turns) ?? (num(observation.args.expected_turn) ?? 0) + 1;
    const defaultIntent =
      remoteName === "zipviz_conversation_open" ? "propose" : remoteName.slice("zipviz_conversation_".length);
    const requestedIntent =
      remoteName === "zipviz_conversation_open" || remoteName === "zipviz_conversation_send"
        ? str(observation.args.intent)
        : undefined;
    const facts: ConversationTurnFacts = {
      conversationId,
      turn,
      intent: str(signed?.intent) ?? requestedIntent ?? defaultIntent,
      peer: str(snapshot?.peer) ?? str(observation.args.peer) ?? link?.peer ?? "the peer",
    };
    const text = renderOutboundTurn(facts, message);
    if (link) await post(link, "out", turn, text);
    else await postToOwner(identity, "out", turn, text);
  }

  async function projectInbound(observation: ProjectionObservation): Promise<void> {
    const result = parseJson(observation.resultText);
    const claimed = Array.isArray(result?.claimed) ? (result.claimed as Record<string, unknown>[]) : [];
    for (const row of claimed) {
      const conversation = row.conversation as Record<string, unknown> | undefined;
      const conversationId = str(conversation?.conversation_id);
      const turn = num(conversation?.turn);
      if (!conversationId || turn === undefined) continue;
      const identity = side(observation, conversationId, result);
      if (!identity) continue;

      const facts: ConversationTurnFacts = {
        conversationId,
        turn,
        intent: str(conversation?.intent) ?? "turn",
        peer: str(row.from) ?? str(conversation?.peer) ?? "the peer",
        ...(str(conversation?.human_summary) ? { humanSummary: str(conversation!.human_summary)! } : {}),
      };
      const text = renderInboundTurn(facts, str(row.body) ?? "");

      const link = await deps.links.get(identity);
      if (link) {
        await post(link, "in", turn, text);
        continue;
      }
      await postToOwner(identity, "in", turn, text);
    }
  }

  async function project(observation: ProjectionObservation): Promise<void> {
    const def = deps.toolDefs().find((d) => d.name === observation.name);
    if (!def?.agentConversations) return;
    if (OPENS.has(def.remoteName)) {
      const link = await register(observation, def.remoteName);
      if (link && def.remoteName === "zipviz_conversation_open") await projectOutbound(observation, def.remoteName);
      return;
    }
    if (SENDS.has(def.remoteName)) return projectOutbound(observation, def.remoteName);
    if (CLAIMS.has(def.remoteName)) return projectInbound(observation);
  }

  return {
    project,
    register,
    async observe(observation) {
      try {
        await project(observation);
      } catch (e) {
        swallow("agent conversation projection", e);
      }
    },
  };
}
