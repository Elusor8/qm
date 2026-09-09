import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";

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

function initial(audience: ProjectionReaderAudience): ProjectionReaderCheckpoint {
  return { ...audience, afterCursor: null, version: 0, updatedAt: 0 };
}

export function createMemoryProjectionReaderStore(): ProjectionReaderStore {
  const checkpoints = new Map<string, ProjectionReaderCheckpoint>();
  const outbox = new Map<string, ProjectionOutboxJob>();
  const markers = new Map<string, ProjectionSkipMarker[]>();
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
        if (!existing || existing.projectionRevision < job.projectionRevision) outbox.set(job.id, structuredClone(job));
      }
      const nextMarkers = [...(markers.get(key) ?? []), ...input.skips]
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
        afterCursor: null,
        version: current.version + 1,
        updatedAt: Date.now(),
        recoveryCode: code,
        recoveryDetail: detail,
      });
      return true;
    },
    async pending(limit, readyAt) {
      return [...outbox.values()]
        .filter((job) => job.availableAt <= readyAt)
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
    `CREATE TABLE IF NOT EXISTS agent_conversation_projection_skips(
      audience_key TEXT NOT NULL,
      projection_revision BIGINT NOT NULL,
      msg_id TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY(audience_key, projection_revision, code)
    )`,
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
        const locked = await client.query(
          "SELECT version, after_cursor FROM agent_conversation_projection_readers WHERE audience_key=$1 FOR UPDATE",
          [key],
        );
        const version = locked.rows[0] ? Number(locked.rows[0].version) : 0;
        if (version !== input.expectedVersion) return false;
        for (const job of input.jobs) {
          await client.query(
            `INSERT INTO agent_conversation_projection_outbox
              (id,audience_key,event_id,projection_revision,destination_revision,payload,created_at,available_at,attempts)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,0)
             ON CONFLICT(id) DO UPDATE SET
               projection_revision=EXCLUDED.projection_revision,
               payload=EXCLUDED.payload,
               available_at=0,
               attempts=0,
               last_error=NULL
             WHERE agent_conversation_projection_outbox.projection_revision < EXCLUDED.projection_revision`,
            [
              job.id,
              key,
              job.eventId,
              job.projectionRevision,
              job.destinationRevision,
              JSON.stringify(job.payload),
              job.createdAt,
              job.availableAt,
            ],
          );
        }
        for (const skip of input.skips) {
          await client.query(
            `INSERT INTO agent_conversation_projection_skips
              (audience_key,projection_revision,msg_id,code,created_at)
             VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [key, skip.projectionRevision, skip.msgId, skip.code, Date.now()],
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
        `UPDATE agent_conversation_projection_readers SET after_cursor=NULL,version=version+1,updated_at=$3,
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
        `SELECT * FROM agent_conversation_projection_outbox WHERE available_at <= $1
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
        `SELECT projection_revision,msg_id,code FROM agent_conversation_projection_skips
         WHERE audience_key=$1 ORDER BY projection_revision`,
        [projectionReaderAudienceKey(audience)],
      );
      return rows.map((row) => ({
        projectionRevision: Number(row.projection_revision),
        msgId: String(row.msg_id),
        code: String(row.code),
      }));
    },
  };
}
