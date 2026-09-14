import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { openDb } from '@/app/lib/db';
import { FILE_VERSION_CENTER_LIMITS_V1 } from './policy-v1';

export type FileVersionContentFormat = 'markdown' | 'text' | 'structured' | 'binary';
export type FileVersionContentSource =
  | 'initial'
  | 'automatic_checkpoint'
  | 'manual'
  | 'agent_apply'
  | 'restore'
  | 'external_import'
  | 'legacy_guest';

export type FileVersionContentStoreLimits = {
  maxRawVersionBytes: number;
  maxStoredBlobBytes: number;
  maxCompressedBytesPerLineage: number;
  maxCompressedBytesPerWorkspace: number;
  maxVersionsPerLineage: number;
};

const DEFAULT_LIMITS: FileVersionContentStoreLimits = {
  maxRawVersionBytes: FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes,
  maxStoredBlobBytes: FILE_VERSION_CENTER_LIMITS_V1.maxStoredBlobBytes,
  maxCompressedBytesPerLineage: FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerLineage,
  maxCompressedBytesPerWorkspace: FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerWorkspace,
  maxVersionsPerLineage: FILE_VERSION_CENTER_LIMITS_V1.maxVersionsPerLineage,
};

export type PreparedFileVersionContent = {
  codec: 'gzip';
  sha256: string;
  rawSizeBytes: number;
  storedSizeBytes: number;
  compressedContent: Buffer;
};

export type FileVersionContentBinding = {
  revisionId: string;
  workspaceId: string;
  lineageId: string;
  blobId: string;
  format: FileVersionContentFormat;
  source: FileVersionContentSource;
  stateVectorHash: string | null;
  sha256: string;
  rawSizeBytes: number;
  storedSizeBytes: number;
  createdAt: number;
};

export type BindFileVersionContentResult = {
  binding: FileVersionContentBinding;
  outcome: 'created' | 'already_bound';
  deduplicated: boolean;
};

export type FileVersionStorageUsage = {
  lineageStoredBytes: number;
  workspaceStoredBytes: number;
  lineageVersionCount: number;
};

export type FileVersionContentStoreErrorCode =
  | 'invalid_input'
  | 'raw_version_too_large'
  | 'stored_blob_too_large'
  | 'revision_not_found'
  | 'revision_scope_mismatch'
  | 'revision_content_mismatch'
  | 'revision_already_bound'
  | 'lineage_quota_exceeded'
  | 'workspace_quota_exceeded'
  | 'version_count_exceeded'
  | 'content_corrupt';

export class FileVersionContentStoreError extends Error {
  constructor(readonly code: FileVersionContentStoreErrorCode, message: string) {
    super(message);
    this.name = 'FileVersionContentStoreError';
  }
}

type QueryResult<Row> = { rows: Row[]; rowCount?: number | null };

export type FileVersionContentTransaction = {
  query: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<QueryResult<Row>>;
};

export type FileVersionContentDatabase = {
  transaction: <T>(action: (transaction: FileVersionContentTransaction) => Promise<T>) => Promise<T>;
};

type BlobRow = {
  blob_id: string;
  workspace_id: string;
  content_sha256: string;
  codec: string;
  raw_size_bytes: number | string;
  stored_size_bytes: number | string;
  compressed_content: Buffer | Uint8Array;
  created_at: number | string;
};

type BindingRow = BlobRow & {
  revision_id: string;
  lineage_id: string;
  content_format: FileVersionContentFormat;
  source: FileVersionContentSource;
  state_vector_hash: string | null;
  bound_at: number | string;
};

function validScopedId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function positiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertLimits(limits: FileVersionContentStoreLimits): void {
  if (!Object.values(limits).every(positiveLimit)) {
    throw new FileVersionContentStoreError('invalid_input', 'Version storage limits must be positive safe integers.');
  }
}

function contentBuffer(content: string | Uint8Array): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
}

export function prepareFileVersionContent(
  content: string | Uint8Array,
  limits: FileVersionContentStoreLimits = DEFAULT_LIMITS,
): PreparedFileVersionContent {
  assertLimits(limits);
  const raw = contentBuffer(content);
  if (raw.byteLength > limits.maxRawVersionBytes) {
    throw new FileVersionContentStoreError('raw_version_too_large', 'The uncompressed version exceeds the storage limit.');
  }
  const compressedContent = gzipSync(raw, { level: 9 });
  if (compressedContent.byteLength > limits.maxStoredBlobBytes) {
    throw new FileVersionContentStoreError('stored_blob_too_large', 'The compressed version exceeds the storage limit.');
  }
  return {
    codec: 'gzip',
    sha256: createHash('sha256').update(raw).digest('hex'),
    rawSizeBytes: raw.byteLength,
    storedSizeBytes: compressedContent.byteLength,
    compressedContent,
  };
}

export function decodeFileVersionContent(
  blob: Pick<BlobRow, 'codec' | 'content_sha256' | 'raw_size_bytes' | 'stored_size_bytes' | 'compressed_content'>,
  limits: FileVersionContentStoreLimits = DEFAULT_LIMITS,
): Buffer {
  assertLimits(limits);
  const rawSizeBytes = Number(blob.raw_size_bytes);
  const storedSizeBytes = Number(blob.stored_size_bytes);
  const compressedContent = Buffer.from(blob.compressed_content);
  if (
    blob.codec !== 'gzip'
    || !/^[a-f0-9]{64}$/u.test(blob.content_sha256)
    || !Number.isSafeInteger(rawSizeBytes)
    || rawSizeBytes < 0
    || rawSizeBytes > limits.maxRawVersionBytes
    || !Number.isSafeInteger(storedSizeBytes)
    || storedSizeBytes <= 0
    || storedSizeBytes > limits.maxStoredBlobBytes
    || storedSizeBytes !== compressedContent.byteLength
  ) {
    throw new FileVersionContentStoreError('content_corrupt', 'Stored version metadata is invalid.');
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(compressedContent, { maxOutputLength: limits.maxRawVersionBytes + 1 });
  } catch {
    throw new FileVersionContentStoreError('content_corrupt', 'Stored version content cannot be decompressed safely.');
  }
  if (
    raw.byteLength !== rawSizeBytes
    || createHash('sha256').update(raw).digest('hex') !== blob.content_sha256
  ) {
    throw new FileVersionContentStoreError('content_corrupt', 'Stored version content failed integrity verification.');
  }
  return raw;
}

function databaseNumber(value: number | string | null | undefined): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new FileVersionContentStoreError('content_corrupt', 'Stored version counters are invalid.');
  }
  return number;
}

function advisoryLockId(scope: string): string {
  return createHash('sha256').update(scope).digest().readBigInt64BE().toString();
}

async function lockStorageScope(
  transaction: FileVersionContentTransaction,
  workspaceId: string,
  lineageId: string,
): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockId(`workspace:${workspaceId}`)]);
  await transaction.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockId(`lineage:${workspaceId}:${lineageId}`)]);
}

function runtimeFileVersionContentDatabase(): FileVersionContentDatabase {
  return {
    transaction: async <T>(action: (transaction: FileVersionContentTransaction) => Promise<T>) => {
      const connection = await openDb();
      let discard: Error | undefined;
      try {
        await connection.run('BEGIN');
        const transaction: FileVersionContentTransaction = {
          query: async <Row>(sql: string, params?: unknown[]) => ({
            rows: await connection.all(sql, params) as Row[],
          }),
        };
        const result = await action(transaction);
        await connection.run('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.run('ROLLBACK');
        } catch (rollbackError) {
          discard = rollbackError instanceof Error ? rollbackError : new Error('Version storage rollback failed.');
        }
        throw error;
      } finally {
        await connection.close(discard);
      }
    },
  };
}

function bindingFromRow(row: BindingRow): FileVersionContentBinding {
  return {
    revisionId: row.revision_id,
    workspaceId: row.workspace_id,
    lineageId: row.lineage_id,
    blobId: row.blob_id,
    format: row.content_format,
    source: row.source,
    stateVectorHash: row.state_vector_hash,
    sha256: row.content_sha256,
    rawSizeBytes: databaseNumber(row.raw_size_bytes),
    storedSizeBytes: databaseNumber(row.stored_size_bytes),
    createdAt: databaseNumber(row.bound_at),
  };
}

async function selectBinding(
  transaction: FileVersionContentTransaction,
  input: { workspaceId: string; lineageId: string; revisionId: string },
): Promise<BindingRow | null> {
  const result = await transaction.query<BindingRow>(`
    SELECT contents.revision_id, contents.workspace_id, contents.lineage_id,
      contents.content_format, contents.source, contents.state_vector_hash,
      contents.created_at AS bound_at, blobs.*
    FROM file_revision_contents contents
    INNER JOIN file_version_blobs blobs ON blobs.blob_id = contents.blob_id
    WHERE contents.revision_id = $1 AND contents.workspace_id = $2 AND contents.lineage_id = $3
  `, [input.revisionId, input.workspaceId, input.lineageId]);
  return result.rows[0] ?? null;
}

async function storageUsage(
  transaction: FileVersionContentTransaction,
  workspaceId: string,
  lineageId: string,
): Promise<FileVersionStorageUsage> {
  const workspace = await transaction.query<{ stored_bytes: number | string }>(`
    SELECT COALESCE(SUM(stored_size_bytes), 0) AS stored_bytes
    FROM file_version_blobs WHERE workspace_id = $1
  `, [workspaceId]);
  const lineage = await transaction.query<{
    stored_bytes: number | string;
    version_count: number | string;
  }>(`
    SELECT COALESCE(SUM(blob.stored_size_bytes), 0) AS stored_bytes,
      COALESCE((SELECT COUNT(*) FROM file_revision_contents WHERE workspace_id = $1 AND lineage_id = $2), 0) AS version_count
    FROM file_version_blobs blob
    WHERE blob.workspace_id = $1 AND EXISTS (
      SELECT 1 FROM file_revision_contents contents
      WHERE contents.workspace_id = $1 AND contents.lineage_id = $2 AND contents.blob_id = blob.blob_id
    )
  `, [workspaceId, lineageId]);
  return {
    workspaceStoredBytes: databaseNumber(workspace.rows[0]?.stored_bytes),
    lineageStoredBytes: databaseNumber(lineage.rows[0]?.stored_bytes),
    lineageVersionCount: databaseNumber(lineage.rows[0]?.version_count),
  };
}

function assertCaptureAdmission(input: {
  limits: FileVersionContentStoreLimits;
  usage: FileVersionStorageUsage;
  incomingWorkspaceBytes: number;
  incomingLineageBytes: number;
}): void {
  if (input.usage.workspaceStoredBytes + input.incomingWorkspaceBytes > input.limits.maxCompressedBytesPerWorkspace) {
    throw new FileVersionContentStoreError('workspace_quota_exceeded', 'The workspace version-content quota is exhausted.');
  }
  if (input.usage.lineageStoredBytes + input.incomingLineageBytes > input.limits.maxCompressedBytesPerLineage) {
    throw new FileVersionContentStoreError('lineage_quota_exceeded', 'The document version-content quota is exhausted.');
  }
  if (input.usage.lineageVersionCount + 1 > input.limits.maxVersionsPerLineage) {
    throw new FileVersionContentStoreError('version_count_exceeded', 'The document version-count quota is exhausted.');
  }
}

export type FileVersionContentStore = ReturnType<typeof createFileVersionContentStore>;

export function createFileVersionContentStore(options: {
  database?: FileVersionContentDatabase;
  limits?: FileVersionContentStoreLimits;
  now?: () => number;
  id?: () => string;
} = {}) {
  const database = options.database ?? runtimeFileVersionContentDatabase();
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => `fvb-${randomUUID()}`);
  assertLimits(limits);

  return {
    async bindRevisionContent(input: {
      revisionId: string;
      workspaceId: string;
      lineageId: string;
      content: string | Uint8Array;
      format: FileVersionContentFormat;
      source: FileVersionContentSource;
      stateVectorHash?: string | null;
    }): Promise<BindFileVersionContentResult> {
      if (![input.revisionId, input.workspaceId, input.lineageId].every(validScopedId)) {
        throw new FileVersionContentStoreError('invalid_input', 'Revision, workspace and lineage IDs are invalid.');
      }
      if (input.stateVectorHash && (input.stateVectorHash.length < 16 || input.stateVectorHash.length > 256)) {
        throw new FileVersionContentStoreError('invalid_input', 'State-vector hash is invalid.');
      }
      const prepared = prepareFileVersionContent(input.content, limits);
      return database.transaction(async (transaction) => {
        await lockStorageScope(transaction, input.workspaceId, input.lineageId);
        const revisionResult = await transaction.query<{
          id: string;
          workspace_id: string;
          lineage_id: string | null;
          content_hash: string;
          size_bytes: number | string;
        }>(`
          SELECT id, workspace_id, lineage_id, content_hash, size_bytes
          FROM file_revisions WHERE id = $1 FOR UPDATE
        `, [input.revisionId]);
        const revision = revisionResult.rows[0];
        if (!revision) throw new FileVersionContentStoreError('revision_not_found', 'The revision does not exist.');
        if (revision.workspace_id !== input.workspaceId || revision.lineage_id !== input.lineageId) {
          throw new FileVersionContentStoreError('revision_scope_mismatch', 'The revision does not belong to this workspace and lineage.');
        }
        if (revision.content_hash !== prepared.sha256 || Number(revision.size_bytes) !== prepared.rawSizeBytes) {
          throw new FileVersionContentStoreError('revision_content_mismatch', 'The supplied content does not match the revision ledger.');
        }

        const existingBinding = await selectBinding(transaction, input);
        if (existingBinding) {
          decodeFileVersionContent(existingBinding, limits);
          if (
            existingBinding.content_sha256 !== prepared.sha256
            || existingBinding.content_format !== input.format
            || existingBinding.source !== input.source
            || existingBinding.state_vector_hash !== (input.stateVectorHash ?? null)
          ) {
            throw new FileVersionContentStoreError('revision_already_bound', 'The immutable revision already has different content metadata.');
          }
          return { binding: bindingFromRow(existingBinding), outcome: 'already_bound', deduplicated: true };
        }

        const blobResult = await transaction.query<BlobRow>(`
          SELECT * FROM file_version_blobs WHERE workspace_id = $1 AND content_sha256 = $2
        `, [input.workspaceId, prepared.sha256]);
        const existingBlob = blobResult.rows[0] ?? null;
        if (existingBlob) decodeFileVersionContent(existingBlob, limits);
        const lineageHasBlob = existingBlob ? await transaction.query<{ present: number }>(`
          SELECT 1 AS present FROM file_revision_contents
          WHERE workspace_id = $1 AND lineage_id = $2 AND blob_id = $3 LIMIT 1
        `, [input.workspaceId, input.lineageId, existingBlob.blob_id]) : { rows: [] };
        const usage = await storageUsage(transaction, input.workspaceId, input.lineageId);
        assertCaptureAdmission({
          limits,
          usage,
          incomingWorkspaceBytes: existingBlob ? 0 : prepared.storedSizeBytes,
          incomingLineageBytes: lineageHasBlob.rows.length > 0 ? 0 : prepared.storedSizeBytes,
        });

        let blobId = existingBlob?.blob_id;
        if (!blobId) {
          blobId = id();
          await transaction.query(`
            INSERT INTO file_version_blobs (
              blob_id, workspace_id, content_sha256, codec, raw_size_bytes,
              stored_size_bytes, compressed_content, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [blobId, input.workspaceId, prepared.sha256, prepared.codec, prepared.rawSizeBytes,
            prepared.storedSizeBytes, prepared.compressedContent, now()]);
        }
        await transaction.query(`
          INSERT INTO file_revision_contents (
            revision_id, workspace_id, lineage_id, blob_id, content_format,
            source, state_vector_hash, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [input.revisionId, input.workspaceId, input.lineageId, blobId, input.format,
          input.source, input.stateVectorHash ?? null, now()]);
        const created = await selectBinding(transaction, input);
        if (!created) throw new FileVersionContentStoreError('content_corrupt', 'The revision binding was not committed.');
        decodeFileVersionContent(created, limits);
        return {
          binding: bindingFromRow(created),
          outcome: 'created',
          deduplicated: Boolean(existingBlob),
        };
      });
    },

    async readRevisionContent(input: {
      revisionId: string;
      workspaceId: string;
      lineageId: string;
    }): Promise<{ binding: FileVersionContentBinding; content: Buffer } | null> {
      if (![input.revisionId, input.workspaceId, input.lineageId].every(validScopedId)) {
        throw new FileVersionContentStoreError('invalid_input', 'Revision, workspace and lineage IDs are invalid.');
      }
      return database.transaction(async (transaction) => {
        const row = await selectBinding(transaction, input);
        return row ? { binding: bindingFromRow(row), content: decodeFileVersionContent(row, limits) } : null;
      });
    },

    async getStorageUsage(input: {
      workspaceId: string;
      lineageId: string;
    }): Promise<FileVersionStorageUsage> {
      if (![input.workspaceId, input.lineageId].every(validScopedId)) {
        throw new FileVersionContentStoreError('invalid_input', 'Workspace and lineage IDs are invalid.');
      }
      return database.transaction((transaction) => storageUsage(transaction, input.workspaceId, input.lineageId));
    },

    /**
     * Low-level retention primitive. The history orchestrator chooses candidates
     * using the V1 age/rank rules; storage still refuses protected or pending
     * review bindings and removes only blobs that become unreferenced.
     */
    async pruneAutomaticCheckpointContents(input: {
      workspaceId: string;
      lineageId: string;
      revisionIds: string[];
    }): Promise<{ deletedRevisionIds: string[]; deletedBlobCount: number }> {
      if (
        !validScopedId(input.workspaceId)
        || !validScopedId(input.lineageId)
        || input.revisionIds.length > 500
        || !input.revisionIds.every(validScopedId)
      ) {
        throw new FileVersionContentStoreError('invalid_input', 'Retention scope or revision IDs are invalid.');
      }
      if (input.revisionIds.length === 0) return { deletedRevisionIds: [], deletedBlobCount: 0 };
      return database.transaction(async (transaction) => {
        await lockStorageScope(transaction, input.workspaceId, input.lineageId);
        const deleted = await transaction.query<{ revision_id: string }>(`
          DELETE FROM file_revision_contents contents
          WHERE contents.workspace_id = $1
            AND contents.lineage_id = $2
            AND contents.revision_id = ANY($3)
            AND contents.source = 'automatic_checkpoint'
            AND NOT EXISTS (
              SELECT 1 FROM file_change_group_entries entry
              WHERE entry.revision_id = contents.revision_id
                AND entry.outcome = 'review_required'
            )
          RETURNING revision_id
        `, [input.workspaceId, input.lineageId, input.revisionIds]);
        const deletedBlobs = await transaction.query<{ blob_id: string }>(`
          DELETE FROM file_version_blobs blob
          WHERE blob.workspace_id = $1 AND NOT EXISTS (
            SELECT 1 FROM file_revision_contents contents WHERE contents.blob_id = blob.blob_id
          )
          RETURNING blob_id
        `, [input.workspaceId]);
        return {
          deletedRevisionIds: deleted.rows.map((row) => row.revision_id),
          deletedBlobCount: deletedBlobs.rows.length,
        };
      });
    },

    async deleteUnreferencedBlobs(input: { workspaceId: string }): Promise<number> {
      if (!validScopedId(input.workspaceId)) {
        throw new FileVersionContentStoreError('invalid_input', 'Workspace ID is invalid.');
      }
      return database.transaction(async (transaction) => {
        await transaction.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockId(`workspace:${input.workspaceId}`)]);
        const deleted = await transaction.query<{ blob_id: string }>(`
          DELETE FROM file_version_blobs blob
          WHERE blob.workspace_id = $1 AND NOT EXISTS (
            SELECT 1 FROM file_revision_contents contents WHERE contents.blob_id = blob.blob_id
          )
          RETURNING blob_id
        `, [input.workspaceId]);
        return deleted.rows.length;
      });
    },
  };
}

export const fileVersionContentStore = createFileVersionContentStore();
