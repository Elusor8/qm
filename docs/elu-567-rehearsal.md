# ELU-567 rehearsal checklist

The mail icon posts a hidden, `triggered: true` turn into the chat that is already open on
screen — not a new session. Automated turns skip `mode-conversation`
(`src/core/orchestrator.ts` ~line 853) and are automation-origin, which the security screen
treats as untrusted content. Watch for, live, in that order:

- **Does the hidden turn ever become visible?** The click should add nothing to the
  transcript — no "Check ZipViz mail." bubble, no flash of it before it disappears. Check
  immediately after the click, and again after a full page reload of the same chat.
- **Does it survive session search / history?** Search for "Check ZipViz mail" or "mail"
  from the chat search palette and from any history/export view — it must not surface there
  either.
- **Does the reply read differently from a typed turn?** Compare the agent's response tone
  and length against a normal typed message earlier in the same chat — automation-origin can
  clip replies or change voice; note any difference.
- **Does an approval or quarantine prompt appear?** The security screen treats this turn as
  untrusted; watch for an unexpected approval card or a quarantined/blocked-looking reply.
- **Does the chat's row change unexpectedly?** Watch the sidebar for the chat jumping order,
  its title changing, or a "working" dot appearing/disappearing oddly around the click.
- **Is the icon inert outside a personal chat?** It should be disabled with no open chat, and
  it must refuse (403, no visible effect) if aimed at a shared/group chat.
