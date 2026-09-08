import type { AgentConversationLink } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { assertNoEscalation, buildTriggerBase, type CreateTriggerInput } from "../triggers/trigger-store.ts";
import { personKey } from "../directory/person.ts";

export type AgentConversationIdentity = Pick<AgentConversationLink, "conversationId" | "mailbox" | "owner">;

export function agentConversationLinkId(identity: AgentConversationIdentity): string {
  return JSON.stringify([identity.mailbox.trim().toLowerCase(), personKey(identity.owner), identity.conversationId]);
}

interface CreateAgentConversationLinkInput extends CreateTriggerInput {
  conversationId: string;
  mailbox: string;
  peer?: string;
  externalThreadRef?: string;
  openerThreadRef: string;
  openerSessionId: string;
  surface: string;
  lastSkipNote?: string;
}

export interface AgentConversationLinkStore {
  record(input: CreateAgentConversationLinkInput): Promise<AgentConversationLink>;
  get(identity: AgentConversationIdentity): Promise<AgentConversationLink | null>;
  list(): Promise<AgentConversationLink[]>;
  advance(
    identity: AgentConversationIdentity,
    fields: { lastProjectedInTurn?: number; lastProjectedOutTurn?: number },
  ): Promise<void>;
  noteSkip(identity: AgentConversationIdentity, note: string, opts?: { notifiedOwner?: boolean }): Promise<void>;
}

export function createAgentConversationLinkStore(
  backing: DurableMap<AgentConversationLink> = createMemoryMap<AgentConversationLink>(),
): AgentConversationLinkStore {
  return {
    async record(input) {
      assertNoEscalation(input);
      const link: AgentConversationLink = {
        ...buildTriggerBase(input, agentConversationLinkId(input), Date.now()),
        conversationId: input.conversationId,
        mailbox: input.mailbox.trim().toLowerCase(),
        ...(input.peer !== undefined ? { peer: input.peer } : {}),
        ...(input.externalThreadRef !== undefined ? { externalThreadRef: input.externalThreadRef } : {}),
        openerThreadRef: input.openerThreadRef,
        openerSessionId: input.openerSessionId,
        surface: input.surface,
        ...(input.lastSkipNote !== undefined ? { lastSkipNote: input.lastSkipNote } : {}),
      };
      return backing.putIfAbsent(link.id, link);
    },
    get: (identity) => backing.get(agentConversationLinkId(identity)),
    list: () => backing.all(),
    async advance(identity, fields) {
      if (!backing.update) throw new Error("agent conversation links require atomic update support");
      await backing.update(agentConversationLinkId(identity), (link) => ({
        ...link,
        ...(fields.lastProjectedInTurn !== undefined
          ? { lastProjectedInTurn: Math.max(link.lastProjectedInTurn ?? 0, fields.lastProjectedInTurn) }
          : {}),
        ...(fields.lastProjectedOutTurn !== undefined
          ? { lastProjectedOutTurn: Math.max(link.lastProjectedOutTurn ?? 0, fields.lastProjectedOutTurn) }
          : {}),
      }));
    },
    async noteSkip(identity, note, opts) {
      const id = agentConversationLinkId(identity);
      if (!opts?.notifiedOwner) {
        await backing.merge(id, { lastSkipNote: note });
        return;
      }
      if (!backing.update) throw new Error("agent conversation links require atomic update support");
      await backing.update(id, (link) => ({
        ...link,
        lastSkipNote: note,
        ...(link.ownerNotifiedAt === undefined ? { ownerNotifiedAt: Date.now() } : {}),
      }));
    },
  };
}
