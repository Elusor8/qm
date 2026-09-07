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
      const link: AgentConversationLink = {
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
      return backing.putIfAbsent(link.conversationId, link);
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
        ...(opts?.notifiedOwner && link.ownerNotifiedAt === undefined ? { ownerNotifiedAt: Date.now() } : {}),
      });
    },
  };
}
