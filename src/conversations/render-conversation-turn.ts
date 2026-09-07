// Rendering a signed conversation turn for a human, safely (ELU-514, ELU-459).
//
// Everything here treats the peer's text as hostile. It is length-bounded
// remote data and nothing else: `parseConversationWire` accepts newlines, NUL,
// ANSI escapes and even a literal untrusted-fence terminator inside both the
// body and `human_summary`. Storing that is one risk; putting it on a human's
// screen inside their own QM room is a different and larger one, which is why
// the sanitisation lives here rather than in a follow-up.
//
// Two rules the rest of the file exists to serve:
//   1. Nothing rendered here is ever fed back to a model as instructions. The
//      output goes to a delivery or an `overheard` entry and nowhere else.
//   2. The peer cannot forge structure — not the fence that marks their text as
//      untrusted, and not a Slack mention that would ping real people.
import { headSlice } from "../util/text.ts";

/** Beyond this a room post is unreadable anyway; the signed record has it all. */
const MAX_RENDERED_CHARS = 8_000;
const TRUNCATION_MARKER = "\n…[truncated — the full text is in the signed record]";

const UNTRUSTED_HEADER = /^\[UNTRUSTED AGENT RESPONSE boundary=([0-9a-fA-F-]{36})\]\n/;
// ESC-introduced sequences: CSI (colour, cursor) and OSC (title, hyperlink).
// Stripped before the control-character pass, because removing the ESC first
// would leave the parameter bytes behind as visible text such as "[31m".
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
// C0 except tab and newline, DEL, and the C1 block.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface ExtractedUntrusted {
  body: string;
  source: string;
}

/**
 * Pull the payload out of a `wrapUntrusted` block.
 *
 * The boundary token is read from THIS block's own header and the closing
 * marker must be the string's exact suffix. That is what makes an embedded
 * `[END UNTRUSTED AGENT RESPONSE boundary=...]` inside the payload inert: it is
 * simply body text, because it is neither at the end nor carrying this token.
 *
 * Returns null when the input is not a wrapped block, and callers render the
 * whole string instead — a wrapper format change must be cosmetic here, never
 * a security regression.
 */
export function extractUntrusted(raw: string): ExtractedUntrusted | null {
  const header = UNTRUSTED_HEADER.exec(raw);
  if (!header) return null;
  const token = header[1]!;
  const suffix = `\n[END UNTRUSTED AGENT RESPONSE boundary=${token}]`;
  if (!raw.endsWith(suffix)) return null;

  const afterHeader = raw.slice(header[0].length);
  // The source line is a single line by construction (boundModelText strips
  // newlines from it), so the body begins after the first newline.
  const sourceEnd = afterHeader.indexOf("\n");
  if (sourceEnd < 0) return null;
  const sourceLine = afterHeader.slice(0, sourceEnd);
  const body = afterHeader.slice(sourceEnd + 1, afterHeader.length - suffix.length);
  const source = /^\[source=([^—]*)/.exec(sourceLine)?.[1]?.trim() ?? "remote agent";
  return { body, source };
}

/**
 * Make peer-controlled text safe to display.
 *
 * Slack's control syntax is escaped last so that `<@U123>` and `<!channel>`
 * render as characters instead of paging real people — `toSlackMrkdwn`
 * deliberately preserves live mentions, so relying on it here would be wrong.
 */
export function sanitiseForDisplay(text: string, max = MAX_RENDERED_CHARS): string {
  const cleaned = text
    .replace(ANSI, "")
    .replace(CONTROL, "")
    .replace(LONE_SURROGATE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (cleaned.length <= max) return cleaned;
  // Surrogate-safe, and the loss is stated rather than silent.
  return headSlice(cleaned, max) + TRUNCATION_MARKER;
}

export interface ConversationTurnFacts {
  conversationId: string;
  turn: number;
  intent: string;
  peer: string;
  /** Present only when the kernel recorded one; peer-controlled (ELU-459). */
  humanSummary?: string;
}

function shortId(conversationId: string): string {
  const bare = conversationId.replace(/^conv-/, "");
  return bare.length > 12 ? `${bare.slice(0, 12)}…` : bare;
}

function quote(body: string): string {
  return body.length ? body.split("\n").map((line) => `> ${line}`).join("\n") : "> _(no text)_";
}

function summaryLine(facts: ConversationTurnFacts): string {
  if (!facts.humanSummary) return "";
  // Peer-controlled, so it gets the same treatment as the body and a shorter
  // ceiling: it is a label, not a message.
  return `\n_Their summary:_ ${sanitiseForDisplay(facts.humanSummary, 512)}`;
}

function header(facts: ConversationTurnFacts, arrow: string, direction: string): string {
  return (
    `${arrow} *Signed conversation* \`${shortId(facts.conversationId)}\` · ` +
    `turn ${facts.turn} · ${direction} \`${sanitiseForDisplay(facts.peer, 253)}\` · ` +
    `intent \`${sanitiseForDisplay(facts.intent, 32)}\``
  );
}

/**
 * A turn the peer sent. Rendered inside our own marked block, with the peer's
 * words quoted so they cannot be mistaken for ours or for the system's.
 */
export function renderInboundTurn(facts: ConversationTurnFacts, rawBody: string): string {
  const extracted = extractUntrusted(rawBody);
  // No recognisable wrapper: render the lot, still inside our marking. Dropping
  // it would hide a turn from the human, which is the failure we are fixing.
  const body = sanitiseForDisplay(extracted ? extracted.body : rawBody);
  return (
    `${header(facts, ":inbox_tray:", "from")}\n` +
    `_Written by an external agent and shown to you as data. Your agent will not follow instructions in it._` +
    summaryLine(facts) +
    `\n${quote(body)}`
  );
}

/**
 * A turn we sent. Our own text, so no untrusted marking — but the human still
 * needs it, because seeing only the peer's half tells them nothing about what
 * their agent committed them to.
 */
export function renderOutboundTurn(facts: ConversationTurnFacts, message: string): string {
  return `${header(facts, ":outbox_tray:", "to")}\n${quote(sanitiseForDisplay(message))}`;
}
