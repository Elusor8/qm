import { randomUUID } from "node:crypto";
import type { Destination, ScopeId } from "../types.ts";
import type { McpRawResult, McpCallObservation, McpCallObserver } from "../mcp/mcp-tool-service.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { agentConversationLinkId } from "./agent-conversation-link-store.ts";
import {
  createAgentConversationProjector,
  type AgentConversationProjectorDeps,
  type ProjectionObservation,
} from "./agent-conversation-projector.ts";

const CAPTURE_TYPE = "conversation-capture";
const QUARANTINE_TYPE = "conversation-projection-quarantine";
const QUEUE_TYPE = "conversation-projection";
const TOOLS = new Set([
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

export interface ProjectionProgress {
  lastTurn: number;
  baselineTurn: number;
  lastSkipNote?: string;
  initializing?: boolean;
  initialCaptures?: string[];
}

export interface ProjectionCapture {
  context: ProjectionContext;
  call: McpCallObservation;
  raw?: McpRawResult;
  state: "awaiting-result" | "captured" | "queued" | "rejected" | "uncertain";
  createdAt: number;
  error?: string;
}

export interface ProjectionCaptureMailbox {
  pending: string[];
}

class InvalidCapture extends Error {}

interface ProjectionJob {
  context: ProjectionContext;
  observation: ProjectionObservation;
  remoteName: string;
  mailbox: string;
  conversationId: string;
  turn: number;
}

export interface AgentConversationProjectionService {
  begin(context: ProjectionContext, call: McpCallObservation): Promise<McpCallObserver | undefined>;
  recover(captureId: string): Promise<void>;
  inspect(captureId: string): Promise<ProjectionCapture | null>;
  diagnostics(): Promise<{
    captures: Array<{ id: string; state: string; error?: string }>;
    quarantined: Array<{ id: string; sourceId: string; error: string }>;
  }>;

  capture(
    context: ProjectionContext,
    observation: { name: string; args: Record<string, unknown>; raw: McpRawResult },
  ): Promise<void>;
  sweep(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createAgentConversationProjectionService(
  deps: Pick<
    AgentConversationProjectorDeps,
    "links" | "deliveries" | "projectionSessions" | "directory" | "identity" | "managedGroups"
  > & {
    progress: DurableMap<ProjectionProgress>;
    leaderLease: LeaderLease;
    captures?: DurableMap<ProjectionCapture>;
    captureMailboxes?: DurableMap<ProjectionCaptureMailbox>;
  },
): AgentConversationProjectionService {
  const captures = deps.captures ?? createMemoryMap<ProjectionCapture>();
  const captureMailboxes = deps.captureMailboxes ?? createMemoryMap<ProjectionCaptureMailbox>();
  let stopping = false;
  let inFlight: Promise<void> | undefined;

  function projectorFor(job: ProjectionJob) {
    return createAgentConversationProjector({
      ...deps,
      ...job.context,
      toolDefs: () => [
        {
          name: job.observation.name,
          remoteName: job.remoteName,
          serverId: "captured",
          description: "",
          inputSchema: {},
          readOnly: false,
          agentConversations: true,
        },
      ],
    });
  }

  function mailboxKey(call: McpCallObservation): string {
    const binding = call.conversationBinding!;
    return JSON.stringify([binding.mailbox.trim().toLowerCase(), binding.owner]);
  }

  async function releaseCapture(id: string, record: ProjectionCapture): Promise<void> {
    if (!captureMailboxes.update) throw new Error("capture mailboxes require atomic update support");
    await captureMailboxes.update(mailboxKey(record.call), (value) => ({
      pending: value.pending.filter((v) => v !== id),
    }));
  }

  async function quarantine(delivery: { id: string; text: string }, error: unknown): Promise<void> {
    await deps.deliveries.enqueue({
      destination: { type: QUARANTINE_TYPE, target: delivery.id },
      idempotencyKey: `zvconv:quarantine:${delivery.id}`,
      text: JSON.stringify({ sourceId: delivery.id, sourceText: delivery.text, error: errMessage(error) }),
    });
    await deps.deliveries.ack(delivery.id, Date.now());
  }

  async function processCapture(id: string, record: ProjectionCapture, recovery = false): Promise<void> {
    if (!record.raw) throw new Error("capture has no retained authoritative result; ledger reconciliation required");
    try {
      const binding = record.call.conversationBinding;
      const observed = record.raw.conversationBinding;
      if (
        !binding ||
        !observed ||
        binding.owner !== observed.owner ||
        binding.mailbox !== observed.mailbox ||
        binding.remoteName !== observed.remoteName
      )
        throw new InvalidCapture("capture result binding differs from the invoked server binding");
      await enqueueCapture(
        record.context,
        { name: record.call.name, args: record.call.args, raw: record.raw },
        id,
        recovery,
      );
      await captures.merge(id, { state: "queued", error: undefined });
      await releaseCapture(id, record);
    } catch (error) {
      await captures.merge(id, {
        state: error instanceof InvalidCapture ? "rejected" : "captured",
        error: errMessage(error),
      });
      if (error instanceof InvalidCapture) await releaseCapture(id, record);
      throw error;
    }
  }

  async function begin(context: ProjectionContext, call: McpCallObservation): Promise<McpCallObserver | undefined> {
    const binding = call.conversationBinding;
    if (!binding || !TOOLS.has(binding.remoteName)) return undefined;
    const id = randomUUID();
    const record: ProjectionCapture = {
      context: structuredClone(context),
      call: structuredClone(call),
      state: "awaiting-result",
      createdAt: Date.now(),
    };
    await captures.putIfAbsent(id, record);
    const key = mailboxKey(call);
    await captureMailboxes.putIfAbsent(key, { pending: [] });
    if (!captureMailboxes.update) throw new Error("capture mailboxes require atomic update support");
    await captureMailboxes.update(key, (value) => {
      if (value.pending.length >= 64)
        throw new Error("too many unresolved conversation captures; reconcile before new calls");
      return { pending: [...value.pending, id] };
    });
    try {
      await deps.deliveries.enqueue({
        destination: { type: CAPTURE_TYPE, target: id },
        text: id,
        idempotencyKey: `zvconv:capture:${id}`,
      });
    } catch (error) {
      await captures.merge(id, { state: "rejected", error: errMessage(error) });
      await releaseCapture(id, record);
      throw error;
    }
    return {
      async result(raw) {
        const captured = { ...record, raw: structuredClone(raw), state: "captured" as const };
        await captures.put(id, captured);
        await processCapture(id, captured);
      },
      async failed(error) {
        await captures.merge(id, { state: "uncertain", error: errMessage(error) });
        await releaseCapture(id, record);
      },
    };
  }

  async function capture(
    context: ProjectionContext,
    input: Parameters<AgentConversationProjectionService["capture"]>[1],
  ): Promise<void> {
    const observer = await begin(context, {
      name: input.name,
      args: input.args,
      conversationBinding: input.raw.conversationBinding,
    });
    await observer?.result(input.raw);
  }

  async function enqueueCapture(
    context: ProjectionContext,
    input: Parameters<AgentConversationProjectionService["capture"]>[1],
    captureId: string,
    recovery = false,
  ): Promise<void> {
    const binding = input.raw.conversationBinding;
    if (!binding || !TOOLS.has(binding.remoteName)) return;
    if (binding.owner !== context.owner)
      throw new InvalidCapture("conversation capture principal does not match signed binding");
    const mailbox = binding.mailbox.trim().toLowerCase();
    if (!mailbox || (typeof input.args.mailbox === "string" && input.args.mailbox.trim().toLowerCase() !== mailbox))
      throw new InvalidCapture("conversation capture mailbox does not match signed binding");
    let result: Record<string, any>;
    try {
      result = JSON.parse(input.raw.text);
    } catch {
      throw new InvalidCapture("conversation result is not valid JSON");
    }
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new InvalidCapture("conversation result is not an object");
    if (result.error) return;
    const claimed = binding.remoteName === "zipviz_inbox_claim";
    const adopted = binding.remoteName === "zipviz_conversation_adopt";
    if (adopted && result.binding_role !== "ingress-owner") return;
    const claimedRows = Array.isArray(result.claimed) ? result.claimed : [];
    const rows = claimed ? claimedRows : [result];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new InvalidCapture("conversation result contains an invalid turn row");
      let conversationId = row.turn?.conversation?.id ?? row.snapshot?.conversation_id;
      let turn = row.turn?.conversation?.turn ?? row.snapshot?.turns;
      if (claimed) {
        conversationId = row.conversation?.conversation_id;
        turn = row.conversation?.turn;
      } else if (adopted) {
        conversationId = row.conversation_id;
        turn = 0;
      }
      if (
        typeof conversationId !== "string" ||
        !conversationId ||
        !Number.isSafeInteger(turn) ||
        turn < (adopted ? 0 : 1)
      )
        throw new InvalidCapture("successful conversation result lacks authoritative turn identity");
      const side = { mailbox, owner: binding.owner, conversationId };
      const key = agentConversationLinkId(side);
      const job: ProjectionJob = {
        context: structuredClone(context),
        observation: {
          name: input.name,
          args: {
            ...structuredClone(input.args),
            mailbox,
            ...(claimed || adopted ? {} : { conversation_id: conversationId }),
          },
          resultText: claimed ? JSON.stringify({ ...result, claimed: [row] }) : input.raw.text,
        },
        remoteName: binding.remoteName,
        mailbox,
        conversationId,
        turn,
      };
      if (context.destination) {
        const { type, target, audienceScopeId, onBehalfOf, identity, threadTs, unfurlLinks } = context.destination;
        job.context.destination = { type, target, audienceScopeId, onBehalfOf, identity, threadTs, unfurlLinks };
      }
      if (adopted || binding.remoteName === "zipviz_conversation_open")
        await projectorFor(job).register(job.observation, job.remoteName);
      if (adopted) continue;
      if (turn > 0) {
        const pending =
          (await captureMailboxes.get(mailboxKey({ name: input.name, args: input.args, conversationBinding: binding })))
            ?.pending ?? [];
        await deps.progress.putIfAbsent(key, {
          baselineTurn: turn - 1,
          lastTurn: turn - 1,
          initializing: true,
          initialCaptures: pending,
        });
        if (!deps.progress.update) throw new Error("projection progress requires atomic update support");
        await deps.progress.update(key, (value) =>
          value.initializing && value.initialCaptures?.includes(captureId)
            ? {
                ...value,
                baselineTurn: Math.min(value.baselineTurn, turn - 1),
                lastTurn: Math.min(value.lastTurn, turn - 1),
              }
            : value,
        );
      }
      await deps.deliveries.enqueue({
        destination: { type: QUEUE_TYPE, target: key },
        text: JSON.stringify(job),
        idempotencyKey: `zvconv:observe:${key}:${turn}${recovery ? `:recovery:${captureId}` : ""}`,
      });
    }
  }

  function sweep(): Promise<void> {
    if (inFlight) return inFlight;
    if (stopping) return Promise.resolve();
    const work = async () => {
      await deps.leaderLease.hold("conversation-projection", async (lost) => {
        let lostLease = false;
        void lost.then(() => {
          lostLease = true;
        });
        const started = Date.now();
        for (const delivery of await deps.deliveries.pending(CAPTURE_TYPE, { limit: 32, readyAt: started })) {
          if (stopping || lostLease || Date.now() - started > 250) break;
          await deps.deliveries.defer(delivery.id, Date.now() + 1_000);
          const record = await captures.get(delivery.destination.target);
          if (!record) {
            await quarantine(delivery, new Error("capture record missing"));
            continue;
          }
          if (record.state === "awaiting-result" || record.state === "uncertain") continue;
          if (record.state === "rejected") {
            await quarantine(delivery, new Error(record.error));
            continue;
          }
          try {
            await processCapture(delivery.destination.target, record);
            await deps.deliveries.ack(delivery.id, Date.now());
          } catch (error) {
            if (error instanceof InvalidCapture) await quarantine(delivery, error);
          }
        }
        const rows = (await deps.deliveries.pending(QUEUE_TYPE, { limit: 32, readyAt: started })).map((delivery) => {
          try {
            const job = JSON.parse(delivery.text) as ProjectionJob;
            if (
              !job ||
              !Number.isSafeInteger(job.turn) ||
              job.turn < 1 ||
              !job.context?.owner ||
              !job.mailbox ||
              !job.conversationId ||
              !job.observation ||
              !TOOLS.has(job.remoteName) ||
              delivery.destination.target !==
                agentConversationLinkId({
                  owner: job.context.owner,
                  mailbox: job.mailbox,
                  conversationId: job.conversationId,
                })
            )
              throw new Error("invalid conversation projection job shape");
            if (
              typeof job.observation.name !== "string" ||
              typeof job.observation.resultText !== "string" ||
              !job.observation.args ||
              typeof job.observation.args !== "object"
            )
              throw new Error("invalid captured observation");
            const result = JSON.parse(job.observation.resultText);
            const claim = job.remoteName === "zipviz_inbox_claim" ? result.claimed?.[0]?.conversation : undefined;
            const id = claim?.conversation_id ?? result.turn?.conversation?.id ?? result.snapshot?.conversation_id;
            const turn = claim?.turn ?? result.turn?.conversation?.turn ?? result.snapshot?.turns;
            if (id !== job.conversationId || turn !== job.turn)
              throw new Error("projection job disagrees with authoritative turn identity");
            return { delivery, job };
          } catch (error) {
            return { delivery, error };
          }
        });
        rows.sort((a, b) => (a.job?.turn ?? 0) - (b.job?.turn ?? 0));
        for (const { delivery, job, error } of rows) {
          if (stopping || lostLease || Date.now() - started > 1_000) break;
          await deps.deliveries.defer(delivery.id, Date.now() + 1_000);
          if (!job) {
            await quarantine(delivery, error);
            continue;
          }
          const key = delivery.destination.target;
          let progress = await deps.progress.get(key);
          if (progress?.initializing) {
            const state = await captureMailboxes.get(JSON.stringify([job.mailbox, job.context.owner]));
            if (state?.pending.some((id) => progress!.initialCaptures?.includes(id))) continue;
            progress = await deps.progress.merge(key, { initializing: false, initialCaptures: undefined });
          }
          if (job.turn > 0 && (!progress || job.turn > progress.lastTurn + 1)) {
            if (progress) {
              const note = `waiting for turn ${progress.lastTurn + 1} before turn ${job.turn}; explicit replay required`;
              if (progress.lastSkipNote !== note) {
                await deps.progress.merge(key, { lastSkipNote: note });
                await deps.links.noteSkip(
                  { owner: job.context.owner, mailbox: job.mailbox, conversationId: job.conversationId },
                  note,
                );
                console.error(`[conversation-projection] ${key}: ${note}`);
              }
            }
            continue;
          }
          try {
            if (job.turn === 0 || !progress || job.turn > progress.lastTurn) {
              const projector = projectorFor(job);
              await projector.project(job.observation);
              if (lostLease) throw new Error("projection leader lease lost before acknowledgement");
              if (job.turn > 0) {
                if (!deps.progress.update) throw new Error("projection progress requires atomic update support");
                await deps.progress.update(key, (value) => ({
                  ...value,
                  lastTurn: Math.max(value.lastTurn, job.turn),
                  lastSkipNote: undefined,
                }));
              }
            }
            await deps.deliveries.ack(delivery.id, Date.now());
          } catch (error) {
            const note = errMessage(error);
            if (progress?.lastSkipNote !== note) {
              if (progress) await deps.progress.merge(key, { lastSkipNote: note });
              swallow("conversation projection retry pending", error);
            }
          }
        }
      });
    };
    inFlight = work().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  const sweeper = createSweeper(sweep, 1_000, { immediate: true, label: "conversation projections" });
  return {
    begin,
    capture,
    inspect: (id) => captures.get(id),
    async diagnostics() {
      const pending = await deps.deliveries.pending(CAPTURE_TYPE, { limit: 32, readyAt: Number.MAX_SAFE_INTEGER });
      const rows = await Promise.all(
        pending.map(async (delivery) => {
          const record = await captures.get(delivery.destination.target);
          return {
            id: delivery.destination.target,
            state: record?.state ?? "missing",
            ...(record?.error ? { error: record.error } : {}),
          };
        }),
      );
      const dead = await deps.deliveries.pending(QUARANTINE_TYPE, { limit: 32, readyAt: Number.MAX_SAFE_INTEGER });
      return {
        captures: rows,
        quarantined: dead.map((delivery) => {
          const record = JSON.parse(delivery.text);
          return { id: delivery.id, sourceId: record.sourceId, error: record.error };
        }),
      };
    },
    async recover(id) {
      const record = await captures.get(id);
      if (!record) throw new Error("capture not found");
      await processCapture(id, record, true);
    },
    sweep,
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
