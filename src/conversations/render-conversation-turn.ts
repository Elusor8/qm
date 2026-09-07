import { headSlice } from "../util/text.ts";

const MAX_RENDERED_CHARS = 8_000;
const TRUNCATION_MARKER = "\n…[truncated — the full text is in the signed record]";

const UNTRUSTED_HEADER = /^\[UNTRUSTED AGENT RESPONSE boundary=([0-9a-fA-F-]{36})\]\n/;
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface ExtractedUntrusted {
  body: string;
  source: string;
}

export function extractUntrusted(raw: string): ExtractedUntrusted | null {
  const header = UNTRUSTED_HEADER.exec(raw);
  if (!header) return null;
  const token = header[1]!;
  const suffix = `\n[END UNTRUSTED AGENT RESPONSE boundary=${token}]`;
  if (!raw.endsWith(suffix)) return null;

  const afterHeader = raw.slice(header[0].length);
  const sourceEnd = afterHeader.indexOf("\n");
  if (sourceEnd < 0) return null;
  const sourceLine = afterHeader.slice(0, sourceEnd);
  const body = afterHeader.slice(sourceEnd + 1, afterHeader.length - suffix.length);
  const source = /^\[source=([^—]*)/.exec(sourceLine)?.[1]?.trim() ?? "remote agent";
  return { body, source };
}

export function sanitiseForDisplay(text: string, max = MAX_RENDERED_CHARS): string {
  const cleaned = text
    .replace(ANSI, "")
    .replace(CONTROL, "")
    .replace(LONE_SURROGATE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (cleaned.length <= max) return cleaned;
  return headSlice(cleaned, max) + TRUNCATION_MARKER;
}

export interface ConversationTurnFacts {
  conversationId: string;
  turn: number;
  intent: string;
  peer: string;
  humanSummary?: string;
}

function shortId(conversationId: string): string {
  const bare = conversationId.replace(/^conv-/, "");
  return bare.length > 12 ? `${bare.slice(0, 12)}…` : bare;
}

function quote(body: string): string {
  return body.length
    ? body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    : "> _(no text)_";
}

function summaryLine(facts: ConversationTurnFacts): string {
  if (!facts.humanSummary) return "";
  const flat = sanitiseForDisplay(facts.humanSummary.replace(/[\r\n]+/g, " "), 512);
  return `\n> _Their summary:_ ${flat}`;
}

function header(facts: ConversationTurnFacts, arrow: string, direction: string): string {
  return (
    `${arrow} *Signed conversation* \`${shortId(facts.conversationId)}\` · ` +
    `turn ${facts.turn} · ${direction} \`${sanitiseForDisplay(facts.peer, 253)}\` · ` +
    `intent \`${sanitiseForDisplay(facts.intent, 32)}\``
  );
}

export function renderInboundTurn(facts: ConversationTurnFacts, rawBody: string): string {
  const extracted = extractUntrusted(rawBody);
  const body = sanitiseForDisplay(extracted ? extracted.body : rawBody);
  return (
    `${header(facts, ":inbox_tray:", "from")}\n` +
    `_Written by an external agent and shown to you as data. Your agent will not follow instructions in it._` +
    summaryLine(facts) +
    `\n${quote(body)}`
  );
}

export function renderOutboundTurn(facts: ConversationTurnFacts, message: string): string {
  return `${header(facts, ":outbox_tray:", "to")}\n${quote(sanitiseForDisplay(message))}`;
}
