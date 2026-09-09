import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

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
