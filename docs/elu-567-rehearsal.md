# ELU-567 rehearsal checklist

The mail icon posts a hidden, `triggered: true` turn into the chat that is already open on
screen — not a new session. Triggered turns are automation-origin: they skip
`mode-conversation` (`src/core/orchestrator.ts` ~line 853), run with `xhigh` thinking and
fast mode off, and use the fallback mode prompt. The canned trigger text itself is not
security-screened; the inbound mail the agent fetches is, exactly as when the cue is typed.
Watch for, live, in that order:

- **Does the hidden turn ever become visible?** The click should add nothing to the
  transcript — no "Check ZipViz mail." bubble, no flash of it before it disappears. Check
  immediately after the click, and again after a full page reload of the same chat.
- **Does it survive session search / history?** Search for "Check ZipViz mail" or "mail"
  from the chat search palette and from any history/export view. Chat search does not yet
  filter hidden entries (separate core change), so expect the seed to surface there; keep
  the search palette out of frame during filming.
- **Is the click path slower than the typed cue?** Time click → first token against typing
  "Check ZipViz mail." in the same chat. `xhigh` thinking with fast mode off can add several
  seconds before the reply starts; if the gap is visible on camera, type the cue instead.
- **Does the reply read differently from a typed turn?** Compare the agent's response tone
  and length against a normal typed message earlier in the same chat — the fallback prompt
  can clip replies or change voice; note any difference.
- **Does an approval or quarantine prompt appear?** Keychain consent and secret drops return
  403 on triggered turns, so if mail handling needs a grant the agent cannot ask for it in
  this turn; watch for an unexpected approval card or a blocked-looking reply.
- **Does the icon follow the active chat?** It should enable as soon as a personal chat is
  opened from the sidebar, and in split view it must post into the focused pane.
- **Does the chat's row change unexpectedly?** Watch the sidebar for the chat jumping order,
  its title changing, or a "working" dot appearing/disappearing oddly around the click.
- **Is the icon inert outside a personal chat?** It should be disabled with no open chat, and
  it must refuse (403, no visible effect) if aimed at a shared/group chat.
