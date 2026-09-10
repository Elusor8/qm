import { createPgPool, withPgTransaction, type PgPool } from "../persistence/pg-pool.ts";

export const PROJECTION_CONTENT_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const PROJECTION_RETENTION_SWEEP_MS = 60 * 60_000;

export interface ProjectionReaderAudience {
  mailbox: string;
  adapterKind: string;
  adapterInstance: string;
  externalScope: string;
  externalPrincipalRef: string;
}

export interface ProjectionReaderCheckpoint extends ProjectionReaderAudience {
  afterCursor: string | null;
  version: number;
  updatedAt: number;
  recoveryCode?: string;
  recoveryDetail?: string;
}

export interface ProjectionSkipMarker {
  projectionRevision: number;
  msgId: string;
  code: string;
  subscriptionKey?: string;
  releasedAt?: number;
  resolution?: string;
}

export interface ProjectionOutboxJob {
  id: string;
  audienceKey: string;
  eventId: string;
  projectionRevision: number;
  destinationRevision: number;
  payload: unknown;
  createdAt: number;
  availableAt: number;
  attempts: number;
  state: "ready" | "awaiting_binding" | "expired";
  subscriptionKey: string;
  msgId: string;
}

export interface ProjectionPruneResult {
  expiredOutbox: number;
  deletedSkips: number;
}

export interface ProjectionReaderStore {
  get(audience: ProjectionReaderAudience): Promise<ProjectionReaderCheckpoint>;
  acceptPage(input: {
    audience: ProjectionReaderAudience;
    expectedVersion: number;
    jobs: ProjectionOutboxJob[];
    skips: ProjectionSkipMarker[];
    afterCursor: string | null | undefined;
  }): Promise<boolean>;
  reset(audience: ProjectionReaderAudience, expectedVersion: number, code: string, detail: string): Promise<boolean>;
  pending(limit: number, readyAt: number): Promise<ProjectionOutboxJob[]>;
  ack(id: string, projectionRevision: number): Promise<void>;
  defer(id: string, projectionRevision: number, until: number, detail: string): Promise<void>;
  skips(audience: ProjectionReaderAudience): Promise<ProjectionSkipMarker[]>;
  subscriptionForMsg(audience: ProjectionReaderAudience, msgId: string): Promise<string | null>;
  held(audienceKey: string, subscriptionKey: string): Promise<boolean>;
  releaseGap(audience: ProjectionReaderAudience, msgId: string, resolution: string): Promise<boolean>;
  prune(cutoff: number): Promise<ProjectionPruneResult>;
  allOutbox(limit: number): Promise<ProjectionOutboxJob[]>;
}

export function projectionReaderAudienceKey(audience: ProjectionReaderAudience): string {
  return JSON.stringify([
    audience.mailbox.trim().toLowerCase(),
    audience.adapterKind,
    audience.adapterInstance,
    audience.externalScope,
    audience.externalPrincipalRef,
  ]);
}

export async function retireLegacyConversationProjection(pg: PgPool): Promise<void> {
  const pool = await pg.pool();
  await withPgTransaction(pool, async (client) => {
    await client.query(
      `CREATE TABLE IF NOT EXISTS agent_conversation_projection_pending_bindings
       (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    );
    const legacy = await client.query("SELECT to_regclass('agent_conversation_captures') AS name");
    if (legacy.rows[0]?.name) {
      await client.query(
        `INSERT INTO agent_conversation_projection_pending_bindings(id,json)
         SELECT jsonb_build_array(
             json->'call'->>'serverId',
             lower(json->'call'->'conversationBinding'->>'mailbox'),
             json->'context'->>'owner',
             json->'call'->'runtimeContext'->>'threadRef'
           )::text,
           jsonb_build_object(
             'id',jsonb_build_array(
               json->'call'->>'serverId',lower(json->'call'->'conversationBinding'->>'mailbox'),
               json->'context'->>'owner',json->'call'->'runtimeContext'->>'threadRef'
             )::text,
             'serverId',json->'call'->>'serverId',
             'mailbox',lower(json->'call'->'conversationBinding'->>'mailbox'),
             'externalThreadRef',json->'call'->'runtimeContext'->>'threadRef',
             'createdAt',COALESCE((json->>'createdAt')::bigint,0)
           ) || (json->'context')
         FROM agent_conversation_captures
         WHERE json->'call'->'conversationBinding'->>'remoteName' IN
           ('zipviz_conversation_open','zipviz_conversation_adopt')
           AND json->'call'->>'serverId' IS NOT NULL
           AND json->'call'->'runtimeContext'->>'threadRef' IS NOT NULL
         ON CONFLICT(id) DO NOTHING`,
      );
    }
    const deliveries = await client.query("SELECT to_regclass('deliveries') AS name");
    if (deliveries.rows[0]?.name)
      await client.query(
        `DELETE FROM deliveries WHERE destination->>'type' IN ('conversation-capture','conversation-projection')`,
      );
    for (const table of [
      "agent_conversation_captures",
      "agent_conversation_capture_mailboxes",
      "agent_conversation_projection_progress",
    ]) {
      const found = await client.query("SELECT to_regclass($1) AS name", [table]);
      if (found.rows[0]?.name) await client.query(`DELETE FROM ${table}`);
    }
    const versions = await client.query("SELECT to_regclass('durable_map_versions') AS name");
    if (versions.rows[0]?.name)
      await client.query(
        `INSERT INTO durable_map_versions(tbl,v) VALUES
         ('agent_conversation_captures',1),('agent_conversation_capture_mailboxes',1),
         ('agent_conversation_projection_progress',1)
         ON CONFLICT(tbl) DO UPDATE SET v=durable_map_versions.v+1`,
      );
  });
}

function initial(audience: ProjectionReaderAudience): ProjectionReaderCheckpoint {
  return { ...audience, afterCursor: null, version: 0, updatedAt: 0 };
}

export function createMemoryProjectionReaderStore(): ProjectionReaderStore {
  const checkpoints = new Map<string, ProjectionReaderCheckpoint>();
  const outbox = new Map<string, ProjectionOutboxJob>();
  const markers = new Map<string, ProjectionSkipMarker[]>();
  const subscriptions = new Map<string, { subscriptionKey: string; updatedAt: number }>();
  const holds = new Map<string, ProjectionSkipMarker>();
  return {
    async get(audience) {
      return structuredClone(checkpoints.get(projectionReaderAudienceKey(audience)) ?? initial(audience));
    },
    async acceptPage(input) {
      const key = projectionReaderAudienceKey(input.audience);
      const current = checkpoints.get(key) ?? initial(input.audience);
      if (current.version !== input.expectedVersion) return false;
      for (const job of input.jobs) {
        const existing = outbox.get(job.id);
        if (!existing || existing.state === "expired" || existing.projectionRevision < job.projectionRevision)
          outbox.set(job.id, structuredClone(job));
        subscriptions.set(JSON.stringify([key, job.msgId]), {
          subscriptionKey: job.subscriptionKey,
          updatedAt: Date.now(),
        });
        for (const [holdKey, hold] of holds)
          if (holdKey.startsWith(`${key}\u0000${job.msgId}\u0000`) && hold.releasedAt === undefined)
            holds.set(holdKey, { ...hold, releasedAt: Date.now(), resolution: "authoritative recovery" });
      }
      for (const marker of input.skips) {
        if (!["E_RETAINED_EVENT_GAP", "E_PROOF_UNAVAILABLE"].includes(marker.code)) continue;
        if (input.jobs.some((job) => job.msgId === marker.msgId)) continue;
        const holdKey = `${key}\u0000${marker.msgId}\u0000${marker.code}`;
        const prior = holds.get(holdKey);
        if (!prior) holds.set(holdKey, structuredClone(marker));
        else if (prior.releasedAt === undefined && marker.subscriptionKey)
          holds.set(holdKey, { ...prior, subscriptionKey: marker.subscriptionKey });
      }
      const recovered = new Set(input.jobs.map((job) => job.msgId));
      const nextMarkers = [
        ...(markers.get(key) ?? []).map((marker) =>
          recovered.has(marker.msgId) && marker.releasedAt === undefined
            ? { ...marker, releasedAt: Date.now(), resolution: "authoritative recovery" }
            : marker,
        ),
        ...input.skips.map((marker) =>
          recovered.has(marker.msgId)
            ? { ...marker, releasedAt: Date.now(), resolution: "authoritative recovery" }
            : marker,
        ),
      ]
        .sort((a, b) => a.projectionRevision - b.projectionRevision)
        .slice(-100);
      markers.set(key, nextMarkers);
      checkpoints.set(key, {
        ...current,
        ...(input.afterCursor !== undefined ? { afterCursor: input.afterCursor } : {}),
        version: current.version + 1,
        updatedAt: Date.now(),
      });
      const saved = checkpoints.get(key)!;
      delete saved.recoveryCode;
      delete saved.recoveryDetail;
      return true;
    },
    async reset(audience, expectedVersion, code, detail) {
      const key = projectionReaderAudienceKey(audience);
      const current = checkpoints.get(key) ?? initial(audience);
      if (current.version !== expectedVersion) return false;
      checkpoints.set(key, {
        ...current,
        version: current.version + 1,
        updatedAt: Date.now(),
        recoveryCode: code,
        recoveryDetail: detail,
      });
      return true;
    },
    async pending(limit, readyAt) {
      return [...outbox.values()]
        .filter((job) => job.state !== "expired" && job.availableAt <= readyAt)
        .sort((a, b) => a.availableAt - b.availableAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((job) => structuredClone(job));
    },
    async ack(id, projectionRevision) {
      const current = outbox.get(id);
      if (current?.projectionRevision === projectionRevision) outbox.delete(id);
    },
    async defer(id, projectionRevision, until) {
      const current = outbox.get(id);
      if (current?.projectionRevision === projectionRevision)
        outbox.set(id, { ...current, availableAt: until, attempts: current.attempts + 1 });
    },
    async skips(audience) {
      return structuredClone(markers.get(projectionReaderAudienceKey(audience)) ?? []);
    },
    async subscriptionForMsg(audience, msgId) {
      return subscriptions.get(JSON.stringify([projectionReaderAudienceKey(audience), msgId]))?.subscriptionKey ?? null;
    },
    async held(audienceKey, subscriptionKey) {
      return [...holds.entries()].some(
        ([key, marker]) =>
          key.startsWith(`${audienceKey}\u0000`) &&
          marker.releasedAt === undefined &&
          (!marker.subscriptionKey || marker.subscriptionKey === subscriptionKey),
      );
    },
    async releaseGap(audience, msgId, resolution) {
      const key = projectionReaderAudienceKey(audience);
      const rows = markers.get(key) ?? [];
      const index = rows.findIndex((row) => row.msgId === msgId && row.releasedAt === undefined);
      let released = false;
      for (const [holdKey, hold] of holds)
        if (holdKey.startsWith(`${key}\u0000${msgId}\u0000`) && hold.releasedAt === undefined) {
          holds.set(holdKey, { ...hold, releasedAt: Date.now(), resolution });
          released = true;
        }
      if (index >= 0) rows[index] = { ...rows[index]!, releasedAt: Date.now(), resolution };
      return released;
    },
    async prune(cutoff) {
      let expiredOutbox = 0;
      for (const [id, job] of outbox) {
        if (job.createdAt >= cutoff || job.state === "expired") continue;
        outbox.set(id, {
          ...job,
          state: "expired",
          payload: { expired: true, eventId: job.eventId, projectionRevision: job.projectionRevision },
        });
        expiredOutbox += 1;
      }
      const expiredByAudience = new Map<string, ProjectionOutboxJob[]>();
      for (const job of outbox.values()) {
        if (job.state !== "expired") continue;
        const rows = expiredByAudience.get(job.audienceKey) ?? [];
        rows.push(job);
        expiredByAudience.set(job.audienceKey, rows);
      }
      for (const rows of expiredByAudience.values())
        for (const job of rows.sort((a, b) => b.createdAt - a.createdAt).slice(100)) outbox.delete(job.id);
      for (const [key, value] of subscriptions) if (value.updatedAt < cutoff) subscriptions.delete(key);
      let deletedSkips = 0;
      for (const [key, rows] of markers) {
        const kept = rows.slice(-100);
        deletedSkips += rows.length - kept.length;
        markers.set(key, kept);
      }
      return { expiredOutbox, deletedSkips };
    },
    async allOutbox(limit) {
      return [...outbox.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map((job) => structuredClone(job));
    },
  };
}

export function createPostgresProjectionReaderStore(connectionString: string): ProjectionReaderStore {
  const pg = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS agent_conversation_projection_readers(
      audience_key TEXT PRIMARY KEY,
      mailbox TEXT NOT NULL,
      adapter_kind TEXT NOT NULL,
      adapter_instance TEXT NOT NULL,
      external_scope TEXT NOT NULL,
      external_principal_ref TEXT NOT NULL,
      after_cursor TEXT,
      version BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      recovery_code TEXT,
      recovery_detail TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS agent_conversation_projection_outbox(
      id TEXT PRIMARY KEY,
      audience_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      projection_revision BIGINT NOT NULL,
      destination_revision BIGINT NOT NULL,
      payload JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      available_at BIGINT NOT NULL DEFAULT 0,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_conversation_projection_outbox_ready
      ON agent_conversation_projection_outbox (available_at, created_at, id)`,
    `ALTER TABLE agent_conversation_projection_outbox ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'ready'`,
    `ALTER TABLE agent_conversation_projection_outbox ADD COLUMN IF NOT EXISTS subscription_key TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE agent_conversation_projection_outbox ADD COLUMN IF NOT EXISTS msg_id TEXT NOT NULL DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS agent_conversation_projection_skips(
      audience_key TEXT NOT NULL,
      projection_revision BIGINT NOT NULL,
      msg_id TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY(audience_key, projection_revision, code)
    )`,
    `ALTER TABLE agent_conversation_projection_skips ADD COLUMN IF NOT EXISTS subscription_key TEXT`,
    `ALTER TABLE agent_conversation_projection_skips ADD COLUMN IF NOT EXISTS released_at BIGINT`,
    `ALTER TABLE agent_conversation_projection_skips ADD COLUMN IF NOT EXISTS resolution TEXT`,
    `CREATE TABLE IF NOT EXISTS agent_conversation_projection_event_index(
      audience_key TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      subscription_key TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY(audience_key,msg_id)
    )`,
    `CREATE TABLE IF NOT EXISTS agent_conversation_projection_holds(
      audience_key TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      code TEXT NOT NULL,
      subscription_key TEXT,
      created_at BIGINT NOT NULL,
      released_at BIGINT,
      resolution TEXT,
      PRIMARY KEY(audience_key,msg_id,code)
    )`,
    `ALTER TABLE agent_conversation_projection_holds ADD COLUMN IF NOT EXISTS released_at BIGINT`,
    `ALTER TABLE agent_conversation_projection_holds ADD COLUMN IF NOT EXISTS resolution TEXT`,
  ]);

  const rowCheckpoint = (audience: ProjectionReaderAudience, row?: Record<string, unknown>) =>
    row
      ? {
          ...audience,
          afterCursor: (row.after_cursor as string | null) ?? null,
          version: Number(row.version),
          updatedAt: Number(row.updated_at),
          ...(row.recovery_code ? { recoveryCode: String(row.recovery_code) } : {}),
          ...(row.recovery_detail ? { recoveryDetail: String(row.recovery_detail) } : {}),
        }
      : initial(audience);

  return {
    async get(audience) {
      const rows = await pg.q("SELECT * FROM agent_conversation_projection_readers WHERE audience_key=$1", [
        projectionReaderAudienceKey(audience),
      ]);
      return rowCheckpoint(audience, rows[0]);
    },
    async acceptPage(input) {
      const pool = await pg.pool();
      const key = projectionReaderAudienceKey(input.audience);
      return withPgTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
        const locked = await client.query(
          "SELECT version, after_cursor FROM agent_conversation_projection_readers WHERE audience_key=$1 FOR UPDATE",
          [key],
        );
        const version = locked.rows[0] ? Number(locked.rows[0].version) : 0;
        if (version !== input.expectedVersion) return false;
        for (const job of input.jobs) {
          await client.query(
            `INSERT INTO agent_conversation_projection_outbox
              (id,audience_key,event_id,projection_revision,destination_revision,payload,created_at,available_at,attempts,
               state,subscription_key,msg_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11)
             ON CONFLICT(id) DO UPDATE SET
               projection_revision=EXCLUDED.projection_revision,
               payload=EXCLUDED.payload,
               available_at=0,
               attempts=0,
               state=EXCLUDED.state,
               subscription_key=EXCLUDED.subscription_key,
               msg_id=EXCLUDED.msg_id,
               last_error=NULL
             WHERE agent_conversation_projection_outbox.state='expired'
                OR agent_conversation_projection_outbox.projection_revision < EXCLUDED.projection_revision`,
            [
              job.id,
              key,
              job.eventId,
              job.projectionRevision,
              job.destinationRevision,
              JSON.stringify(job.payload),
              job.createdAt,
              job.availableAt,
              job.state,
              job.subscriptionKey,
              job.msgId,
            ],
          );
          await client.query(
            `INSERT INTO agent_conversation_projection_event_index(audience_key,msg_id,subscription_key,updated_at)
             VALUES($1,$2,$3,$4) ON CONFLICT(audience_key,msg_id) DO UPDATE SET
               subscription_key=EXCLUDED.subscription_key,updated_at=EXCLUDED.updated_at`,
            [key, job.msgId, job.subscriptionKey, Date.now()],
          );
          await client.query(
            `UPDATE agent_conversation_projection_skips SET released_at=$3,resolution='authoritative recovery'
             WHERE audience_key=$1 AND msg_id=$2 AND released_at IS NULL`,
            [key, job.msgId, Date.now()],
          );
          await client.query(
            `UPDATE agent_conversation_projection_holds SET released_at=$3,resolution='authoritative recovery'
             WHERE audience_key=$1 AND msg_id=$2 AND released_at IS NULL`,
            [key, job.msgId, Date.now()],
          );
        }
        for (const skip of input.skips) {
          await client.query(
            `INSERT INTO agent_conversation_projection_skips
              (audience_key,projection_revision,msg_id,code,created_at,subscription_key,released_at,resolution)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [
              key,
              skip.projectionRevision,
              skip.msgId,
              skip.code,
              Date.now(),
              skip.subscriptionKey ?? null,
              input.jobs.some((job) => job.msgId === skip.msgId) ? Date.now() : null,
              input.jobs.some((job) => job.msgId === skip.msgId) ? "authoritative recovery" : null,
            ],
          );
          if (
            ["E_RETAINED_EVENT_GAP", "E_PROOF_UNAVAILABLE"].includes(skip.code) &&
            !input.jobs.some((job) => job.msgId === skip.msgId)
          )
            await client.query(
              `INSERT INTO agent_conversation_projection_holds
                (audience_key,msg_id,code,subscription_key,created_at) VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(audience_key,msg_id,code) DO UPDATE SET
                 subscription_key=COALESCE(EXCLUDED.subscription_key,agent_conversation_projection_holds.subscription_key)`,
              [key, skip.msgId, skip.code, skip.subscriptionKey ?? null, Date.now()],
            );
        }
        await client.query(
          `DELETE FROM agent_conversation_projection_skips WHERE audience_key=$1 AND projection_revision NOT IN
            (SELECT projection_revision FROM agent_conversation_projection_skips WHERE audience_key=$1
             ORDER BY projection_revision DESC LIMIT 100)`,
          [key],
        );
        const after = input.afterCursor === undefined ? (locked.rows[0]?.after_cursor ?? null) : input.afterCursor;
        await client.query(
          `INSERT INTO agent_conversation_projection_readers
            (audience_key,mailbox,adapter_kind,adapter_instance,external_scope,external_principal_ref,
             after_cursor,version,updated_at,recovery_code,recovery_detail)
           VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,NULL,NULL)
           ON CONFLICT(audience_key) DO UPDATE SET
             after_cursor=EXCLUDED.after_cursor,
             version=agent_conversation_projection_readers.version+1,
             updated_at=EXCLUDED.updated_at,
             recovery_code=NULL,
             recovery_detail=NULL`,
          [
            key,
            input.audience.mailbox,
            input.audience.adapterKind,
            input.audience.adapterInstance,
            input.audience.externalScope,
            input.audience.externalPrincipalRef,
            after,
            Date.now(),
          ],
        );
        return true;
      });
    },
    async reset(audience, expectedVersion, code, detail) {
      const key = projectionReaderAudienceKey(audience);
      const updated = await pg.query(
        `UPDATE agent_conversation_projection_readers SET version=version+1,updated_at=$3,
          recovery_code=$4,recovery_detail=$5 WHERE audience_key=$1 AND version=$2`,
        [key, expectedVersion, Date.now(), code, detail],
      );
      if (updated.rowCount > 0) return true;
      if (expectedVersion !== 0) return false;
      const inserted = await pg.query(
        `INSERT INTO agent_conversation_projection_readers
          (audience_key,mailbox,adapter_kind,adapter_instance,external_scope,external_principal_ref,
           after_cursor,version,updated_at,recovery_code,recovery_detail)
         VALUES($1,$2,$3,$4,$5,$6,NULL,1,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          key,
          audience.mailbox,
          audience.adapterKind,
          audience.adapterInstance,
          audience.externalScope,
          audience.externalPrincipalRef,
          Date.now(),
          code,
          detail,
        ],
      );
      return inserted.rowCount > 0;
    },
    async pending(limit, readyAt) {
      const rows = await pg.q(
        `SELECT * FROM agent_conversation_projection_outbox WHERE state <> 'expired' AND available_at <= $1
         ORDER BY available_at,created_at,id LIMIT $2`,
        [readyAt, Math.max(1, Math.min(100, limit))],
      );
      return rows.map((row) => ({
        id: String(row.id),
        audienceKey: String(row.audience_key),
        eventId: String(row.event_id),
        projectionRevision: Number(row.projection_revision),
        destinationRevision: Number(row.destination_revision),
        payload: row.payload,
        createdAt: Number(row.created_at),
        availableAt: Number(row.available_at),
        attempts: Number(row.attempts),
        state: String(row.state) as ProjectionOutboxJob["state"],
        subscriptionKey: String(row.subscription_key),
        msgId: String(row.msg_id),
      }));
    },
    async ack(id, projectionRevision) {
      await pg.query("DELETE FROM agent_conversation_projection_outbox WHERE id=$1 AND projection_revision=$2", [
        id,
        projectionRevision,
      ]);
    },
    async defer(id, projectionRevision, until, detail) {
      await pg.query(
        `UPDATE agent_conversation_projection_outbox SET available_at=$3,attempts=attempts+1,last_error=$4
         WHERE id=$1 AND projection_revision=$2`,
        [id, projectionRevision, until, detail],
      );
    },
    async skips(audience) {
      const rows = await pg.q(
        `SELECT projection_revision,msg_id,code,subscription_key,released_at,resolution
         FROM agent_conversation_projection_skips
         WHERE audience_key=$1 ORDER BY projection_revision`,
        [projectionReaderAudienceKey(audience)],
      );
      return rows.map((row) => ({
        projectionRevision: Number(row.projection_revision),
        msgId: String(row.msg_id),
        code: String(row.code),
        ...(row.subscription_key ? { subscriptionKey: String(row.subscription_key) } : {}),
        ...(row.released_at ? { releasedAt: Number(row.released_at) } : {}),
        ...(row.resolution ? { resolution: String(row.resolution) } : {}),
      }));
    },
    async subscriptionForMsg(audience, msgId) {
      const rows = await pg.q(
        "SELECT subscription_key FROM agent_conversation_projection_event_index WHERE audience_key=$1 AND msg_id=$2",
        [projectionReaderAudienceKey(audience), msgId],
      );
      return rows[0] ? String(rows[0].subscription_key) : null;
    },
    async held(audienceKey, subscriptionKey) {
      const rows = await pg.q(
        `SELECT 1 FROM agent_conversation_projection_holds
         WHERE audience_key=$1 AND released_at IS NULL
           AND (subscription_key IS NULL OR subscription_key=$2) LIMIT 1`,
        [audienceKey, subscriptionKey],
      );
      return rows.length > 0;
    },
    async releaseGap(audience, msgId, resolution) {
      const pool = await pg.pool();
      return withPgTransaction(pool, async (client) => {
        const key = projectionReaderAudienceKey(audience);
        const result = await client.query(
          `UPDATE agent_conversation_projection_holds SET released_at=$3,resolution=$4
           WHERE audience_key=$1 AND msg_id=$2 AND released_at IS NULL`,
          [key, msgId, Date.now(), resolution],
        );
        await client.query(
          `UPDATE agent_conversation_projection_skips SET released_at=$3,resolution=$4
           WHERE audience_key=$1 AND msg_id=$2 AND released_at IS NULL`,
          [key, msgId, Date.now(), resolution],
        );
        return (result.rowCount ?? 0) > 0;
      });
    },
    async prune(cutoff) {
      const expired = await pg.query(
        `UPDATE agent_conversation_projection_outbox SET state='expired',
           payload=jsonb_build_object('expired',true,'eventId',event_id,'projectionRevision',projection_revision),
           last_error='full projection payload expired under processing-copy retention policy'
         WHERE created_at < $1 AND state <> 'expired'`,
        [cutoff],
      );
      const deleted = await pg.query(
        `DELETE FROM agent_conversation_projection_skips s WHERE released_at IS NOT NULL AND created_at < $1
         AND EXISTS (SELECT 1 FROM agent_conversation_projection_skips newer
           WHERE newer.audience_key=s.audience_key AND newer.projection_revision>s.projection_revision)`,
        [cutoff],
      );
      await pg.query("DELETE FROM agent_conversation_projection_event_index WHERE updated_at < $1", [cutoff]);
      await pg.query(
        `DELETE FROM agent_conversation_projection_outbox expired WHERE state='expired' AND id NOT IN
         (SELECT id FROM agent_conversation_projection_outbox kept
          WHERE kept.audience_key=expired.audience_key AND kept.state='expired'
          ORDER BY kept.created_at DESC,kept.id DESC LIMIT 100)`,
      );
      return { expiredOutbox: expired.rowCount, deletedSkips: deleted.rowCount };
    },
    async allOutbox(limit) {
      const rows = await pg.q("SELECT * FROM agent_conversation_projection_outbox ORDER BY created_at,id LIMIT $1", [
        Math.max(1, Math.min(500, limit)),
      ]);
      return rows.map((row) => ({
        id: String(row.id),
        audienceKey: String(row.audience_key),
        eventId: String(row.event_id),
        projectionRevision: Number(row.projection_revision),
        destinationRevision: Number(row.destination_revision),
        payload: row.payload,
        createdAt: Number(row.created_at),
        availableAt: Number(row.available_at),
        attempts: Number(row.attempts),
        state: String(row.state) as ProjectionOutboxJob["state"],
        subscriptionKey: String(row.subscription_key),
        msgId: String(row.msg_id),
      }));
    },
  };
}
