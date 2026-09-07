// The "may this actor still reach this place?" gates, shared rather than
// duplicated.
//
// Two callers now ask the same question: runTrigger, before delivering a
// trigger's reply, and the agent-conversation projector, before posting a
// signed turn into the surface that opened the conversation (ELU-514). A second
// implementation would drift, and drift here means either a delivery to a
// channel someone has left or a refusal to deliver one they can still see.
//
// Deps are structural, so this module does not import TriggerDeps and
// TriggerDeps does not have to know about it.
import type { Destination, ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { isVisible, type VisibilityDirectory } from "../directory/visibility.ts";
import { samePerson } from "../directory/person.ts";

export const MEMBERSHIP_SKIP_NOTE =
  "the acting person is no longer a member of this trigger's home scope — run skipped";
export const UNKNOWN_HOME_SKIP_NOTE =
  "this trigger's home scope is missing from the directory snapshot (roster sync gap) and the acting person has no session there — run skipped";

export interface VisibilityDeps {
  directory?: VisibilityDirectory & {
    get(principalId: string): Promise<{ displayName: string } | null>;
    channelPrivacy?(channelId: string): Promise<boolean | undefined>;
    groupMembership?(groupId: string, principalId: string): Promise<boolean | undefined>;
  };
  sessions?: { listByParticipant(principalId: string): Promise<readonly { scopeId: ScopeId }[]> };
}

async function participatesInScope(deps: VisibilityDeps, actorId: string, scope: ScopeId): Promise<boolean> {
  const sessions = await deps.sessions?.listByParticipant(actorId).catch(() => []);
  return sessions?.some((s) => s.scopeId === scope) === true;
}

export async function actorMayReadScope(
  deps: VisibilityDeps,
  actorId: string,
  kind: string | null,
  ref: string,
  scope: ScopeId,
  snapshotGap: boolean,
): Promise<{ ok: boolean; note?: string }> {
  if (!ref) return { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  if (kind === "personal") return samePerson(actorId, ref) ? { ok: true } : { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  if (!deps.directory)
    return kind !== "group" && kind !== "channel" ? { ok: true } : { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  if (kind === "group") {
    if (await isVisible(deps.directory, actorId, { kind: "group", groupId: ref })) return { ok: true };
    if (snapshotGap) {
      if (await participatesInScope(deps, actorId, scope)) return { ok: true };
      return { ok: false, note: UNKNOWN_HOME_SKIP_NOTE };
    }
    const known = await deps.directory.groupMembership?.(ref, actorId).catch(() => undefined);
    if (known === undefined && (await participatesInScope(deps, actorId, scope))) return { ok: true };
    return { ok: false, note: MEMBERSHIP_SKIP_NOTE };
  }
  if (kind !== "channel") return { ok: true };
  const isPrivate = await deps.directory.channelPrivacy?.(ref);
  if (isPrivate === undefined) {
    if (await participatesInScope(deps, actorId, scope)) return { ok: true };
    return { ok: false, note: UNKNOWN_HOME_SKIP_NOTE };
  }
  if (await isVisible(deps.directory, actorId, { kind: "channel", channelId: ref, isPrivate })) return { ok: true };
  return { ok: false, note: MEMBERSHIP_SKIP_NOTE };
}

export async function destinationVisible(
  deps: VisibilityDeps,
  actorId: string,
  destination: Destination,
): Promise<boolean> {
  if (!deps.directory) return true;
  const id = destination.target.split(":")[0]!;
  if (destination.type === "slack") {
    const audience = destination.audienceScopeId ? parseScopeId(destination.audienceScopeId) : undefined;
    if (audience?.kind === "personal") return isVisible(deps.directory, actorId, { kind: "dm", ownerId: audience.ref });
    if (audience?.kind === "group") return isVisible(deps.directory, actorId, { kind: "group", groupId: id });
    return isVisible(deps.directory, actorId, { kind: "channel", channelId: id });
  }
  if (destination.type === "group") return isVisible(deps.directory, actorId, { kind: "group", groupId: id });
  return true;
}
