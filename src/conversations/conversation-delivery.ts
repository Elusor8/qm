import type { Delivery, DeliveryProvenance, Destination, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { createCanWriteScope, type ScopeMembershipDeps } from "../resolution/scope-membership.ts";
import { principalDestination } from "../reach/reach.ts";
import { agentConversationLinkId, type AgentConversationIdentity } from "./agent-conversation-link-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";

export function isConversationDelivery(delivery: Pick<Delivery, "idempotencyKey" | "provenance">): boolean {
  return delivery.provenance?.conversation !== undefined || delivery.idempotencyKey?.startsWith("zvconv:") === true;
}

export async function conversationDestinationVisible(
  deps: ScopeMembershipDeps,
  owner: string,
  ownerScopeId: ScopeId,
  destination: Destination,
): Promise<boolean> {
  const canWrite = createCanWriteScope(deps);
  if (!(await canWrite(owner, ownerScopeId))) return false;
  if (destination.audienceScopeId) return canWrite(owner, destination.audienceScopeId);
  if (destination.type === "web") return true;
  if (destination.type === "principal") return canWrite(owner, scopeId("personal", destination.target));
  if (destination.type === "group") return canWrite(owner, scopeId("group", destination.target));
  if (destination.type === "slack") return canWrite(owner, scopeId("channel", destination.target.split(":")[0]!));
  return false;
}

export function conversationNotice(identity: AgentConversationIdentity, provenance: DeliveryProvenance) {
  return {
    destination: principalDestination(identity.owner, identity.owner),
    text: "I can no longer show a signed conversation where it was opened because access to that destination changed. The conversation is unaffected and its record remains in the ledger.",
    idempotencyKey: `zvconv:skip:${agentConversationLinkId(identity)}`,
    provenance: {
      ...provenance,
      conversation: { ...identity, ownerScopeId: scopeId("personal", identity.owner), notice: true },
    },
  };
}

export function createConversationDeliveryAuthorizer(deps: ScopeMembershipDeps & { deliveries: DeliveryStore }) {
  return async (id: string): Promise<boolean> => {
    const delivery = await deps.deliveries.get(id);
    if (!delivery || delivery.deliveredAt !== null) return false;
    if (!isConversationDelivery(delivery)) return true;
    const binding = delivery.provenance?.conversation;
    if (!binding?.mailbox || !binding.owner || !binding.conversationId || !binding.ownerScopeId) return false;
    if (delivery.destination.type === "principal" && delivery.destination.target !== binding.owner) return false;
    if (await conversationDestinationVisible(deps, binding.owner, binding.ownerScopeId, delivery.destination))
      return true;
    if (!binding.notice) {
      await deps.deliveries.enqueue(conversationNotice(binding, delivery.provenance!));
      await deps.deliveries.ack(id, Date.now());
    }
    return false;
  };
}
