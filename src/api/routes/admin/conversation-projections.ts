import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import type { ProjectionReaderAudience } from "../../../conversations/conversation-projection-reader-store.ts";

export async function listConversationProjectionState(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  if (!ctx.deps.conversationProjection) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "conversation-projection.list",
    resource: "conversation-projections",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, await ctx.deps.conversationProjection.diagnostics());
}

export async function releaseConversationProjectionGap(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  if (!ctx.deps.conversationProjection) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const audience = isObj(body.audience) ? body.audience : {};
  const fields = ["mailbox", "adapterKind", "adapterInstance", "externalScope", "externalPrincipalRef"] as const;
  if (fields.some((field) => typeof audience[field] !== "string") || typeof body.msgId !== "string")
    return sendJson(ctx.res, 400, { error: "bad_request", message: "audience and msgId required" });
  if (typeof body.reason !== "string" || body.reason.trim().length < 8)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "an explicit operator reason is required" });
  const released = await ctx.deps.conversationProjection.releaseGap(
    audience as unknown as ProjectionReaderAudience,
    body.msgId,
    `operator ${actor.id}: ${body.reason.trim()}`,
  );
  if (!released) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "conversation-projection.gap-release",
    resource: body.msgId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
