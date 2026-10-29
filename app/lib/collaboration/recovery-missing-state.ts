import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SqlConnection } from '../db';
import { workspaceAbsoluteRoot } from '../workspaces/contracts';
import { canonical, recordCanonical, readPrivateRegularFile, durablePrivateWrite,
  verifyCollaborationRecoveryExecutionProof, type RecoveryExecutionProof } from './recovery-operator';
import { observeRecoveryFile, decodeRecoveryState, recoveryStateFingerprint,
  recoveryPostgresInteger, recoveryPostgresFlag, type RecoveryRow } from './recovery-evidence';
import { recoveryHash } from './recovery-plan';
import { createPlainTextYDoc } from './markdown-state';
import { Y } from './server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from './types';
import { authoritativeCollaborationSnapshot } from './authoritative-snapshot';
import { serializeCanonicalText } from './persistence';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { lockIdentity } from './room-owner';
import { assertCollaborationAdmissionOpen, lockCollaborationAdmissionWorkspace } from './room-admission';

type QueryDatabase = Pick<SqlConnection, 'get' | 'all'>;
type Facts = { registry: RecoveryRow; workspace: RecoveryRow; lineage: RecoveryRow;
  revisions: RecoveryRow[]; shares: RecoveryRow[] };
type Source = { bytes: string; hash: string; fileIdentity: Awaited<ReturnType<typeof observeRecoveryFile>>['fileIdentity'] };
export type MissingStateRecoveryBundle = { version: 1; kind: 'missing-native-state'; capturedAt: string;
  sourceChoice: 'verified-current-file-revision'; documents: Array<Facts & { source: Source }> };
export type MissingStateRecoverySelection = { version: 1; bundleManifestHash: string;
  operations: Array<{ operationId: string; documentId: string; revisionId: string; sourceHash: string;
    sourceChoice: 'verified-current-file-revision'; selected: boolean }> };

function requireEvidence(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Missing-state recovery rejected: ${reason}.`);
}
function scoped(row: RecoveryRow, registry: RecoveryRow): boolean {
  return ['workspace_id', 'organization_id', 'customer_id', 'project_id', 'workspace_type', 'path']
    .every(key => row[key] === registry[key]);
}
function validateFacts(facts: Facts): RecoveryRow {
  const { registry: document, workspace, lineage, revisions } = facts;
  requireEvidence(typeof document.id === 'string' && document.id && document.provider === 'yjs'
    && document.status === 'active' && document.yjs_state_lifecycle === 'legacy_unknown'
    && recoveryPostgresInteger(document.state_version) === 0, 'ambiguous or initialized registry');
  requireEvidence(typeof document.path === 'string' && /\.md$/iu.test(document.path)
    && !document.path.includes('\0') && !document.path.includes('\\') && !path.posix.isAbsolute(document.path)
    && path.posix.normalize(document.path) === document.path && !document.path.startsWith('../'), 'unsupported document path');
  requireEvidence(workspace.id === document.workspace_id && workspace.status === 'active'
    && workspace.type === document.workspace_type && workspace.organization_id === document.organization_id
    && workspace.customer_id === document.customer_id && workspace.project_id === document.project_id
    && typeof workspace.root_relative_path === 'string', 'workspace scope mismatch');
  requireEvidence(typeof document.lineage_id === 'string' && lineage.id === document.lineage_id
    && scoped(lineage, document) && lineage.status === 'active' && lineage.archived_at === null
    && lineage.trash_entry_id === null, 'lineage mismatch');
  const revision = revisions.find(row => row.id === document.snapshot_revision_id);
  requireEvidence(revision && scoped(revision, document) && revision.lineage_id === document.lineage_id
    && !recoveryPostgresFlag(revision.history_only) && recoveryPostgresInteger(revision.revision_number, 1) > 0
    && typeof revision.content_hash === 'string' && /^[a-f0-9]{64}$/u.test(revision.content_hash)
    && recoveryPostgresInteger(revision.size_bytes) <= 5 * 1024 * 1024, 'current revision not verified');
  return revision;
}

/** Absence is a precondition for an explicitly selected new state, never evidence
 * that a legacy document had no earlier native history. Keep every original row. */
async function readFacts(database: QueryDatabase, documentId: string, lock = false): Promise<Facts> {
  const registry = await database.get(`SELECT * FROM collaboration_documents WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [documentId]) as RecoveryRow;
  requireEvidence(registry, 'registry missing');
  const workspace = await database.get(`SELECT * FROM canvas_workspaces WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [registry.workspace_id]) as RecoveryRow;
  const lineage = await database.get(`SELECT * FROM file_collaboration_lineages WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [registry.lineage_id]) as RecoveryRow;
  const revisions = await database.all('SELECT * FROM file_revisions WHERE lineage_id=$1 ORDER BY id LIMIT 10001', [registry.lineage_id]) as RecoveryRow[];
  const shares = await database.all('SELECT * FROM public_file_shares WHERE workspace_id=$1 AND workspace_path=$2 ORDER BY id LIMIT 10001',
    [registry.workspace_id, registry.path]) as RecoveryRow[];
  requireEvidence(workspace && lineage && revisions.length <= 10000 && shares.length <= 10000, 'scope missing or too large');
  return { registry, workspace, lineage, revisions, shares };
}
async function assertNoNativeHistory(database: QueryDatabase, document: RecoveryRow, allowCurrent = false) {
  const history = await database.get(`SELECT
    EXISTS(SELECT 1 FROM collaboration_yjs_states WHERE (workspace_id=$2 AND path=$3) OR document_id=$1) AS native,
    EXISTS(SELECT 1 FROM collaboration_yjs_state_backups WHERE document_id=$1) AS backup,
    EXISTS(SELECT 1 FROM collaboration_agent_operations WHERE document_id=$1) AS agent,
    EXISTS(SELECT 1 FROM collaboration_file_projections WHERE document_id=$1) AS projection,
    EXISTS(SELECT 1 FROM collaboration_documents WHERE workspace_id=$2 AND path=$3 AND id<>$1) AS other_identity`,
  [document.id, document.workspace_id, document.path]) as RecoveryRow;
  requireEvidence(!history.backup && !history.agent && !history.other_identity
    && (allowCurrent || !history.native && !history.projection), 'native history or competing identity exists');
}
async function observeSource(facts: Facts): Promise<Source> {
  const root = workspaceAbsoluteRoot(String(facts.workspace.root_relative_path));
  const filename = path.resolve(root, String(facts.registry.path));
  requireEvidence(await fs.realpath(root) === root && await fs.realpath(filename) === filename, 'source has aliases');
  const stat = await fs.lstat(filename);
  requireEvidence(stat.isFile() && stat.nlink === 1, 'source is not an independent regular file');
  const observed = await observeRecoveryFile(String(facts.workspace.root_relative_path), String(facts.registry.path));
  return { bytes: Buffer.from(observed.bytes).toString('base64'), hash: observed.hash, fileIdentity: observed.fileIdentity };
}
function sourceText(source: Source, revision: RecoveryRow) {
  const bytes = Buffer.from(source.bytes, 'base64');
  requireEvidence(bytes.toString('base64') === source.bytes && bytes.length <= 5 * 1024 * 1024
    && bytes.length === recoveryPostgresInteger(revision.size_bytes) && recoveryHash(bytes) === source.hash
    && source.hash === revision.content_hash, 'file differs from selected revision');
  const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const hasBom = original.startsWith('\ufeff'), withoutBom = hasBom ? original.slice(1) : original;
  const newlineStyle = withoutBom.includes('\r\n') ? 'crlf' as const : 'lf' as const;
  const content = withoutBom.replaceAll('\r\n', '\n');
  requireEvidence(!content.includes('\r') && (newlineStyle === 'lf' || !withoutBom.replaceAll('\r\n', '').includes('\n')),
    'mixed or unsupported newlines');
  requireEvidence(Buffer.from(serializeCanonicalText(content, { newlineStyle, hasBom })).equals(bytes), 'source roundtrip differs');
  return { content, newlineStyle, hasBom };
}

/** Caller supplies a real repeatable-read READ ONLY transaction; no migrations. */
export async function captureMissingStateRecoveryBundle(database: QueryDatabase, documentIds: string[]): Promise<MissingStateRecoveryBundle> {
  requireEvidence(documentIds.length > 0 && documentIds.length <= 100 && new Set(documentIds).size === documentIds.length, 'invalid selection scope');
  const documents: MissingStateRecoveryBundle['documents'] = [];
  for (const id of [...documentIds].sort()) {
    const facts = await readFacts(database, id), revision = validateFacts(facts);
    await assertNoNativeHistory(database, facts.registry);
    const source = await observeSource(facts); sourceText(source, revision);
    documents.push({ ...facts, source });
  }
  return { version: 1, kind: 'missing-native-state', capturedAt: new Date().toISOString(),
    sourceChoice: 'verified-current-file-revision', documents };
}
export function prepareMissingStateRecoverySelection(bundle: MissingStateRecoveryBundle, bundleManifestHash: string): MissingStateRecoverySelection {
  requireEvidence(bundle.version === 1 && bundle.kind === 'missing-native-state'
    && bundle.sourceChoice === 'verified-current-file-revision' && bundle.documents.length > 0
    && bundle.documents.length <= 100 && new Set(bundle.documents.map(item => item.registry.id)).size === bundle.documents.length,
  'invalid bundle');
  return { version: 1, bundleManifestHash, operations: bundle.documents.map(item => {
    const revision = validateFacts(item); sourceText(item.source, revision);
    return { operationId: recoveryHash(canonical({ bundleManifestHash, kind: 'recover_missing_native_from_revision', item })),
      documentId: String(item.registry.id), revisionId: String(revision.id), sourceHash: item.source.hash,
      sourceChoice: 'verified-current-file-revision' as const, selected: false };
  }) };
}
function seedState(item: MissingStateRecoveryBundle['documents'][number]): RecoveryRow {
  const text = sourceText(item.source, validateFacts(item)), doc = createPlainTextYDoc(text.content), now = Date.now();
  try {
    return { document_id: item.registry.id, workspace_id: item.registry.workspace_id, organization_id: item.registry.organization_id,
      path: item.registry.path, representation: 'plain_text', lifecycle_generation: 1, schema_version: COLLABORATION_SCHEMA_VERSION,
      yjs_state: { encoding: 'base64', bytes: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') },
      state_vector: { encoding: 'base64', bytes: Buffer.from(Y.encodeStateVector(doc)).toString('base64') },
      document_sequence: 0, checkpoint_sequence: 0, persisted_at: now, checkpointed_at: now,
      canonical_hash: recoveryHash(text.content), serialized_hash: item.source.hash, newline_style: text.newlineStyle,
      has_bom: text.hasBom ? 1 : 0, degraded: 0, status: 'active' };
  } finally { doc.destroy(); }
}
const factsCanonical = (facts: Facts) => canonical({ registry: JSON.parse(recordCanonical(facts.registry)), workspace: JSON.parse(recordCanonical(facts.workspace)),
  lineage: JSON.parse(recordCanonical(facts.lineage)), revisions: facts.revisions.map(row => JSON.parse(recordCanonical(row))),
  shares: facts.shares.map(row => JSON.parse(recordCanonical(row))) });
async function optionalJournal(filename: string): Promise<unknown | null> {
  try { return JSON.parse((await readPrivateRegularFile(filename)).toString('utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Offline only. No HTTP route and no permissive runtime fallback. The old unknown
 * registry and file bytes stay in the hash-bound bundle and fsynced intent. */
export async function applyMissingStateRecoverySelection(input: {
  bundle: MissingStateRecoveryBundle; bundleManifestHash: string; selection: MissingStateRecoverySelection;
  selectionHash: string; proof: RecoveryExecutionProof; journalDirectory: string; openConnection: () => Promise<SqlConnection>;
}) {
  requireEvidence(recoveryHash(canonical(input.bundle) + '\n') === input.bundleManifestHash, 'bundle hash changed');
  requireEvidence(recoveryHash(canonical(input.selection)) === input.selectionHash, 'reviewed selection changed');
  const proposal = prepareMissingStateRecoverySelection(input.bundle, input.bundleManifestHash);
  requireEvidence(input.selection.version === 1 && input.selection.bundleManifestHash === input.bundleManifestHash
    && input.selection.operations.length === proposal.operations.length && input.selection.operations.every((operation, index) =>
      typeof operation.selected === 'boolean' && canonical({ ...operation, selected: false }) === canonical(proposal.operations[index])),
  'selection not derived from capture');
  await verifyCollaborationRecoveryExecutionProof(input.proof, input.bundleManifestHash);
  requireEvidence(path.isAbsolute(input.journalDirectory), 'absolute private journal required');
  await fs.mkdir(input.journalDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(input.journalDirectory);
  requireEvidence(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'private journal required');
  const results: Array<{ documentId: string; disposition: 'applied' | 'already_applied' }> = [];
  for (const operation of input.selection.operations.filter(item => item.selected)) {
    const item = input.bundle.documents.find(document => document.registry.id === operation.documentId)!;
    const intentPath = path.join(input.journalDirectory, operation.operationId + '.intent.json');
    const binding = { version: 1, operationId: operation.operationId, selectionHash: input.selectionHash,
      bundleManifestHash: input.bundleManifestHash, backupId: input.proof.backupId, original: item };
    const previous = await optionalJournal(intentPath) as { binding: typeof binding; state: RecoveryRow } | null;
    if (previous) requireEvidence(canonical(previous.binding) === canonical(binding), 'journal binding changed');
    const intent = previous ?? { binding, state: seedState(item) };
    const seeded = decodeRecoveryState(intent.state), expected = decodeRecoveryState(seedState(item));
    requireEvidence(seeded.documentId === expected.documentId && seeded.workspaceId === expected.workspaceId
      && seeded.organizationId === expected.organizationId && seeded.path === expected.path && seeded.representation === 'plain_text'
      && seeded.lifecycleGeneration === 1 && seeded.schemaVersion === COLLABORATION_SCHEMA_VERSION
      && seeded.documentSequence === 0 && seeded.checkpointSequence === 0 && !seeded.degraded && !seeded.projectionError
      && seeded.status === 'active' && seeded.newlineStyle === expected.newlineStyle && seeded.hasBom === expected.hasBom
      && seeded.canonicalHash === expected.canonicalHash && seeded.serializedHash === expected.serializedHash
      && recoveryHash(serializeCanonicalText(authoritativeCollaborationSnapshot(seeded).canonicalContent, seeded)) === item.source.hash,
    'journal state not the selected file');
    if (!previous) await durablePrivateWrite(intentPath, intent);
    const apply = async (database: SqlConnection, allowInsert: boolean) => {
      await database.run("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'; SET LOCAL transaction_timeout='30s'");
      const query = async (sql: string, values?: unknown[]) => await database.all(sql, values) as RecoveryRow[];
      await lockCollaborationAdmissionWorkspace(query, String(item.registry.workspace_id));
      await assertCollaborationAdmissionOpen(query, { documentId: operation.documentId,
        workspaceId: String(item.registry.workspace_id), path: String(item.registry.path) });
      requireEvidence((await database.get('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [lockIdentity(operation.documentId).key]) as RecoveryRow).locked === true,
        'room owner is active');
      const clients = await database.all(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND backend_type='client backend' AND pid<>pg_backend_pid()`);
      requireEvidence(clients.length === 0, 'Notebook or another database client is still connected');
      const facts = await readFacts(database, operation.documentId, true);
      requireEvidence(canonical(await observeSource(facts)) === canonical(item.source), 'file identity or content changed');
      const actual = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE', [operation.documentId]) as RecoveryRow | undefined;
      if (actual) {
        requireEvidence(factsCanonical({ ...facts, registry: { ...facts.registry, yjs_state_lifecycle: item.registry.yjs_state_lifecycle } }) === factsCanonical(item)
          && facts.registry.yjs_state_lifecycle === 'initialized'
          && recoveryStateFingerprint(decodeRecoveryState(actual)) === recoveryStateFingerprint(seeded)
          && recoveryPostgresInteger(actual.room_owner_epoch) === 0 && actual.room_owner_token === null
          && actual.room_owner_backend_pid === null && actual.room_owner_backend_start === null,
        'current state is not this recovery');
        await assertNoNativeHistory(database, facts.registry, true);
        const other = await database.all('SELECT document_id FROM collaboration_yjs_states WHERE workspace_id=$1 AND path=$2 AND document_id<>$3',
          [item.registry.workspace_id, item.registry.path, operation.documentId]);
        const receipt = await database.get('SELECT * FROM collaboration_file_projections WHERE document_id=$1', [operation.documentId]) as RecoveryRow;
        requireEvidence(other.length === 0 && receipt && recoveryPostgresFlag(receipt.finalized)
          && recoveryPostgresInteger(receipt.lifecycle_generation) === 1 && recoveryPostgresInteger(receipt.projected_sequence) === 0
          && receipt.revision_id === operation.revisionId && receipt.canonical_hash === seeded.canonicalHash
          && receipt.serialized_hash === item.source.hash, 'projection proof changed');
        return 'already_applied' as const;
      }
      requireEvidence(allowInsert && factsCanonical(facts) === factsCanonical(item), 'capture changed or commit unproved');
      validateFacts(facts); await assertNoNativeHistory(database, facts.registry);
      const entries = Object.entries(intent.state).map(([key, value]) => [key,
        key === 'yjs_state' ? Buffer.from(seeded.yjsState) : key === 'state_vector' ? Buffer.from(seeded.stateVector) : value] as const);
      const columns = ['document_id','workspace_id','organization_id','path','representation','lifecycle_generation','schema_version',
        'yjs_state','state_vector','document_sequence','checkpoint_sequence','persisted_at','checkpointed_at','canonical_hash','serialized_hash',
        'newline_style','has_bom','degraded','status'];
      requireEvidence(entries.length === columns.length && entries.every(([key]) => columns.includes(key)), 'unexpected state field');
      await database.run(`INSERT INTO collaboration_yjs_states (${entries.map(([key]) => key).join(',')})
        VALUES (${entries.map((_, index) => '$' + (index + 1)).join(',')})`, entries.map(([, value]) => value));
      await database.run("UPDATE collaboration_documents SET yjs_state_lifecycle='initialized' WHERE id=$1 AND yjs_state_lifecycle='legacy_unknown'", [operation.documentId]);
      await database.run(`INSERT INTO collaboration_file_projections
        (document_id,lifecycle_generation,projected_sequence,revision_id,canonical_hash,serialized_hash,finalized,updated_at)
        VALUES ($1,1,0,$2,$3,$4,1,$5)`, [operation.documentId, operation.revisionId, seeded.canonicalHash, item.source.hash, seeded.persistedAt]);
      requireEvidence(canonical(await observeSource(facts)) === canonical(item.source), 'file changed before commit');
      return 'applied' as const;
    };
    const disposition = await executeLifecycleTransaction({ openConnection: input.openConnection,
      execute: database => apply(database, true), recoverCommitted: () => executeLifecycleTransaction({ openConnection: input.openConnection,
        execute: database => apply(database, false), recoverCommitted: async value => value }) });
    requireEvidence(canonical(await observeSource(item)) === canonical(item.source), 'file changed after commit');
    const complete = { version: 1, operationId: operation.operationId, selectionHash: input.selectionHash,
      stateFingerprint: recoveryStateFingerprint(seeded), sourceHash: item.source.hash, revisionId: operation.revisionId };
    const completePath = path.join(input.journalDirectory, operation.operationId + '.complete.json'), priorComplete = await optionalJournal(completePath);
    if (priorComplete) requireEvidence(canonical(priorComplete) === canonical(complete), 'completion journal changed');
    else await durablePrivateWrite(completePath, complete);
    results.push({ documentId: operation.documentId, disposition });
  }
  return results;
}
