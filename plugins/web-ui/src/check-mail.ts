export interface CheckMailCandidate {
  sessionId: string | null;
  scopeId: string | null;
}

export function checkMailSessionId(
  user: string | undefined,
  splitActive: boolean,
  focusedPane: CheckMailCandidate | undefined,
  main: CheckMailCandidate,
): string | null {
  const active = splitActive ? focusedPane : main;
  if (!active?.sessionId) return null;
  return active.scopeId === `personal:${user ?? ""}` ? active.sessionId : null;
}
