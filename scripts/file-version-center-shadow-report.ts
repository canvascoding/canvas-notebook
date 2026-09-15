import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';

import {
  evaluateFileVersionCenterShadowReport,
  type FileVersionCenterReadObservation,
  type FileVersionCenterShadowCaptureSample,
  type FileVersionCenterShadowStorageSnapshot,
} from '../app/lib/file-version-center/rollout-report';

type StorageRow = Record<keyof FileVersionCenterShadowStorageSnapshot, number | string>;

function numeric(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Shadow storage aggregate is invalid.');
  return parsed;
}

function parseLines(value: string): {
  captures: FileVersionCenterShadowCaptureSample[];
  reads: FileVersionCenterReadObservation[];
} {
  const captures: FileVersionCenterShadowCaptureSample[] = [];
  const reads: FileVersionCenterReadObservation[] = [];
  for (const line of value.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (parsed.component === 'file_version_center_shadow_capture'
      && parsed.mode === 'shadow' && parsed.outcome === 'success') {
      const durations = Array.isArray(parsed.durationsMs) ? parsed.durationsMs.map(numeric) : [];
      captures.push({
        capturedBindingsDelta: numeric(parsed.capturedBindingsDelta),
        uniqueBlobDelta: numeric(parsed.uniqueBlobDelta),
        storedBytesDelta: numeric(parsed.storedBytesDelta),
        durationsMs: durations,
        documentAccessVerified: parsed.documentAccessVerified === true,
        uiHiddenVerified: parsed.uiHiddenVerified === true,
      });
    }
    if (parsed.component === 'file_version_center'
      && (parsed.operation === 'resolve' || parsed.operation === 'timeline' || parsed.operation === 'compare')
      && (parsed.outcome === 'success' || parsed.outcome === 'truncated')
      && parsed.durationMs !== undefined) {
      reads.push({
        operation: parsed.operation,
        outcome: parsed.outcome,
        durationMs: numeric(parsed.durationMs),
      });
    }
  }
  return { captures, reads };
}

async function storageSnapshot(pool: Pool): Promise<FileVersionCenterShadowStorageSnapshot> {
  const result = await pool.query<StorageRow>(`
    WITH lineage_blobs AS (
      SELECT DISTINCT contents.workspace_id, contents.lineage_id, contents.blob_id
      FROM file_revision_contents contents
    ), lineage_usage AS (
      SELECT lineage_blobs.workspace_id, lineage_blobs.lineage_id,
        COALESCE(SUM(blobs.stored_size_bytes), 0)::bigint AS stored_bytes
      FROM lineage_blobs
      INNER JOIN file_version_blobs blobs
        ON blobs.workspace_id = lineage_blobs.workspace_id AND blobs.blob_id = lineage_blobs.blob_id
      GROUP BY lineage_blobs.workspace_id, lineage_blobs.lineage_id
    ), lineage_versions AS (
      SELECT workspace_id, lineage_id, COUNT(*)::bigint AS version_count
      FROM file_revision_contents GROUP BY workspace_id, lineage_id
    ), workspace_usage AS (
      SELECT workspace_id, COALESCE(SUM(stored_size_bytes), 0)::bigint AS stored_bytes
      FROM file_version_blobs GROUP BY workspace_id
    )
    SELECT
      (SELECT COUNT(DISTINCT workspace_id)::bigint FROM file_revision_contents) AS "workspaceCount",
      (SELECT COUNT(DISTINCT (workspace_id, lineage_id))::bigint FROM file_revision_contents) AS "lineageCount",
      (SELECT COUNT(*)::bigint FROM file_revision_contents) AS "capturedVersionCount",
      (SELECT COUNT(*)::bigint FROM file_version_blobs) AS "uniqueBlobCount",
      (SELECT COALESCE(SUM(raw_size_bytes), 0)::bigint FROM file_version_blobs) AS "totalRawBytes",
      (SELECT COALESCE(SUM(stored_size_bytes), 0)::bigint FROM file_version_blobs) AS "totalStoredBytes",
      (SELECT COALESCE(MAX(raw_size_bytes), 0)::bigint FROM file_version_blobs) AS "maxRawVersionBytes",
      (SELECT COALESCE(MAX(stored_size_bytes), 0)::bigint FROM file_version_blobs) AS "maxStoredBlobBytes",
      (SELECT COALESCE(MAX(stored_bytes), 0)::bigint FROM lineage_usage) AS "maxLineageStoredBytes",
      (SELECT COALESCE(MAX(stored_bytes), 0)::bigint FROM workspace_usage) AS "maxWorkspaceStoredBytes",
      (SELECT COALESCE(MAX(version_count), 0)::bigint FROM lineage_versions) AS "maxLineageVersionCount"
  `);
  const row = result.rows[0];
  if (!row) throw new Error('Shadow storage aggregate is unavailable.');
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, numeric(value)]),
  ) as FileVersionCenterShadowStorageSnapshot;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const inputPath = process.argv[2];
  const logInput = inputPath ? await readFile(inputPath, 'utf8') : await readStdin();
  const samples = parseLines(logInput);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const report = evaluateFileVersionCenterShadowReport({
      mode: process.env.FILE_VERSION_CENTER_MODE,
      storage: await storageSnapshot(pool),
      captures: samples.captures,
      reads: samples.reads,
      latencyLimitMs: process.env.FVRC_SHADOW_P95_LIMIT_MS
        ? numeric(process.env.FVRC_SHADOW_P95_LIMIT_MS)
        : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passing) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error('file-version-center-shadow-report: failed');
  process.exitCode = 1;
});
