import type { Destination, ScopeId } from "../types.ts";
import type { McpRawResult } from "../mcp/mcp-tool-service.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { agentConversationLinkId } from "./agent-conversation-link-store.ts";
import {
  createAgentConversationProjector,
  type AgentConversationProjectorDeps,
  type ProjectionObservation,
} from "./agent-conversation-projector.ts";

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
}

interface ProjectionJob {
  context: ProjectionContext;
  observation: ProjectionObservation;
  remoteName: string;
  mailbox: string;
  conversationId: string;
  turn: number;
}

export interface AgentConversationProjectionService {
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
  },
): AgentConversationProjectionService {
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

  async function capture(
    context: ProjectionContext,
    input: Parameters<AgentConversationProjectionService["capture"]>[1],
  ): Promise<void> {
    const binding = input.raw.conversationBinding;
    if (!binding || !TOOLS.has(binding.remoteName)) return;
    if (binding.owner !== context.owner)
      throw new Error("conversation capture principal does not match signed binding");
    const mailbox = binding.mailbox.trim().toLowerCase();
    if (!mailbox || (typeof input.args.mailbox === "string" && input.args.mailbox.trim().toLowerCase() !== mailbox))
      throw new Error("conversation capture mailbox does not match signed binding");
    const result = JSON.parse(input.raw.text) as Record<string, any>;
    if (!result || result.error) return;
    const claimed = binding.remoteName === "zipviz_inbox_claim";
    const adopted = binding.remoteName === "zipviz_conversation_adopt";
    if (adopted && result.binding_role !== "ingress-owner") return;
    const claimedRows = Array.isArray(result.claimed) ? result.claimed : [];
    const rows = claimed ? claimedRows : [result];
    for (const row of rows) {
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
        throw new Error("successful conversation result lacks authoritative turn identity");
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
      if (turn > 0) await deps.progress.putIfAbsent(key, { baselineTurn: turn - 1, lastTurn: turn - 1 });
      await deps.deliveries.enqueue({
        destination: { type: QUEUE_TYPE, target: key },
        text: JSON.stringify(job),
        idempotencyKey: `zvconv:observe:${key}:${turn}`,
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
        const rows = (await deps.deliveries.pending(QUEUE_TYPE, { limit: 32, readyAt: started })).map((delivery) => {
          try {
            return { delivery, job: JSON.parse(delivery.text) as ProjectionJob };
          } catch (error) {
            return { delivery, error };
          }
        });
        rows.sort((a, b) => (a.job?.turn ?? 0) - (b.job?.turn ?? 0));
        for (const { delivery, job, error } of rows) {
          if (stopping || lostLease || Date.now() - started > 1_000) break;
          await deps.deliveries.defer(delivery.id, Date.now() + 1_000);
          if (!job) {
            swallow("invalid conversation projection job", error);
            continue;
          }
          const key = delivery.destination.target;
          const progress = await deps.progress.get(key);
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
    capture,
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
