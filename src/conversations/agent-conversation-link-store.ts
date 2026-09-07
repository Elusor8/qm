// Where a signed ZipViz conversation was opened from, so its later turns can be
// shown to the human who started it (ELU-514).
//
// Modelled on MonitorStore: a monitor records owner, scope, threadRef and
// destination when it is armed, and every later tick replays them. Same
// discipline, keyed by conversation instead of by process — a doorbell webhook
// is 1:N over conversations, so the binding cannot live on the trigger.
import type { AgentConversationLink } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { assertNoEscalation, buildTriggerBase, type CreateTriggerInput } from "../triggers/trigger-store.ts";

export interface CreateAgentConversationLinkInput extends CreateTriggerInput {
  conversationId: string;
  mailbox: string;
  peer: string;
  externalThreadRef?: string;
  openerThreadRef: string;
  openerSessionId: string;
  surface: string;
  lastSkipNote?: string;
}

export interface AgentConversationLinkStore {
  /**
   * Idempotent on conversationId: a conversation is opened once, but the
   * observation that opens it can be replayed, and a replay must not mint a
   * second binding or overwrite the destination already recorded.
   */
  record(input: CreateAgentConversationLinkInput): Promise<AgentConversationLink>;
  get(conversationId: string): Promise<AgentConversationLink | null>;
  list(): Promise<AgentConversationLink[]>;
  advance(
    conversationId: string,
    fields: { lastProjectedInTurn?: number; lastProjectedOutTurn?: number },
  ): Promise<void>;
  noteSkip(conversationId: string, note: string, opts?: { notifiedOwner?: boolean }): Promise<void>;
}

export function createAgentConversationLinkStore(
  backing: DurableMap<AgentConversationLink> = createMemoryMap<AgentConversationLink>(),
): AgentConversationLinkStore {
  return {
    async record(input) {
      assertNoEscalation(input);
      const existing = await backing.get(input.conversationId);
      if (existing) return existing;
      const link: AgentConversationLink = {
        // The conversation id IS the key, so it replaces the generated trigger
        // id: two records for one conversation is the bug this prevents.
        ...buildTriggerBase(input, input.conversationId, Date.now()),
        conversationId: input.conversationId,
        mailbox: input.mailbox,
        peer: input.peer,
        ...(input.externalThreadRef !== undefined ? { externalThreadRef: input.externalThreadRef } : {}),
        openerThreadRef: input.openerThreadRef,
        openerSessionId: input.openerSessionId,
        surface: input.surface,
        ...(input.lastSkipNote !== undefined ? { lastSkipNote: input.lastSkipNote } : {}),
      };
      await backing.put(link.conversationId, link);
      return link;
    },
    get: (conversationId) => backing.get(conversationId),
    list: () => backing.all(),
    async advance(conversationId, fields) {
      const link = await backing.get(conversationId);
      if (!link) return;
      await backing.put(conversationId, {
        ...link,
        ...(fields.lastProjectedInTurn !== undefined ? { lastProjectedInTurn: fields.lastProjectedInTurn } : {}),
        ...(fields.lastProjectedOutTurn !== undefined ? { lastProjectedOutTurn: fields.lastProjectedOutTurn } : {}),
      });
    },
    async noteSkip(conversationId, note, opts) {
      const link = await backing.get(conversationId);
      if (!link) return;
      await backing.put(conversationId, {
        ...link,
        lastSkipNote: note,
        // Set once and never cleared: the owner is told the first time a
        // projection is refused, not on every turn of a long negotiation.
        ...(opts?.notifiedOwner && link.ownerNotifiedAt === undefined ? { ownerNotifiedAt: Date.now() } : {}),
      });
    },
  };
}
