import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { errMessage } from "../../../util/errors.ts";

export async function getProjectionCapture(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const capture = await ctx.deps.conversationProjection?.inspect(ctx.params.id!);
  if (!capture) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "conversation-capture.read",
    resource: ctx.params.id!,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, capture);
}

export async function recoverProjectionCapture(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  if (!ctx.deps.conversationProjection) return sendJson(ctx.res, 404, { error: "not_found" });
  try {
    await ctx.deps.conversationProjection.recover(ctx.params.id!);
    audit(ctx.deps, {
      principalId: actor.id,
      action: "conversation-capture.recover",
      resource: ctx.params.id!,
      scopeLabel: orgScope(ctx.deps),
    });
    return sendJson(ctx.res, 200, { queued: true });
  } catch (error) {
    return sendJson(ctx.res, 409, { error: errMessage(error) });
  }
}

export async function listProjectionCaptures(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  if (!ctx.deps.conversationProjection) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "conversation-capture.list",
    resource: "conversation-captures",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, await ctx.deps.conversationProjection.diagnostics());
}
