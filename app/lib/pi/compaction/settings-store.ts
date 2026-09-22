import 'server-only';

import { openDb } from '@/app/lib/db';
import {
  parsePiCompactionSummaryModelIdentity,
  type PiCompactionRuntimeConfig,
} from '@/app/lib/pi/config';

export type PiOrganizationCompactionSettings = Readonly<{
  configured: boolean;
  revision: number;
  tailMode: 'legacy' | 'lean' | null;
  summaryModel: string | null;
  updatedAt: number | null;
}>;

export class PiOrganizationCompactionSettingsConflictError extends Error {
  readonly code = 'COMPACTION_SETTINGS_REVISION_CONFLICT';
  readonly status = 409;

  constructor(readonly currentRevision: number) {
    super('The compaction settings changed. Reload before saving.');
    this.name = 'PiOrganizationCompactionSettingsConflictError';
  }
}

type SettingsRow = {
  tail_mode: string | null;
  summary_model: string | null;
  revision: number | string | null;
  updated_at: number | string | null;
};

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizedConfig(input: PiCompactionRuntimeConfig): PiCompactionRuntimeConfig {
  return Object.freeze({
    ...(input.tailMode === 'legacy' || input.tailMode === 'lean' ? { tailMode: input.tailMode } : {}),
    ...(parsePiCompactionSummaryModelIdentity(input.summaryModel)
      ? { summaryModel: input.summaryModel!.trim() }
      : {}),
  });
}

function stateFromRow(row: SettingsRow | undefined): PiOrganizationCompactionSettings {
  if (!row) {
    return Object.freeze({ configured: false, revision: 0, tailMode: null, summaryModel: null, updatedAt: null });
  }
  const config = normalizedConfig({
    tailMode: row.tail_mode === 'legacy' || row.tail_mode === 'lean' ? row.tail_mode : undefined,
    summaryModel: row.summary_model,
  });
  return Object.freeze({
    configured: true,
    revision: Math.max(1, numberValue(row.revision, 1)),
    tailMode: config.tailMode ?? null,
    summaryModel: config.summaryModel ?? null,
    updatedAt: numberValue(row.updated_at, 0) || null,
  });
}

export async function readPiOrganizationCompactionSettings(
  organizationId: string,
): Promise<PiOrganizationCompactionSettings> {
  const database = await openDb();
  try {
    const row = await database.get(
      `SELECT tail_mode, summary_model, revision, updated_at
       FROM ai_organization_compaction_settings
       WHERE organization_id = $1
       LIMIT 1`,
      [organizationId],
    ) as SettingsRow | undefined;
    return stateFromRow(row);
  } finally {
    await database.close();
  }
}

/**
 * Compares the revision inside a transaction, so independent organizations
 * and simultaneous administrators cannot overwrite one another's settings.
 */
export async function writePiOrganizationCompactionSettings(input: {
  organizationId: string;
  actorUserId: string;
  expectedRevision: number;
  config: PiCompactionRuntimeConfig;
}): Promise<PiOrganizationCompactionSettings> {
  const config = normalizedConfig(input.config);
  const database = await openDb();
  let transactionStarted = false;
  try {
    await database.run('BEGIN');
    transactionStarted = true;
    // The parent organization row exists even before a settings row. Locking
    // it closes the first-insert race that `FOR UPDATE` on a missing settings
    // row alone cannot serialize.
    await database.get(
      `SELECT organization_id
       FROM canvas_organization_settings
       WHERE organization_id = $1
       LIMIT 1 FOR UPDATE`,
      [input.organizationId],
    );
    const current = await database.get(
      `SELECT tail_mode, summary_model, revision, updated_at
       FROM ai_organization_compaction_settings
       WHERE organization_id = $1
       LIMIT 1 FOR UPDATE`,
      [input.organizationId],
    ) as SettingsRow | undefined;
    const currentState = stateFromRow(current);
    if (currentState.revision !== input.expectedRevision) {
      throw new PiOrganizationCompactionSettingsConflictError(currentState.revision);
    }
    const now = Date.now();
    const nextRevision = currentState.revision + 1;
    await database.run(
      `INSERT INTO ai_organization_compaction_settings (
         organization_id, tail_mode, summary_model, revision, updated_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id) DO UPDATE SET
         tail_mode = excluded.tail_mode,
         summary_model = excluded.summary_model,
         revision = excluded.revision,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = excluded.updated_at`,
      [input.organizationId, config.tailMode ?? null, config.summaryModel ?? null, nextRevision, input.actorUserId, now, now],
    );
    await database.run('COMMIT');
    transactionStarted = false;
    return Object.freeze({
      configured: true,
      revision: nextRevision,
      tailMode: config.tailMode ?? null,
      summaryModel: config.summaryModel ?? null,
      updatedAt: now,
    });
  } catch (error) {
    if (transactionStarted) {
      try { await database.run('ROLLBACK'); } catch { /* retain original error */ }
    }
    throw error;
  } finally {
    await database.close();
  }
}
