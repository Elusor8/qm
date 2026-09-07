import type { AgentConversationLink, Destination, ScopeId, Session } from "../types.ts";
import { parseScopeId } from "../types.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { principalDestination, reachEnqueue } from "../reach/reach.ts";
import { actorMayReadScope, destinationVisible, type VisibilityDeps } from "../triggers/trigger-visibility.ts";
import type { Lease, NewEntry } from "../sessions/session-store.ts";
import type { AgentConversationLinkStore } from "./agent-conversation-link-store.ts";
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

export interface ProjectionSessions {
  getByThread(threadRef: string): Promise<Session | null>;
  acquireLease(
    sessionId: string,
    holder?: "turn" | "compaction" | "fork" | "backfill",
  ): Promise<{ lease: Lease | null }>;
  releaseLease(lease: Lease): Promise<void>;
  append(lease: Lease, entry: NewEntry): Promise<unknown>;
  getEntries(
    sessionId: string,
    opts?: { sinceSeq?: number },
  ): Promise<ReadonlyArray<{ type: string; payload: unknown }>>;
}

export interface AgentConversationProjectorDeps extends VisibilityDeps {
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

function projectionMarker(conversationId: string, turn: number): string {
  return `zvconv:${conversationId}:${turn}`;
}

export function createAgentConversationProjector(deps: AgentConversationProjectorDeps): AgentConversationProjector {
  function provenance(conversationId: string, turn: number) {
    return {
      trigger: "conversation" as const,
      surface: deps.surface,
      fireKey: `zvconv:${conversationId}:${turn}`,
      sourceScopeId: deps.ownerScopeId,
      sourceThreadRef: deps.threadRef,
      sourceSessionId: deps.sessionId,
    };
  }

  async function deliverable(owner: string, ownerScopeId: ScopeId, destination: Destination): Promise<boolean> {
    const { kind, ref } = parseScopeId(ownerScopeId);
    const home = await actorMayReadScope(deps, owner, kind, ref, ownerScopeId, false);
    if (destination.audienceScopeId === ownerScopeId && home.ok) return true;
    return destinationVisible(deps, owner, destination);
  }

  async function noticeOnce(conversationId: string, owner: string, note: string): Promise<void> {
    const link = await deps.links.get(conversationId);
    if (link?.ownerNotifiedAt !== undefined) {
      await deps.links.noteSkip(conversationId, note);
      return;
    }
    await deps.links.noteSkip(conversationId, note, { notifiedOwner: true });
    await deps.deliveries.enqueue({
      destination: principalDestination(owner, owner),
      text:
        `I can no longer show you the signed conversation \`${conversationId}\` where it was opened — ${note}. ` +
        `The conversation itself is unaffected and the full record is still in the ledger.`,
      idempotencyKey: `zvconv:skip:${conversationId}`,
    });
  }

  async function postToSession(link: AgentConversationLink, turn: number, text: string): Promise<boolean> {
    const sessions = deps.projectionSessions;
    if (!sessions) return false;
    const session = await sessions.getByThread(link.openerThreadRef);
    if (!session) return false;

    let lease: Lease | null = null;
    for (let attempt = 0; attempt < 5 && !lease; attempt += 1) {
      lease = (await sessions.acquireLease(session.id, "backfill")).lease;
      if (!lease) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!lease) return false;
    const marker = projectionMarker(link.conversationId, turn);
    try {
      const already = (await sessions.getEntries(session.id)).some(
        (entry) => entry.type === "user" && (entry.payload as { ts?: unknown } | null)?.ts === marker,
      );
      if (already) return true;
      await sessions.append(lease, {
        type: "user",
        payload: {
          overheard: true,
          ts: marker,
          name: `signed conversation with ${link.peer}`,
          text,
        },
        scopeLabel: link.ownerScopeId,
      });
    } finally {
      await sessions.releaseLease(lease);
    }
    await deps.deliveries.enqueue({
      destination: { type: "web", target: link.openerThreadRef },
      text: "",
      idempotencyKey: `zvconv:nudge:${link.conversationId}:${turn}`,
    });
    return true;
  }

  async function post(link: AgentConversationLink, direction: "in" | "out", turn: number, text: string): Promise<void> {
    const destination = link.destination;
    if (!destination) return;
    const conversationId = link.conversationId;
    const advance = () =>
      deps.links.advance(
        conversationId,
        direction === "in" ? { lastProjectedInTurn: turn } : { lastProjectedOutTurn: turn },
      );

    if (!TEXT_SINKS.has(destination.type)) {
      if (await deliverable(link.owner, link.ownerScopeId, destination)) {
        if (await postToSession(link, turn, text)) {
          await advance();
          return;
        }
      }
      await deps.links.noteSkip(conversationId, `could not project into the ${destination.type} surface`);
      return;
    }
    if (!(await deliverable(link.owner, link.ownerScopeId, destination))) {
      await noticeOnce(conversationId, link.owner, "the destination is no longer visible to you");
      return;
    }
    await reachEnqueue({
      deliveries: deps.deliveries,
      destination,
      text,
      idempotencyKey: `zvconv:${direction}:${conversationId}:${turn}`,
      provenance: provenance(conversationId, turn),
    });
    await advance();
  }

  async function register(observation: ProjectionObservation): Promise<void> {
    const result = parseJson(observation.resultText);
    const snapshot = result?.snapshot as Record<string, unknown> | undefined;
    const conversationId = str(snapshot?.conversation_id) ?? str(observation.args.conversation_id);
    if (!conversationId) return;
    const mailbox = str(observation.args.mailbox) ?? str(snapshot?.mailbox);
    const peer = str(snapshot?.peer) ?? str(observation.args.peer);
    if (!mailbox || !peer) return;

    await deps.links.record({
      owner: deps.owner,
      createdBy: deps.owner,
      ownerScopeId: deps.ownerScopeId,
      conversationId,
      mailbox,
      peer,
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

  async function projectOutbound(observation: ProjectionObservation): Promise<void> {
    const result = parseJson(observation.resultText);
    const snapshot = result?.snapshot as Record<string, unknown> | undefined;
    const conversationId = str(observation.args.conversation_id) ?? str(snapshot?.conversation_id);
    if (!conversationId) return;
    const link = await deps.links.get(conversationId);
    if (!link?.destination) return;

    const turnRecord = result?.turn as Record<string, unknown> | undefined;
    const message = str(observation.args.message) ?? str(turnRecord?.message) ?? "";
    const turn = num(snapshot?.turns) ?? (num(observation.args.expected_turn) ?? 0) + 1;
    const facts: ConversationTurnFacts = {
      conversationId,
      turn,
      intent: str(observation.args.intent) ?? "send",
      peer: link.peer,
    };
    await post(link, "out", turn, renderOutboundTurn(facts, message));
  }

  async function projectInbound(observation: ProjectionObservation): Promise<void> {
    const result = parseJson(observation.resultText);
    const claimed = Array.isArray(result?.claimed) ? (result.claimed as Record<string, unknown>[]) : [];
    for (const row of claimed) {
      const conversation = row.conversation as Record<string, unknown> | undefined;
      const conversationId = str(conversation?.conversation_id);
      const turn = num(conversation?.turn);
      if (!conversationId || turn === undefined) continue;

      const facts: ConversationTurnFacts = {
        conversationId,
        turn,
        intent: str(conversation?.intent) ?? "turn",
        peer: str(row.from) ?? str(conversation?.peer) ?? "the peer",
        ...(str(conversation?.human_summary) ? { humanSummary: str(conversation!.human_summary)! } : {}),
      };
      const text = renderInboundTurn(facts, str(row.body) ?? "");

      const link = await deps.links.get(conversationId);
      if (link?.destination) {
        await post(link, "in", turn, text);
        continue;
      }
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: principalDestination(deps.owner, deps.owner),
        text,
        idempotencyKey: `zvconv:in:${conversationId}:${turn}`,
        provenance: provenance(conversationId, turn),
      });
    }
  }

  return {
    async observe(observation) {
      try {
        const def = deps.toolDefs().find((d) => d.name === observation.name);
        if (!def?.agentConversations) return;
        if (OPENS.has(def.remoteName)) return void (await register(observation));
        if (SENDS.has(def.remoteName)) return void (await projectOutbound(observation));
        if (CLAIMS.has(def.remoteName)) return void (await projectInbound(observation));
      } catch {}
    },
  };
}
