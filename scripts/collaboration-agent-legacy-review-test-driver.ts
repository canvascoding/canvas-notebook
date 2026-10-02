/** Explicit historical-review fixture; ordinary PI/MCP tools retain their graph guards. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedAgentApplyResult } from '../app/lib/collaboration/agent-operations';
import { requireOwnedCollaborationQaTarget, type OwnedCollaborationQaTarget } from './lib/owned-collaboration-qa';

export type LegacyReviewDriverInput = {
  contractVersion: 1;
  requestId: string;
  session: { sessionId: string; agentId: string; userId: string; workspaceId: string; title: string; createdAt: string };
  document: { documentId: string; path: string; lifecycleGeneration: number; schemaVersion: number };
  expectedSha256: string;
  expectedEditorJson: unknown;
  edit: { oldText: string; newText: string; expectedOccurrences: 1 };
};
export type LegacyReviewDriverOutput = {
  contractVersion: 1; success: true; requestId: string;
  operation: PersistedAgentApplyResult; noDurableMutation: true;
};
export type LegacyReviewDriverFailure = {
  contractVersion: 1; success: false; requestId?: string;
  operation?: PersistedAgentApplyResult; noDurableMutation: false; stage: string;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_INPUT_BYTES = 256 * 1024;

function requireLegacyDriverValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('The historical review fixture proof was rejected.');
}

function parseLegacyReviewDriverInput(): LegacyReviewDriverInput {
  const encoded = process.argv[2];
  requireLegacyDriverValue(process.argv.length === 3 && typeof encoded === 'string'
    && encoded.length <= Math.ceil(MAX_INPUT_BYTES * 4 / 3) && /^[A-Za-z0-9_-]+$/u.test(encoded));
  const bytes = Buffer.from(encoded, 'base64url');
  requireLegacyDriverValue(bytes.length <= MAX_INPUT_BYTES && bytes.toString('base64url') === encoded);
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  const exactKeys = (object: unknown, keys: string[]): object is Record<string, unknown> =>
    Boolean(object && typeof object === 'object' && !Array.isArray(object)
      && isDeepStrictEqual(Object.keys(object).sort(), [...keys].sort()));
  requireLegacyDriverValue(exactKeys(value, ['contractVersion', 'requestId', 'session', 'document',
    'expectedSha256', 'expectedEditorJson', 'edit']));
  requireLegacyDriverValue(value.contractVersion === 1 && typeof value.requestId === 'string' && UUID.test(value.requestId));
  requireLegacyDriverValue(exactKeys(value.session, ['sessionId', 'agentId', 'userId', 'workspaceId', 'title', 'createdAt'])
    && exactKeys(value.document, ['documentId', 'path', 'lifecycleGeneration', 'schemaVersion'])
    && exactKeys(value.edit, ['oldText', 'newText', 'expectedOccurrences']));
  const { session, document, edit } = value;
  const identifier = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\r\n\0]/u.test(id);
  requireLegacyDriverValue(['sessionId', 'agentId', 'userId', 'workspaceId'].every(key => identifier(session[key]))
    && identifier(document.documentId));
  requireLegacyDriverValue(typeof document.path === 'string'
    && document.path.startsWith('agent-review-lifecycle-') && document.path.endsWith('.md')
    && UUID.test(document.path.slice('agent-review-lifecycle-'.length, -3))
    && session.title === `Synthetic agent review lifecycle acceptance:${document.path}`);
  requireLegacyDriverValue(typeof session.createdAt === 'string' && Number.isFinite(Date.parse(session.createdAt))
    && new Date(session.createdAt).toISOString() === session.createdAt);
  requireLegacyDriverValue(['lifecycleGeneration', 'schemaVersion'].every(key =>
    Number.isSafeInteger(document[key]) && Number(document[key]) >= 1));
  requireLegacyDriverValue(typeof value.expectedSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.expectedSha256)
    && value.expectedEditorJson && typeof value.expectedEditorJson === 'object' && !Array.isArray(value.expectedEditorJson)
    && (value.expectedEditorJson as Record<string, unknown>).type === 'doc');
  requireLegacyDriverValue(edit.expectedOccurrences === 1 && typeof edit.oldText === 'string' && edit.oldText.length > 0
    && typeof edit.newText === 'string' && edit.oldText !== edit.newText);
  return value as LegacyReviewDriverInput;
}

async function withLegacyReviewReadOnly<T>(
  databaseModule: typeof import('../app/lib/db'), target: OwnedCollaborationQaTarget,
  read: (database: SqlConnection) => Promise<T>,
): Promise<T> {
  const database = await databaseModule.openDb();
  let discard: Error | undefined;
  try {
    await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await database.run("SET LOCAL statement_timeout = '5s'");
    const identity = await database.get(`SELECT d.oid::text AS oid, current_database() AS name,
      current_user=(SELECT rolname FROM pg_roles WHERE oid=d.datdba) AS owned
      FROM pg_database d WHERE d.datname=current_database()`) as { oid: string; name: string; owned: boolean } | undefined;
    requireLegacyDriverValue(identity?.oid === target.cloneOid && identity.name === target.cloneDatabase && identity.owned === true);
    const result = await read(database);
    await database.run('COMMIT');
    return result;
  } catch (error) {
    try { await database.run('ROLLBACK'); } catch { discard = new Error('Read-only fixture transaction release was unconfirmed.'); }
    throw error;
  } finally {
    await database.close(discard);
  }
}

async function readLegacyReviewDriverFile(workspace: WorkspaceContext, input: LegacyReviewDriverInput, target: OwnedCollaborationQaTarget) {
  const root = await realpath(workspace.rootPath);
  requireLegacyDriverValue(root.startsWith(`${target.dataRoot}${path.sep}`));
  const filename = path.join(root, input.document.path);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    requireLegacyDriverValue(before.isFile() && before.uid === process.getuid?.() && before.size <= 5 * 1024 * 1024);
    const bytes = await file.readFile();
    const after = await file.stat();
    requireLegacyDriverValue(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && await realpath(filename) === filename);
    return { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}

async function readLegacyReviewDriverSnapshot(databaseModule: typeof import('../app/lib/db'), target: OwnedCollaborationQaTarget,
  input: LegacyReviewDriverInput, workspace: WorkspaceContext) {
  const stored = await withLegacyReviewReadOnly(databaseModule, target, async (database) => {
    const document = await database.get(`SELECT * FROM collaboration_documents
      WHERE id=$1 AND workspace_id=$2 AND path=$3 AND provider='yjs' AND status='active'`,
    [input.document.documentId, workspace.workspaceId, input.document.path]) as Record<string, unknown> | undefined;
    requireLegacyDriverValue(document && typeof document.lineage_id === 'string');
    const state = await database.get(`SELECT * FROM collaboration_yjs_states
      WHERE document_id=$1 AND workspace_id=$2 AND path=$3 AND status='active'`,
    [input.document.documentId, workspace.workspaceId, input.document.path]) as Record<string, unknown> | undefined;
    requireLegacyDriverValue(state && Number(state.lifecycle_generation) === input.document.lifecycleGeneration
      && Number(state.schema_version) === input.document.schemaVersion && state.representation === 'tiptap_blocks'
      && Number(state.document_sequence) === Number(state.checkpoint_sequence) && Number(state.degraded) === 0);
    const lineage = await database.get(`SELECT * FROM file_collaboration_lineages
      WHERE id=$1 AND workspace_id=$2 AND path=$3 AND status='active'`,
    [document.lineage_id, workspace.workspaceId, input.document.path]);
    requireLegacyDriverValue(lineage);
    const revisions = await database.all(`SELECT r.*, c.blob_id, c.source, c.content_format, c.state_vector_hash,
      b.content_sha256, b.raw_size_bytes, b.stored_size_bytes, b.compressed_content
      FROM file_revisions r
      LEFT JOIN file_revision_contents c ON c.revision_id=r.id AND c.workspace_id=r.workspace_id AND c.lineage_id=r.lineage_id
      LEFT JOIN file_version_blobs b ON b.blob_id=c.blob_id AND b.workspace_id=c.workspace_id
      WHERE r.workspace_id=$1 AND r.lineage_id=$2 ORDER BY r.id`, [workspace.workspaceId, document.lineage_id]);
    return { document, state, lineage, revisions };
  });
  return { stored, file: await readLegacyReviewDriverFile(workspace, input, target) };
}

async function runLegacyReviewDriver(input: LegacyReviewDriverInput, target: OwnedCollaborationQaTarget,
  databaseModule: typeof import('../app/lib/db'), progress: { stage: string; operation?: PersistedAgentApplyResult }) {
  const sessions = await import('../app/lib/pi/session-workspace-context');
  const edits = await import('../app/lib/collaboration/agent-file-edits');
  const { readRichDocumentJson } = await import('../app/lib/collaboration/rich-document');
  const { hashProposalValue } = await import('../app/lib/file-version-center/proposal-action-fence');
  const { Y } = await import('../app/lib/collaboration/server-runtime');
  progress.stage = 'session_authority';
  const workspace = await withLegacyReviewReadOnly(databaseModule, target, async (database) => {
    const session = await database.get(`SELECT title, created_at FROM pi_sessions
      WHERE session_id=$1 AND agent_id=$2 AND user_id=$3 AND workspace_id=$4 AND archived_at IS NULL`,
    [input.session.sessionId, input.session.agentId, input.session.userId, input.session.workspaceId]) as
      { title: string; created_at: number | string } | undefined;
    const createdAt = Number(session?.created_at);
    requireLegacyDriverValue(session?.title === input.session.title
      && Number.isSafeInteger(createdAt) && createdAt > 0 && createdAt === Date.parse(input.session.createdAt));
    const existing = await database.get(`SELECT operation_id FROM collaboration_agent_operations
      WHERE document_id=$1 AND initiated_by_user_id=$2 AND idempotency_key=$3`,
    [input.document.documentId, input.session.userId, input.requestId]);
    requireLegacyDriverValue(!existing); // A fresh historical fixture never reconciles an already applied operation.
    return sessions.readStoredAgentWorkspaceOnConnection(database, {
      sessionId: input.session.sessionId, userId: input.session.userId,
      agentId: input.session.agentId, workspaceId: input.session.workspaceId,
      permissions: ['canRead', 'canWrite', 'canRunAgent'],
    });
  });
  progress.stage = 'baseline';
  const before = await readLegacyReviewDriverSnapshot(databaseModule, target, input, workspace);
  progress.stage = 'prepare_text_edit';
  const prepared = await edits.prepareCollaborationTextEdit({ documentId: input.document.documentId, workspace,
    path: input.document.path, edits: [input.edit], expectedSha256: input.expectedSha256, groupId: input.requestId });
  progress.stage = 'prepared_source_proof';
  requireLegacyDriverValue(prepared.sourceUpdate && prepared.sha256 === input.expectedSha256
    && prepared.lifecycleGeneration === input.document.lifecycleGeneration && prepared.schemaVersion === input.document.schemaVersion);
  const clone = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(clone, prepared.sourceUpdate);
    progress.stage = 'prepared_editor_json';
    requireLegacyDriverValue(hashProposalValue(readRichDocumentJson(clone)) === hashProposalValue(input.expectedEditorJson));
  } finally { clone.destroy(); }
  progress.stage = 'create_review';
  const operation = await edits.executePreparedCollaborationTextEdit({
    prepared: { ...prepared, requestedMode: 'review' }, workspace,
    identity: { initiatedByUserId: input.session.userId, actorId: input.session.agentId,
      actorSessionId: input.session.sessionId, actorDisplayName: 'Historical lifecycle fixture' },
    idempotencyKey: input.requestId,
  });
  progress.operation = operation; // Preserve the real committed receipt even if a subsequent proof fails.
  progress.stage = 'receipt';
  requireLegacyDriverValue(operation.status === 'needs_review' && operation.operationStatus === 'needs_review'
    && operation.durability === 'needs_review' && operation.appliedTargetIds.length === 0 && operation.conflicts.length === 0);
  progress.stage = 'no_durable_mutation';
  const after = await readLegacyReviewDriverSnapshot(databaseModule, target, input, workspace);
  requireLegacyDriverValue(isDeepStrictEqual(before, after));
  return operation;
}

async function main(): Promise<void> {
  const progress: { stage: string; operation?: PersistedAgentApplyResult } = { stage: 'owned_qa_target' };
  let input: LegacyReviewDriverInput | undefined;
  let databaseModule: typeof import('../app/lib/db') | undefined;
  let output: LegacyReviewDriverOutput | LegacyReviewDriverFailure;
  try {
    const target = await requireOwnedCollaborationQaTarget(); // FIRST: no application modules before the exact QA guard.
    progress.stage = 'input';
    input = parseLegacyReviewDriverInput();
    progress.stage = 'application_import';
    databaseModule = await import('../app/lib/db');
    const operation = await runLegacyReviewDriver(input, target, databaseModule, progress);
    output = { contractVersion: 1, success: true, requestId: input.requestId, operation, noDurableMutation: true };
  } catch {
    output = { contractVersion: 1, success: false, requestId: input?.requestId,
      operation: progress.operation, noDurableMutation: false, stage: progress.stage };
    process.exitCode = 1;
  } finally {
    try { await databaseModule?.closeDatabaseConnections(); } catch {
      output = { contractVersion: 1, success: false, requestId: input?.requestId,
        operation: progress.operation, noDurableMutation: false, stage: 'database_shutdown' };
      process.exitCode = 1;
    }
  }
  // Never exit before committed receipts, connection release and stdout completion.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(output)}\n`, error => error ? reject(error) : resolve());
  });
}

void main().catch(() => { process.exitCode = 1; });
