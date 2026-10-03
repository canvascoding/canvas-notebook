import 'server-only';

import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { withWorkspaceMutationLock } from '@/app/lib/secrets/file-mutation-lock';
import { materializeCollaborationCheckpoint, authoritativeCollaborationSnapshot } from './checkpoint';
import { prepareCodeMarkConflictRepair } from './code-mark-repair';
import { serializeCanonicalText, type PersistedCollaborationState } from './persistence';
import { recoveryHash, planCollaborationRecovery } from './recovery-plan';
import { buildCollaborationRecoveryEvidence, decodeRecoveryState, observeRecoveryFile,
  recoveryPostgresInteger, recoveryPostgresFlag, recoveryStateFingerprint, type RecoveryRows, type RecoveryRow } from './recovery-evidence';
import { withOfflineCollaborationRecoveryGuards, applyCodeMarkRecoveryClone, archiveCollaborationRecoveryOrphan } from './recovery-state-mutations';
import { importHistoricalCollaborationIdentity, type HistoricalCollaborationIdentityImport } from './recovery-identity-import';
import { executeLifecycleTransaction } from './lifecycle-transaction';

type HistoricalIdentity = Pick<HistoricalCollaborationIdentityImport, 'document' | 'revision' | 'lineage'>;
type WorkspaceIdentity = { id: string; organizationId: string | null; customerId: string | null; projectId: string | null;
  type: WorkspaceContext['workspaceType']; rootRelativePath: string; status: 'active' };
type Operation = {
  id: string; kind: 'recover_orphans' | 'repair_code_marks' | 'import_historical_identity';
  documentId: string; workspace: WorkspaceIdentity; expectedState: RecoveryRow; expectedRegistry: RecoveryRow | null;
  expectedRevision: RecoveryRow | null; expectedFileHash: string; projectedFileHash: string;
  orphans: Array<{ expectedState: RecoveryRow; caseFingerprint: string }>;
  repairedYjsHash?: string; lostFormatting?: Array<{ mark: string; utf16Units: number }>; historicalIdentity?: HistoricalIdentity;
};
export type RecoverySelection = { version: 1; bundleManifestHash: string;
  operations: Array<Operation & { selected: boolean }>; manual: Array<{ documentId: string; reason: string }> };
export type RecoveryBundle = { manifestHash: string; rows: RecoveryRows; evidence: ReturnType<typeof buildCollaborationRecoveryEvidence>;
  historicalIdentities: HistoricalIdentity[] };
export type RecoveryExecutionProof = {
  version: 1; bundleManifestHash: string; backupId: string;
  backup: { archive: string; archiveHash: string; completedAt: string; report: string; reportHash: string };
  restore: { backupId: string; result: 'passed'; verifiedAt: string; report: string; reportHash: string;
    checks: Array<'postgres' | 'workspace_files' | 'yjs_bytes' | 'registry' | 'revisions' | 'shares'> };
  writerDrain: { verifiedAt: string; report: string; reportHash: string };
};

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalize(child)])) : Array.isArray(item) ? item.map(normalize) : item;
  return JSON.stringify(normalize(value));
}
function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Recovery rejected: ${reason}.`); }
function recordCanonical(row: unknown): string {
  if (!row || typeof row !== 'object') return canonical(row);
  const integers = new Set(['state_version', 'created_at', 'updated_at', 'revision_number', 'size_bytes']);
  return canonical(Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    integers.has(key) && value !== null ? recoveryPostgresInteger(value)
      : key === 'history_only' ? recoveryPostgresFlag(value) : value])));
}
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const nullableText = (value: unknown) => { requireValue(value === null || typeof value === 'string', 'invalid scope'); return value as string | null; };
function workspaceIdentity(row: RecoveryRow): WorkspaceIdentity {
  requireValue(typeof row.id === 'string' && typeof row.root_relative_path === 'string' && row.status === 'active'
    && ['personal', 'organization', 'team', 'project'].includes(row.type as string), 'invalid workspace');
  return { id: row.id, organizationId: nullableText(row.organization_id), customerId: nullableText(row.customer_id),
    projectId: nullableText(row.project_id), type: row.type as WorkspaceContext['workspaceType'], rootRelativePath: row.root_relative_path, status: 'active' };
}
function workspaceContext(workspace: WorkspaceIdentity): WorkspaceContext {
  return { workspaceId: workspace.id, workspaceType: workspace.type, rootRelativePath: workspace.rootRelativePath,
    rootPath: workspaceAbsoluteRoot(workspace.rootRelativePath), organizationId: workspace.organizationId,
    customerId: workspace.customerId, projectId: workspace.projectId, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false } };
}
function scoped(row: RecoveryRow, state: PersistedCollaborationState, workspace: WorkspaceIdentity): boolean {
  return row.workspace_id === state.workspaceId && row.organization_id === state.organizationId && row.path === state.path
    && row.workspace_type === workspace.type && row.customer_id === workspace.customerId && row.project_id === workspace.projectId;
}
function revisionVerified(row: RecoveryRow | undefined, state: PersistedCollaborationState, workspace: WorkspaceIdentity): row is RecoveryRow {
  return Boolean(row && scoped(row, state, workspace) && row.content_hash === state.serializedHash
    && hashValid(row.content_hash) && recoveryPostgresInteger(row.size_bytes) <= 5 * 1024 * 1024
    && recoveryPostgresInteger(row.revision_number, 1) > 0 && !recoveryPostgresFlag(row.history_only));
}

/** Immutable bundle integrity is checked before its JSON can authorize any operation. */
export async function readCollaborationRecoveryBundle(directory: string): Promise<RecoveryBundle> {
  requireValue(path.isAbsolute(directory), 'absolute bundle path required');
  const manifestBytes = await readPrivateRegularFile(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  requireValue(manifest.version === 1 && manifest.complete === true && manifest.artifacts && typeof manifest.artifacts === 'object', 'incomplete bundle');
  const verified = new Map<string, Buffer>();
  for (const [name, expectedHash] of Object.entries(manifest.artifacts)) {
    requireValue(name === path.basename(name) && name !== 'manifest.json' && hashValid(expectedHash), 'invalid artifact');
    const bytes = await readPrivateRegularFile(path.join(directory, name));
    requireValue(recoveryHash(bytes) === expectedHash, 'artifact hash mismatch'); verified.set(name, bytes);
  }
  const parsed = (name: string) => { const bytes = verified.get(name); requireValue(bytes, 'required artifact missing'); return JSON.parse(bytes.toString('utf8')); };
  const rows = parsed('postgres-evidence.json') as RecoveryRows;
  requireValue(['states', 'registry', 'workspaces', 'receipts', 'revisions'].every(key => Array.isArray(rows[key as keyof RecoveryRows])), 'invalid evidence');
  const evidence = buildCollaborationRecoveryEvidence(rows);
  const stored = parsed('evidence.json'); evidence.files = stored.files;
  requireValue(canonical(evidence) === canonical(stored) && canonical(planCollaborationRecovery(evidence)) === canonical(parsed('plan.json')), 'derived evidence mismatch');
  for (const file of evidence.files) if (file.hash) {
    const name = `file-${recoveryHash(file.workspaceId + '\0' + file.path)}.bin`;
    requireValue(verified.has(name) && recoveryHash(verified.get(name)!) === file.hash, 'file evidence missing');
  }
  const historicalIdentities = verified.has('legacy-identities.json') ? parsed('legacy-identities.json') : [];
  requireValue(Array.isArray(historicalIdentities), 'invalid legacy evidence');
  return { manifestHash: recoveryHash(manifestBytes), rows, evidence, historicalIdentities };
}

export function prepareCollaborationRecoverySelection(bundle: RecoveryBundle): RecoverySelection {
  const operations: RecoverySelection['operations'] = []; const manual: RecoverySelection['manual'] = [];
  const stateRow = (id: string) => bundle.rows.states.find(row => row.document_id === id);
  const plan = planCollaborationRecovery(bundle.evidence);
  for (const item of plan.cases) {
    if (item.proposedAction === 'manual_review') { manual.push({ documentId: item.documentId, reason: item.reason }); continue; }
    const row = stateRow(item.successorId!); const orphan = stateRow(item.documentId);
    const registry = bundle.rows.registry.find(record => record.id === item.successorId);
    const workspaceRow = row && bundle.rows.workspaces.find(record => record.id === row.workspace_id);
    if (!row || !orphan || !registry || !workspaceRow) continue;
    const state = decodeRecoveryState(row); const workspace = workspaceIdentity(workspaceRow);
    const revision = bundle.rows.revisions.find(record => record.id === registry.snapshot_revision_id);
    if (!revisionVerified(revision, state, workspace) || !scoped(registry, state, workspace)) {
      manual.push({ documentId: item.documentId, reason: 'current_revision_not_verified' }); continue;
    }
    if (state.documentSequence === 0 && state.checkpointSequence === 0) {
      try {
        requireValue(state.lifecycleGeneration === 1 && !state.degraded && !state.projectionError
          && item.proposedAction === 'retain_current_file' && recoveryPostgresInteger(registry.state_version) === 0
          && registry.yjs_state_lifecycle === 'initialized', 'initial registry not verified');
        const canonical = authoritativeCollaborationSnapshot(state).canonicalContent;
        const serialized = serializeCanonicalText(canonical, state);
        requireValue(recoveryHash(canonical) === state.canonicalHash && recoveryHash(serialized) === state.serializedHash
          && state.serializedHash === item.preconditions.actualFileHash
          && Buffer.byteLength(serialized, 'utf8') === recoveryPostgresInteger(revision.size_bytes), 'initial checkpoint not verified');
      } catch {
        manual.push({ documentId: item.documentId, reason: 'initial_snapshot_not_verified' }); continue;
      }
    }
    const previous = operations.find(operation => operation.kind === 'recover_orphans' && operation.documentId === state.documentId);
    if (previous) { previous.orphans.push({ expectedState: orphan, caseFingerprint: item.fingerprint }); continue; }
    operations.push({ id: '', selected: false, kind: 'recover_orphans', documentId: state.documentId, workspace,
      expectedState: row, expectedRegistry: registry, expectedRevision: revision, expectedFileHash: item.preconditions.actualFileHash!,
      projectedFileHash: state.serializedHash!, orphans: [{ expectedState: orphan, caseFingerprint: item.fingerprint }] });
  }
  for (const row of bundle.rows.states) {
    const state = decodeRecoveryState(row);
    const registry = bundle.rows.registry.find(record => record.id === state.documentId && record.status === 'active');
    const workspaceRow = bundle.rows.workspaces.find(record => record.id === state.workspaceId && record.status === 'active');
    const file = bundle.evidence.files.find(record => record.workspaceId === state.workspaceId && record.path === state.path);
    if (!workspaceRow || !file?.hash) continue;
    const workspace = workspaceIdentity(workspaceRow);
    if (registry && registry.provider === 'yjs' && scoped(registry, state, workspace) && state.degraded) {
      try {
        const revision = bundle.rows.revisions.find(record => record.id === registry.snapshot_revision_id);
        requireValue(revisionVerified(revision, state, workspace) && file.hash === state.serializedHash, 'unknown file or checkpoint');
        const repair = prepareCodeMarkConflictRepair(state);
        operations.push({ id: '', selected: false, kind: 'repair_code_marks', documentId: state.documentId, workspace,
          expectedState: row, expectedRegistry: registry, expectedRevision: revision, expectedFileHash: file.hash,
          projectedFileHash: repair.serializedHash, repairedYjsHash: repair.repairedHash, lostFormatting: repair.lostFormatting, orphans: [] });
      } catch { manual.push({ documentId: state.documentId, reason: 'quarantine_not_deterministically_repairable' }); }
    } else if (!registry) {
      const historicalIdentity = bundle.historicalIdentities.find(record => record.document.id === state.documentId);
      if (!historicalIdentity || state.degraded || state.projectionError || state.documentSequence !== state.checkpointSequence
        || !state.checkpointSequence || state.serializedHash !== file.hash
        || bundle.rows.registry.some(record => record.workspace_id === state.workspaceId && record.path === state.path)) continue;
      try {
        requireValue(recoveryHash(serializeCanonicalText(authoritativeCollaborationSnapshot(state).canonicalContent, state)) === file.hash,
          'historical snapshot mismatch');
        operations.push({ id: '', selected: false, kind: 'import_historical_identity', documentId: state.documentId, workspace,
          expectedState: row, expectedRegistry: null, expectedRevision: null, expectedFileHash: file.hash,
          projectedFileHash: file.hash, historicalIdentity, orphans: [] });
      } catch { manual.push({ documentId: state.documentId, reason: 'historical_snapshot_unverified' }); }
    }
  }
  for (const operation of operations) {
    operation.orphans.sort((a, b) => String(a.expectedState.document_id).localeCompare(String(b.expectedState.document_id)));
    operation.id = recoveryHash(canonical({ ...operation, selected: undefined, id: undefined }));
  }
  return { version: 1, bundleManifestHash: bundle.manifestHash, operations: operations.sort((a, b) => a.id.localeCompare(b.id)),
    manual: manual.filter(item => !operations.some(operation => operation.kind === 'import_historical_identity' && operation.documentId === item.documentId)) };
}

async function readPrivateRegularFile(filename: string): Promise<Buffer> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    requireValue(stat.isFile() && stat.size <= 256 * 1024 * 1024 && (stat.mode & 0o077) === 0, 'private regular evidence required');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function durablePrivateWrite(filename: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.tmp-${randomUUID()}`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(canonical(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    // link publishes a complete inode atomically and refuses to replace an
    // existing intent/outcome. A crash can leave an ignored temp, never a torn marker.
    await fs.link(temporary, filename);
    const directory = await fs.open(path.dirname(filename), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const directory = await fs.open(path.dirname(filename), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
}
async function privateArchiveHash(filename: string): Promise<string> {
  requireValue(path.isAbsolute(filename), 'absolute backup archive required');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); requireValue(before.isFile() && before.size > 0 && (before.mode & 0o077) === 0, 'private backup archive required');
    const { createHash } = await import('node:crypto'); const hash = createHash('sha256'); const bytes = Buffer.alloc(1024 * 1024);
    for (let result = await handle.read(bytes); result.bytesRead > 0; result = await handle.read(bytes)) hash.update(bytes.subarray(0, result.bytesRead));
    const after = await handle.stat(); requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs, 'backup archive changed');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export async function verifyCollaborationRecoveryExecutionProof(proof: RecoveryExecutionProof, manifestHash: string): Promise<void> {
  requireValue(proof.version === 1 && proof.bundleManifestHash === manifestHash && typeof proof.backupId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(proof.backupId) && hashValid(proof.backup.archiveHash)
    && proof.restore.backupId === proof.backupId && proof.restore.result === 'passed'
    && ['postgres', 'workspace_files', 'yjs_bytes', 'registry', 'revisions', 'shares'].every(check => proof.restore.checks.includes(check as typeof proof.restore.checks[number])),
  'verified backup and restore required');
  const timestamps = [proof.backup.completedAt, proof.restore.verifiedAt, proof.writerDrain.verifiedAt].map(value => Date.parse(value));
  requireValue(timestamps.every(Number.isFinite) && timestamps[0] <= timestamps[1] && timestamps[1] <= timestamps[2]
    && timestamps[2] <= Date.now() && Date.now() - timestamps[2] < 24 * 60 * 60 * 1000, 'expired or unordered execution proof');
  for (const report of [proof.backup, proof.restore, proof.writerDrain]) {
    requireValue(path.isAbsolute(report.report) && hashValid(report.reportHash)
      && recoveryHash(await readPrivateRegularFile(report.report)) === report.reportHash, 'execution report changed');
  }
  requireValue(await privateArchiveHash(proof.backup.archive) === proof.backup.archiveHash, 'backup archive hash mismatch');
  const backupReport = JSON.parse((await readPrivateRegularFile(proof.backup.report)).toString('utf8'));
  const restoreReport = JSON.parse((await readPrivateRegularFile(proof.restore.report)).toString('utf8'));
  const drainReport = JSON.parse((await readPrivateRegularFile(proof.writerDrain.report)).toString('utf8'));
  requireValue(backupReport.version === 1 && backupReport.backupId === proof.backupId && backupReport.completed === true
    && backupReport.archiveHash === proof.backup.archiveHash && backupReport.bundleManifestHash === manifestHash, 'backup report does not bind capture');
  requireValue(restoreReport.version === 1 && restoreReport.backupId === proof.backupId && restoreReport.result === 'passed'
    && restoreReport.archiveHash === proof.backup.archiveHash && Array.isArray(restoreReport.checks)
    && proof.restore.checks.every(kind => restoreReport.checks.some((check: { kind: string; sourceHash: string; restoredHash: string }) =>
      check.kind === kind && hashValid(check.sourceHash) && check.sourceHash === check.restoredHash)), 'restore comparison not verified');
  requireValue(drainReport.version === 1 && drainReport.bundleManifestHash === manifestHash
    && drainReport.notebookWritersStopped === true && drainReport.postgresExternalWriterCount === 0, 'writer drain not verified');
}

async function currentState(database: SqlConnection, expected: PersistedCollaborationState) {
  const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [expected.documentId]) as RecoveryRow | undefined;
  requireValue(row, 'state missing'); return decodeRecoveryState(row);
}
function sameBinaryIdentity(before: PersistedCollaborationState, after: PersistedCollaborationState): boolean {
  return before.documentId === after.documentId && before.workspaceId === after.workspaceId && before.organizationId === after.organizationId
    && before.path === after.path && before.representation === after.representation && before.schemaVersion === after.schemaVersion
    && before.lifecycleGeneration === after.lifecycleGeneration && before.documentSequence === after.documentSequence
    && before.persistedAt === after.persistedAt && before.newlineStyle === after.newlineStyle && before.hasBom === after.hasBom
    && before.status === after.status && before.degraded === after.degraded && canonical(before.projectionError) === canonical(after.projectionError)
    && recoveryHash(before.yjsState) === recoveryHash(after.yjsState) && recoveryHash(before.stateVector) === recoveryHash(after.stateVector);
}
async function verifiedProjection(database: SqlConnection, state: PersistedCollaborationState, operation: Operation): Promise<string | null> {
  if (state.checkpointSequence !== state.documentSequence || state.serializedHash !== operation.projectedFileHash) return null;
  const receipt = await database.get('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [state.documentId]) as RecoveryRow | undefined;
  if (!receipt || receipt.lifecycle_generation != state.lifecycleGeneration || receipt.projected_sequence != state.documentSequence
    || receipt.canonical_hash !== state.canonicalHash || receipt.serialized_hash !== state.serializedHash || typeof receipt.revision_id !== 'string') return null;
  const revision = await database.get('SELECT * FROM file_revisions WHERE id=$1', [receipt.revision_id]) as RecoveryRow | undefined;
  if (!revisionVerified(revision, state, operation.workspace)) return null;
  const registry = await database.get('SELECT * FROM collaboration_documents WHERE id=$1', [state.documentId]) as RecoveryRow | undefined;
  if (!registry || !scoped(registry, state, operation.workspace) || registry.status !== 'active' || registry.provider !== 'yjs'
    || registry.snapshot_revision_id !== receipt.revision_id || recoveryPostgresInteger(registry.state_version) !== state.documentSequence) return null;
  if (registry.lineage_id !== revision.lineage_id) return null;
  if (registry.lineage_id !== null) {
    const lineage = await database.get('SELECT * FROM file_collaboration_lineages WHERE id=$1', [registry.lineage_id]) as RecoveryRow | undefined;
    if (!lineage || !scoped(lineage, state, operation.workspace) || lineage.status !== 'active'
      || lineage.archived_at !== null || lineage.trash_entry_id !== null) return null;
  }
  if (operation.expectedRegistry) {
    if (recoveryPostgresInteger(registry.updated_at) < recoveryPostgresInteger(operation.expectedRegistry.updated_at)) return null;
    if (receipt.revision_id !== operation.expectedRegistry.snapshot_revision_id
      && revision.source_session_id !== `collaboration-recovery:${operation.id}`) return null;
  }
  requireValue((await observeRecoveryFile(operation.workspace.rootRelativePath, state.path)).hash === state.serializedHash, 'projected file changed');
  return receipt.revision_id;
}
async function publicShareProjectionHash(database: SqlConnection, operation: Operation): Promise<string> {
  const rows = await database.all(`SELECT id,organization_id,customer_id,project_id,workspace_id,workspace_type,
    workspace_root_relative_path,workspace_path,file_name,file_identity,last_known_revision,mime_type,size_bytes,status,target_revision_policy
    FROM public_file_shares WHERE workspace_id=$1 AND workspace_path=$2 ORDER BY id LIMIT 10001`,
  [operation.workspace.id, operation.expectedState.path]);
  requireValue(rows.length <= 10000, 'share scope too large');
  return recoveryHash(canonical(rows.map(row => JSON.parse(recordCanonical(row)))));
}

/** Explicit offline operator only. No route, scheduler or normal startup invokes this. */
export async function applyCollaborationRecoverySelection(input: {
  bundle: RecoveryBundle; selection: RecoverySelection; selectionHash: string; proof: RecoveryExecutionProof; journalDirectory: string;
  openConnection: () => Promise<SqlConnection>;
}): Promise<Array<{ operationId: string; documentId: string; revisionId: string; disposition: 'applied' | 'already_applied' }>> {
  const selection = JSON.parse(JSON.stringify(input.selection)) as RecoverySelection;
  requireValue(hashValid(input.selectionHash) && recoveryHash(canonical(selection)) === input.selectionHash, 'reviewed selection changed');
  requireValue(selection.version === 1 && selection.bundleManifestHash === input.bundle.manifestHash, 'selection bundle mismatch');
  const proposal = prepareCollaborationRecoverySelection(input.bundle);
  requireValue(selection.operations.length === proposal.operations.length && selection.operations.every((operation, index) =>
    typeof operation.selected === 'boolean' && canonical({ ...operation, selected: false }) === canonical(proposal.operations[index])), 'operation not derived from verified evidence');
  await verifyCollaborationRecoveryExecutionProof(input.proof, input.bundle.manifestHash);
  requireValue(path.isAbsolute(input.journalDirectory), 'absolute journal path required');
  await fs.mkdir(input.journalDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const journalStat = await fs.lstat(input.journalDirectory);
  requireValue(journalStat.isDirectory() && !journalStat.isSymbolicLink() && (journalStat.mode & 0o077) === 0, 'private journal required');
  const results: Awaited<ReturnType<typeof applyCollaborationRecoverySelection>> = [];
  for (const operation of selection.operations.filter(item => item.selected)) {
    const expected = decodeRecoveryState(operation.expectedState); const workspace = workspaceContext(operation.workspace);
    const journalPath = path.join(input.journalDirectory, `${operation.id}.intent.json`);
    const intent = { version: 1, operationId: operation.id, selectionHash: input.selectionHash,
      bundleManifestHash: input.bundle.manifestHash, backupId: input.proof.backupId, operationHash: recoveryHash(canonical(operation)),
      originalFileHash: operation.expectedFileHash };
    let resuming = false;
    try { requireValue(canonical(JSON.parse((await readPrivateRegularFile(journalPath)).toString('utf8'))) === canonical(intent), 'journal conflict'); resuming = true; }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    const result = await withOfflineCollaborationRecoveryGuards({
      documentIds: [expected.documentId, ...operation.orphans.map(orphan => String(orphan.expectedState.document_id))],
      openGuardConnection: input.openConnection, operation: async guard => withWorkspaceMutationLock(expected.workspaceId, async () => {
        await guard.assertActive();
        let state: PersistedCollaborationState; const database = await input.openConnection();
        try {
          const actualWorkspace = await database.get('SELECT * FROM canvas_workspaces WHERE id=$1', [expected.workspaceId]) as RecoveryRow | undefined;
          requireValue(actualWorkspace && canonical(workspaceIdentity(actualWorkspace)) === canonical(operation.workspace), 'workspace identity changed');
          state = await currentState(database, expected);
          const registry = await database.get('SELECT * FROM collaboration_documents WHERE id=$1', [expected.documentId]) as RecoveryRow | undefined;
          const fileHash = (await observeRecoveryFile(operation.workspace.rootRelativePath, expected.path)).hash;
          if (!resuming) {
            requireValue(recoveryStateFingerprint(state) === recoveryStateFingerprint(expected) && fileHash === operation.expectedFileHash,
              'state or file changed before intent');
            requireValue(recordCanonical(registry ?? null) === recordCanonical(operation.expectedRegistry), 'registry changed before intent');
            if (operation.expectedRevision) {
              const revision = await database.get('SELECT * FROM file_revisions WHERE id=$1', [operation.expectedRevision.id]);
              requireValue(recordCanonical(revision) === recordCanonical(operation.expectedRevision), 'revision changed before intent');
            }
            for (const orphan of operation.orphans) requireValue(recoveryStateFingerprint(await currentState(database, decodeRecoveryState(orphan.expectedState)))
              === recoveryStateFingerprint(decodeRecoveryState(orphan.expectedState)), 'orphan changed before intent');
            await durablePrivateWrite(journalPath, intent);
          } else {
            requireValue(fileHash === operation.expectedFileHash || fileHash === operation.projectedFileHash, 'file changed during resume');
            // Registry revision pointers may advance only through this exact
            // checkpoint; IDs, scope, provider, lifecycle and timestamps stay bound.
            if (operation.expectedRegistry) {
              requireValue(operation.expectedRegistry.lineage_id === null || registry?.lineage_id === operation.expectedRegistry.lineage_id,
                'registry lineage changed during resume');
              requireValue(registry?.yjs_state_lifecycle === operation.expectedRegistry.yjs_state_lifecycle
                || (operation.expectedRegistry.yjs_state_lifecycle === 'pending' && registry?.yjs_state_lifecycle === 'initialized'),
                'registry lifecycle changed during resume');
              const before = { ...operation.expectedRegistry, snapshot_revision_id: null, state_version: null, updated_at: null,
                lineage_id: null, yjs_state_lifecycle: null };
              const after = { ...registry, snapshot_revision_id: null, state_version: null, updated_at: null, lineage_id: null, yjs_state_lifecycle: null };
              requireValue(recordCanonical(before) === recordCanonical(after), 'registry identity changed during resume');
              if (recordCanonical(registry) !== recordCanonical(operation.expectedRegistry)) requireValue(await verifiedProjection(database, state, operation), 'unproved registry change');
            }
            if (operation.kind !== 'repair_code_marks') requireValue(sameBinaryIdentity(expected, state), 'state changed during resume');
          }
        } finally { await database.close(); }
        if (operation.kind === 'repair_code_marks') {
          const repaired = await applyCodeMarkRecoveryClone({ expected, operationId: operation.id,
            backupId: recoveryHash(input.proof.backupId + ':' + operation.id), guard, openConnection: input.openConnection });
          requireValue(repaired.repairedHash === operation.repairedYjsHash && canonical(repaired.lostFormatting) === canonical(operation.lostFormatting), 'repair outcome changed');
          state = repaired.state;
        } else if (operation.kind === 'import_historical_identity') {
          requireValue(operation.historicalIdentity, 'legacy identity missing');
          const historical = operation.historicalIdentity;
          const execute = async (transaction: SqlConnection) => {
            await guard.assertActive();
            return importHistoricalCollaborationIdentity(transaction, { operation: 'import_historical_identity', workspace, expectedState: expected,
              expectedFileHash: operation.expectedFileHash, readCurrentFile: async () => (await observeRecoveryFile(operation.workspace.rootRelativePath, expected.path)).bytes,
              document: historical.document, revision: historical.revision, lineage: historical.lineage });
          };
          let importedAndProjected = false;
          if (resuming) {
            const connection = await input.openConnection();
            try {
              const revisionId = await verifiedProjection(connection, state, operation);
              if (revisionId) {
                const document = await connection.get('SELECT * FROM collaboration_documents WHERE id=$1', [expected.documentId]) as RecoveryRow;
                const revision = await connection.get('SELECT * FROM file_revisions WHERE id=$1', [revisionId]) as RecoveryRow;
                requireValue((historical.document.lineageId === null || document.lineage_id === historical.document.lineageId)
                  && recoveryPostgresInteger(document.created_at) === historical.document.createdAt
                  && document.yjs_state_lifecycle === 'initialized'
                  && (revisionId === historical.revision.id || revision.source_session_id === `collaboration-recovery:${operation.id}`), 'import outcome unproved');
                importedAndProjected = true;
              }
            } finally { await connection.close(); }
          }
          if (!importedAndProjected) await executeLifecycleTransaction({ openConnection: input.openConnection, execute,
            recoverCommitted: async () => executeLifecycleTransaction({ openConnection: input.openConnection,
              execute: async transaction => { const outcome = await execute(transaction); requireValue(outcome.status === 'already_imported', 'import commit unproved'); return outcome; },
              recoverCommitted: async () => { throw new Error('Recovery import confirmation unavailable.'); } }) });
        }
        await guard.assertActive();
        const beforeProjectionHash = (await observeRecoveryFile(operation.workspace.rootRelativePath, state.path)).hash;
        requireValue(beforeProjectionHash === operation.expectedFileHash || (resuming && beforeProjectionHash === operation.projectedFileHash),
          'file changed before checkpoint');
        const completedPath = path.join(input.journalDirectory, `${operation.id}.complete.json`);
        let completed: { operationId: string; documentId: string; revisionId: string; selectionHash: string; publicSharesHash: string;
          fileIdentity: Awaited<ReturnType<typeof observeRecoveryFile>>['fileIdentity'] } | undefined;
        try { completed = JSON.parse((await readPrivateRegularFile(completedPath)).toString('utf8')); }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
        if (completed) {
          const connection = await input.openConnection();
          try {
            const receipt = await connection.get('SELECT finalized FROM collaboration_file_projections WHERE document_id=$1', [state.documentId]) as RecoveryRow;
            requireValue(completed.operationId === operation.id && completed.documentId === state.documentId && completed.selectionHash === input.selectionHash
              && completed.revisionId === await verifiedProjection(connection, state, operation) && recoveryPostgresFlag(receipt.finalized)
              && completed.publicSharesHash === await publicShareProjectionHash(connection, operation)
              && canonical(completed.fileIdentity) === canonical((await observeRecoveryFile(operation.workspace.rootRelativePath, state.path)).fileIdentity),
            'completed projection changed');
          } finally { await connection.close(); }
        }
        const projected = completed
          ? { content: (await observeRecoveryFile(operation.workspace.rootRelativePath, state.path)).bytes.toString(),
            revisionId: completed.revisionId, state: { ...state, projectionFinalized: true } }
          : await materializeCollaborationCheckpoint({ state, workspace, actorType: 'system', sourceSessionId: `collaboration-recovery:${operation.id}` });
        requireValue(recoveryHash(projected.content) === operation.projectedFileHash && projected.state.projectionFinalized, 'projection not finalized');
        for (const orphan of operation.orphans) await archiveCollaborationRecoveryOrphan({ expected: decodeRecoveryState(orphan.expectedState),
          operationId: recoveryHash(operation.id + ':' + orphan.expectedState.document_id),
          backupId: recoveryHash(input.proof.backupId + ':' + operation.id + ':' + orphan.expectedState.document_id),
          guard, openConnection: input.openConnection });
        await guard.assertActive();
        const disposition = resuming ? 'already_applied' as const : 'applied' as const;
        const outcome = { operationId: operation.id, documentId: expected.documentId, revisionId: projected.revisionId, disposition };
        const connection = await input.openConnection(); let publicSharesHash: string;
        try { publicSharesHash = await publicShareProjectionHash(connection, operation); } finally { await connection.close(); }
        const fileIdentity = (await observeRecoveryFile(operation.workspace.rootRelativePath, state.path)).fileIdentity;
        try { await durablePrivateWrite(completedPath, { ...outcome, disposition: undefined, selectionHash: input.selectionHash, publicSharesHash, fileIdentity }); }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
          requireValue(canonical(JSON.parse((await readPrivateRegularFile(completedPath)).toString('utf8')))
            === canonical({ ...outcome, disposition: undefined, selectionHash: input.selectionHash, publicSharesHash, fileIdentity }), 'completion journal changed');
        }
        return outcome;
      }) });
    results.push(result);
  }
  return results;
}

export const collaborationRecoverySelectionHash = (selection: RecoverySelection) => recoveryHash(canonical(selection));
