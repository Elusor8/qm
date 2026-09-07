// Show a human the signed conversation their agent is holding (ELU-514).
//
// A conversation is opened from a QM thread, then every later turn arrives as a
// doorbell wake and runs in its own webhook session — so the thread the human is
// watching goes silent. This observes the ZipViz connector's traffic and posts
// each committed turn back into the surface the conversation was opened from.
//
// Three properties shape every decision below.
//
// It is downstream of the ledger. The turn is already committed in mailboxd
// before observe() is called, so the room post is a fallible VIEW of an
// authoritative event. Projection can fail, retry or be skipped entirely
// without the protocol noticing — and it must never be able to falsify a turn,
// strand a claim lease, or fail the tool call that carried it.
//
// It is deterministic, not model-driven. A model that forgets to post breaks
// the guarantee silently, so nothing here asks one to cooperate.
//
// It never assumes a conversation ends. Gary's runtime has no calendar tool and
// most live conversations are non-terminal, so projection is incremental and
// waits on no terminal turn.
import type { Destination, ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { principalDestination, reachEnqueue } from "../reach/reach.ts";
import { actorMayReadScope, destinationVisible, type VisibilityDeps } from "../triggers/trigger-visibility.ts";
import type { AgentConversationLinkStore } from "./agent-conversation-link-store.ts";
import { renderInboundTurn, renderOutboundTurn, type ConversationTurnFacts } from "./render-conversation-turn.ts";

/** Remote tool names on the ZipViz connector that carry a conversation event. */
const OPENS = new Set(["zipviz_conversation_open", "zipviz_conversation_adopt"]);
const SENDS = new Set([
  "zipviz_conversation_send",
  "zipviz_conversation_complete",
  "zipviz_conversation_fail",
  "zipviz_conversation_close",
]);
const CLAIMS = new Set(["zipviz_inbox_claim"]);

/** Destination types whose delivery drain actually renders text. */
const TEXT_SINKS = new Set(["slack", "principal", "group"]);

export interface ProjectionObservation {
  /** The namespaced tool name the model called. */
  name: string;
  args: Record<string, unknown>;
  /** The tool's result, unclamped (see McpToolCallOptions.onRawResult). */
  resultText: string;
}

export interface AgentConversationProjectorDeps extends VisibilityDeps {
  links: AgentConversationLinkStore;
  deliveries: DeliveryStore;
  toolDefs: () => readonly McpToolDescriptor[];
  /** The principal acting in the turn that is doing the observing. */
  owner: string;
  ownerScopeId: ScopeId;
  /** The observing thread — provenance only; NOT where projections are posted. */
  threadRef: string;
  sessionId: string;
  surface: string;
  /**
   * The live turn's default destination. Used only to REGISTER a conversation
   * opened from this surface; projections always post to the recorded one.
   */
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

export function createAgentConversationProjector(
  deps: AgentConversationProjectorDeps,
): AgentConversationProjector {
  function provenance(conversationId: string, turn: number) {
    return {
      trigger: "conversation" as const,
      surface: deps.surface,
      // The honest origin: the session that observed the turn, which for a
      // doorbell-driven turn is the webhook session, not the opener's thread.
      fireKey: `zvconv:${conversationId}:${turn}`,
      sourceScopeId: deps.ownerScopeId,
      sourceThreadRef: deps.threadRef,
      sourceSessionId: deps.sessionId,
    };
  }

  /**
   * Re-checked per projection, not once at registration: a person can leave a
   * channel mid-negotiation, and later turns must stop reaching them.
   */
  async function deliverable(owner: string, ownerScopeId: ScopeId, destination: Destination): Promise<boolean> {
    const { kind, ref } = parseScopeId(ownerScopeId);
    const home = await actorMayReadScope(deps, owner, kind, ref, ownerScopeId, false);
    if (destination.audienceScopeId === ownerScopeId && home.ok) return true;
    return destinationVisible(deps, owner, destination);
  }

  /** Tell the owner once that projections are being skipped, then stay quiet. */
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

  async function post(
    conversationId: string,
    direction: "in" | "out",
    turn: number,
    text: string,
    destination: Destination,
    owner: string,
    ownerScopeId: ScopeId,
  ): Promise<void> {
    if (!TEXT_SINKS.has(destination.type)) {
      // A `web` delivery is only an SSE nudge — its text is discarded by the
      // drain — so posting one would look successful and show the human
      // nothing. Recorded rather than pretended.
      await deps.links.noteSkip(conversationId, `surface ${destination.type} has no text delivery drain`);
      return;
    }
    if (!(await deliverable(owner, ownerScopeId, destination))) {
      await noticeOnce(conversationId, owner, "the destination is no longer visible to you");
      return;
    }
    await reachEnqueue({
      deliveries: deps.deliveries,
      destination,
      text,
      // Derived from protocol state, never from run or session identity, so a
      // retry from a fresh session collapses onto the same delivery.
      idempotencyKey: `zvconv:${direction}:${conversationId}:${turn}`,
      provenance: provenance(conversationId, turn),
    });
    await deps.links.advance(
      conversationId,
      direction === "in" ? { lastProjectedInTurn: turn } : { lastProjectedOutTurn: turn },
    );
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
      ...(deps.destination
        ? {}
        : { lastSkipNote: "opened from a turn with no destination; nothing to project into" }),
    });
  }

  async function projectOutbound(observation: ProjectionObservation): Promise<void> {
    const result = parseJson(observation.resultText);
    const snapshot = result?.snapshot as Record<string, unknown> | undefined;
    const conversationId = str(observation.args.conversation_id) ?? str(snapshot?.conversation_id);
    if (!conversationId) return;
    const link = await deps.links.get(conversationId);
    if (!link?.destination) return;

    // The message comes from the ARGS: they are ours and complete, whereas the
    // result may have been clamped. `snapshot.turns` is the committed count.
    const turnRecord = result?.turn as Record<string, unknown> | undefined;
    const message = str(observation.args.message) ?? str(turnRecord?.message) ?? "";
    const turn = num(snapshot?.turns) ?? (num(observation.args.expected_turn) ?? 0) + 1;
    const facts: ConversationTurnFacts = {
      conversationId,
      turn,
      intent: str(observation.args.intent) ?? "send",
      peer: link.peer,
    };
    await post(conversationId, "out", turn, renderOutboundTurn(facts, message), link.destination, link.owner, link.ownerScopeId);
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
        await post(conversationId, "in", turn, text, link.destination, link.owner, link.ownerScopeId);
        continue;
      }
      // A peer opened this one, so there is no opener thread to post into. The
      // mailbox owner still needs to see it, and a DM always has somewhere to
      // go — resolved from the principal, never reconstructed from a
      // surface-specific naming convention.
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
      // Best-effort by construction. The turn is already committed; a
      // projection failure must never reach the caller.
      try {
        const def = deps.toolDefs().find((d) => d.name === observation.name);
        if (!def?.agentConversations) return;
        if (OPENS.has(def.remoteName)) return void (await register(observation));
        if (SENDS.has(def.remoteName)) return void (await projectOutbound(observation));
        if (CLAIMS.has(def.remoteName)) return void (await projectInbound(observation));
      } catch {
        /* the ledger is authoritative; the room post is a fallible view of it */
      }
    },
  };
}
