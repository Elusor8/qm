import type { Destination, ScopeId } from "../types.ts";
import type { McpCallObservation, McpToolService } from "../mcp/mcp-tool-service.ts";
import type { McpServer, McpServerStore } from "../mcp/mcp-server-store.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { errMessage, swallow } from "../util/errors.ts";
import {
  createAgentConversationProjector,
  type AgentConversationProjectorDeps,
} from "./agent-conversation-projector.ts";
import type { ConversationProjectionEvent } from "./conversation-projection-event.ts";
import {
  createMemoryProjectionReaderStore,
  projectionReaderAudienceKey,
  type ProjectionOutboxJob,
  type ProjectionReaderAudience,
  type ProjectionReaderStore,
  type ProjectionSkipMarker,
} from "./conversation-projection-reader-store.ts";

const PAGE_SIZE = 50;
const MAX_PAGES_PER_SWEEP = 4;
const PENDING_BINDING_LIMIT = 64;
const RECONCILE_INTERVAL_MS = 5_000;
const PROJECTION_TOOLS = new Set([
  "zipviz_conversation_open",
  "zipviz_conversation_adopt",
  "zipviz_conversation_send",
  "zipviz_conversation_complete",
  "zipviz_conversation_fail",
  "zipviz_conversation_close",
  "zipviz_inbox_claim",
]);

interface ProjectionContext {
  owner: string;
  ownerScopeId: ScopeId;
  threadRef: string;
  sessionId: string;
  surface: string;
  destination?: Destination;
}

export interface ProjectionPendingBinding extends ProjectionContext {
  id: string;
  serverId: string;
  mailbox: string;
  externalThreadRef: string;
  createdAt: number;
}

interface ProjectionJobPayload {
  event: ConversationProjectionEvent;
  context: ProjectionContext;
  destinationRevision: number;
}

interface ProjectionEventsPage {
  events: unknown[];
  skipped: unknown[];
  next_cursor: string | null;
  high_water_cursor: string | null;
  has_more: boolean;
}

export interface AgentConversationProjectionService {
  hint(context: ProjectionContext, call: McpCallObservation): Promise<void>;
  sweep(): Promise<void>;
  diagnostics(): Promise<{
    readers: Array<{
      audience: ProjectionReaderAudience;
      afterCursor: string | null;
      version: number;
      recoveryCode?: string;
      skips: ProjectionSkipMarker[];
    }>;
    pendingBindings: ProjectionPendingBinding[];
    outbox: ProjectionOutboxJob[];
  }>;
  start(): void;
  stop(): Promise<void>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unwrapUntrusted(value: string): string {
  const firstEnd = value.indexOf("\n");
  const secondEnd = value.indexOf("\n", firstEnd + 1);
  if (firstEnd < 1 || secondEnd < firstEnd) throw new Error("untrusted projection wrapper is malformed");
  const boundary = /^\[UNTRUSTED AGENT RESPONSE boundary=([0-9a-f-]{36})\]$/.exec(value.slice(0, firstEnd))?.[1];
  const policy = value.slice(firstEnd + 1, secondEnd);
  if (!boundary || !policy.startsWith("[source=") || !policy.endsWith("]"))
    throw new Error("untrusted projection wrapper is malformed");
  const suffix = `\n[END UNTRUSTED AGENT RESPONSE boundary=${boundary}]`;
  if (!value.endsWith(suffix)) throw new Error("untrusted projection wrapper boundary does not close");
  return value.slice(secondEnd + 1, -suffix.length);
}

function projectionEvent(value: unknown, audience: ProjectionReaderAudience): ConversationProjectionEvent {
  const row = object(value);
  const signed = object(row?.signed);
  const receipt = object(row?.receipt);
  const correlation = object(row?.correlation);
  const timing = object(row?.timing);
  if (
    !row ||
    row.source !== "zipviz-signed-v3" ||
    row.authoritative !== true ||
    row.mailbox !== audience.mailbox ||
    !string(row.event_id) ||
    !Number.isSafeInteger(row.projection_revision) ||
    !string(row.conversation_id) ||
    !Number.isSafeInteger(row.turn) ||
    (row.side !== "us" && row.side !== "them") ||
    !string(row.from) ||
    !string(row.to) ||
    !string(row.msg_id) ||
    typeof row.body !== "string" ||
    !string(row.ledger_status) ||
    !signed ||
    signed.envelope_v !== 3 ||
    !receipt ||
    !correlation ||
    !timing ||
    correlation.adapter_kind !== audience.adapterKind ||
    correlation.adapter_instance !== audience.adapterInstance ||
    correlation.external_scope !== audience.externalScope ||
    !string(correlation.external_conversation_ref)
  )
    throw new Error("projection event does not match its authorized reader audience");
  const side = row.side as "us" | "them";
  const body = side === "them" ? unwrapUntrusted(row.body) : row.body;
  const humanSummary =
    side === "them" && typeof signed.human_summary === "string"
      ? unwrapUntrusted(signed.human_summary)
      : (signed.human_summary as string | null);
  return {
    ...(row as unknown as ConversationProjectionEvent),
    body,
    signed: { ...(signed as ConversationProjectionEvent["signed"]), human_summary: humanSummary },
  };
}

function skipMarker(value: unknown): ProjectionSkipMarker {
  const row = object(value);
  if (
    !row ||
    !Number.isSafeInteger(row.projection_revision) ||
    !string(row.msg_id) ||
    !["E_RETAINED_EVENT_GAP", "E_PROOF_UNAVAILABLE"].includes(String(row.code))
  )
    throw new Error("projection skip marker is malformed");
  return { projectionRevision: Number(row.projection_revision), msgId: String(row.msg_id), code: String(row.code) };
}

function page(value: string): ProjectionEventsPage {
  const parsed = object(JSON.parse(value));
  if (parsed?.error) throw Object.assign(new Error(String(parsed.error)), { code: parsed.code });
  if (
    !parsed ||
    !Array.isArray(parsed.events) ||
    !Array.isArray(parsed.skipped) ||
    typeof parsed.has_more !== "boolean" ||
    (parsed.next_cursor !== null && typeof parsed.next_cursor !== "string") ||
    (parsed.high_water_cursor !== null && typeof parsed.high_water_cursor !== "string")
  )
    throw new Error("projection feed page is malformed");
  return parsed as unknown as ProjectionEventsPage;
}

function audienceFor(server: McpServer): ProjectionReaderAudience | null {
  if (!server.enabled || !server.zipviz) return null;
  return {
    mailbox: server.zipviz.mailbox.trim().toLowerCase(),
    adapterKind: server.zipviz.adapterKind,
    adapterInstance: server.zipviz.adapterInstance,
    externalScope: "thread",
    externalPrincipalRef: server.zipviz.actorExternalId,
  };
}

export function createAgentConversationProjectionService(
  deps: Pick<
    AgentConversationProjectorDeps,
    "links" | "deliveries" | "projectionSessions" | "directory" | "identity" | "managedGroups"
  > & {
    leaderLease: LeaderLease;
    mcpServers: McpServerStore;
    mcp: McpToolService;
    readers?: ProjectionReaderStore;
    pendingBindings?: DurableMap<ProjectionPendingBinding>;
  },
): AgentConversationProjectionService {
  const readers = deps.readers ?? createMemoryProjectionReaderStore();
  const pendingBindings = deps.pendingBindings ?? createMemoryMap<ProjectionPendingBinding>();
  let stopping = false;
  let inFlight: Promise<void> | undefined;

  async function trimPending(): Promise<void> {
    const entries = (await pendingBindings.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of entries.slice(0, Math.max(0, entries.length - PENDING_BINDING_LIMIT)))
      await pendingBindings.delete(id);
  }

  async function hint(context: ProjectionContext, call: McpCallObservation): Promise<void> {
    const binding = call.conversationBinding;
    if (!binding || !call.serverId || !call.runtimeContext || !PROJECTION_TOOLS.has(binding.remoteName)) return;
    if (["zipviz_conversation_open", "zipviz_conversation_adopt"].includes(binding.remoteName)) {
      const id = JSON.stringify([call.serverId, binding.mailbox, context.owner, call.runtimeContext.threadRef]);
      await pendingBindings.put(id, {
        ...structuredClone(context),
        id,
        serverId: call.serverId,
        mailbox: binding.mailbox.trim().toLowerCase(),
        externalThreadRef: call.runtimeContext.threadRef,
        createdAt: Date.now(),
      });
      await trimPending();
    }
    void sweep().catch((error) => swallow("conversation projection hint", error));
  }

  async function contexts(server: McpServer): Promise<ProjectionPendingBinding[]> {
    const pending = (await pendingBindings.all()).filter((row) => row.serverId === server.id);
    const links = (await deps.links.list())
      .filter((link) => link.owner === server.zipviz?.actorPrincipalId && link.mailbox === server.zipviz.mailbox)
      .map((link) => ({
        id: `link:${link.id}`,
        serverId: server.id,
        mailbox: link.mailbox,
        owner: link.owner,
        ownerScopeId: link.ownerScopeId,
        threadRef: link.openerThreadRef,
        externalThreadRef: link.externalThreadRef ?? link.openerThreadRef,
        sessionId: link.openerSessionId,
        surface: link.surface,
        ...(link.destination ? { destination: link.destination } : {}),
        createdAt: link.createdAt,
      }));
    return [...pending, ...links];
  }

  async function linkFor(
    server: McpServer,
    event: ConversationProjectionEvent,
    candidates: ProjectionPendingBinding[],
  ) {
    const identity = {
      mailbox: event.mailbox,
      owner: server.zipviz!.actorPrincipalId,
      conversationId: event.conversation_id,
    };
    const existing = await deps.links.get(identity);
    if (existing) return existing;
    const context = candidates.find(
      (row) => row.externalThreadRef === event.correlation.external_conversation_ref && row.owner === identity.owner,
    );
    if (!context) return null;
    const link = await deps.links.record({
      ...identity,
      createdBy: context.owner,
      ownerScopeId: context.ownerScopeId,
      peer: event.side === "us" ? event.to : event.from,
      externalThreadRef: event.correlation.external_conversation_ref,
      openerThreadRef: context.threadRef,
      openerSessionId: context.sessionId,
      surface: context.surface,
      ...(context.destination ? { destination: context.destination } : {}),
    });
    await pendingBindings.delete(context.id);
    return link;
  }

  async function readAudience(server: McpServer, candidates: ProjectionPendingBinding[]): Promise<void> {
    const audience = audienceFor(server);
    const context = candidates[0];
    if (!audience || !context || !server.zipviz) return;
    for (let pages = 0; pages < MAX_PAGES_PER_SWEEP && !stopping; pages += 1) {
      const checkpoint = await readers.get(audience);
      let result: ProjectionEventsPage;
      try {
        result = page(
          await deps.mcp.call(
            `${server.id}_zipviz_conversation_projection_events`,
            {
              mailbox: audience.mailbox,
              limit: PAGE_SIZE,
              ...(checkpoint.afterCursor ? { after_cursor: checkpoint.afterCursor } : {}),
            },
            {
              principalId: server.zipviz.actorPrincipalId,
              runtimeContext: {
                actorId: server.zipviz.actorPrincipalId,
                threadRef: context.externalThreadRef,
                nativeEventId: "projection-ledger-reconcile",
              },
            },
          ),
        );
      } catch (error) {
        const code = String((error as { code?: unknown }).code ?? "");
        if (code === "E_STALE_CURSOR" || code === "E_BAD_CURSOR") {
          await readers.reset(audience, checkpoint.version, code, errMessage(error));
          return;
        }
        throw error;
      }
      const jobs: ProjectionOutboxJob[] = [];
      const quarantined: ProjectionSkipMarker[] = [];
      for (const candidate of result.events) {
        try {
          const event = projectionEvent(candidate, audience);
          const link = await linkFor(server, event, candidates);
          if (!link) continue;
          const destinationRevision = link.createdAt;
          const payload: ProjectionJobPayload = {
            event,
            context: {
              owner: link.owner,
              ownerScopeId: link.ownerScopeId,
              threadRef: link.openerThreadRef,
              sessionId: link.openerSessionId,
              surface: link.surface,
              ...(link.destination ? { destination: link.destination } : {}),
            },
            destinationRevision,
          };
          jobs.push({
            id: JSON.stringify([projectionReaderAudienceKey(audience), event.event_id, destinationRevision]),
            audienceKey: projectionReaderAudienceKey(audience),
            eventId: event.event_id,
            projectionRevision: event.projection_revision,
            destinationRevision,
            payload,
            createdAt: Date.now(),
            availableAt: 0,
            attempts: 0,
          });
        } catch (error) {
          const row = object(candidate);
          quarantined.push({
            projectionRevision: Number(row?.projection_revision ?? 0),
            msgId: String(row?.msg_id ?? "unknown"),
            code: `E_INVALID_PROJECTION_EVENT:${errMessage(error)}`.slice(0, 512),
          });
        }
      }
      const skips = [...result.skipped.map(skipMarker), ...quarantined];
      const replacement = result.has_more ? result.next_cursor : result.high_water_cursor;
      const afterCursor =
        replacement ?? (result.events.length || result.skipped.length ? checkpoint.afterCursor : undefined);
      const accepted = await readers.acceptPage({
        audience,
        expectedVersion: checkpoint.version,
        jobs,
        skips,
        afterCursor,
      });
      if (!accepted || !result.has_more) return;
    }
  }

  async function dispatchOutbox(): Promise<void> {
    for (const job of await readers.pending(32, Date.now())) {
      try {
        const payload = job.payload as ProjectionJobPayload;
        const event = payload.event;
        const link = await deps.links.get({
          owner: payload.context.owner,
          mailbox: event.mailbox,
          conversationId: event.conversation_id,
        });
        if (!link) throw new Error("projection binding no longer exists");
        const stableDeliveryKey = `zvconv:event:${event.event_id}:destination:${payload.destinationRevision}`;
        const existingDelivery = await deps.deliveries.getByKey(stableDeliveryKey);
        const lastTurn = Math.max(link.lastProjectedInTurn ?? 0, link.lastProjectedOutTurn ?? 0);
        if (!existingDelivery && event.turn !== lastTurn + 1) {
          await readers.defer(
            job.id,
            job.projectionRevision,
            Date.now() + RECONCILE_INTERVAL_MS,
            event.turn < lastTurn
              ? `refusing reverse-order turn ${event.turn} after ${lastTurn}`
              : `waiting for turn ${lastTurn + 1} before ${event.turn}`,
          );
          continue;
        }
        const projector = createAgentConversationProjector({ ...deps, ...payload.context, toolDefs: () => [] });
        await projector.projectEvent(event, link, payload.destinationRevision);
        await readers.ack(job.id, job.projectionRevision);
      } catch (error) {
        await readers.defer(job.id, job.projectionRevision, Date.now() + 1_000, errMessage(error));
        swallow("conversation projection outbox", error);
      }
    }
  }

  function sweep(): Promise<void> {
    if (inFlight) return inFlight;
    if (stopping) return Promise.resolve();
    const work = deps.leaderLease
      .hold("conversation-projection-ledger", async (lost) => {
        let leaseLost = false;
        void lost.then(() => {
          leaseLost = true;
        });
        for (const server of await deps.mcpServers.list()) {
          if (leaseLost || stopping) break;
          const candidates = await contexts(server);
          if (candidates.length)
            await readAudience(server, candidates).catch((error) =>
              swallow(`conversation projection reader ${server.id}`, error),
            );
        }
        if (!leaseLost && !stopping) await dispatchOutbox();
      })
      .then(() => undefined);
    inFlight = work.finally(() => {
      inFlight = undefined;
    });
    return work;
  }

  const sweeper = createSweeper(sweep, RECONCILE_INTERVAL_MS, {
    immediate: true,
    label: "conversation ledger projections",
  });
  return {
    hint,
    sweep,
    async diagnostics() {
      const checkpoints = await Promise.all(
        (await deps.mcpServers.list()).map(async (server) => {
          const audience = audienceFor(server);
          if (!audience) return null;
          const checkpoint = await readers.get(audience);
          return {
            audience,
            afterCursor: checkpoint.afterCursor,
            version: checkpoint.version,
            ...(checkpoint.recoveryCode ? { recoveryCode: checkpoint.recoveryCode } : {}),
            skips: await readers.skips(audience),
          };
        }),
      );
      return {
        readers: checkpoints.filter((row): row is NonNullable<typeof row> => row !== null),
        pendingBindings: await pendingBindings.all(),
        outbox: await readers.pending(100, Number.MAX_SAFE_INTEGER),
      };
    },
    start() {
      stopping = false;
      sweeper.start();
    },
    async stop() {
      stopping = true;
      sweeper.stop();
      await inFlight;
    },
  };
}
