import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { getSchema } from '@tiptap/core';
import { openDb, type SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { ensureActiveFileLineage, lockFileCollaborationPaths } from '../files/collaboration-repository';
import { assertWorkspaceFileLifecycleSqlAvailable, withWorkspaceFileLifecycleGuard } from '../files/workspace-file-lifecycle-guard';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from './agent-durability';
import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot } from './document-snapshot';
import { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleCollaborationWrite } from './file-lifecycle-admission-context';
import { lockFileLifecycleCollaborationWriterAdmission } from './file-lifecycle-writer-admission';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { MARKDOWN_FILE_IMPORT_LIMIT, MarkdownFileImportError, prepareMarkdownFileImport, type PreparedMarkdownFileImport } from './markdown-file-import';
import { replaceRichMarkdownInYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from './markdown-state';
import { assertNativeDocumentSchema } from './native-document-schema';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from './persistence';
import { assertCollaborationAdmissionOpen } from './room-admission';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { Y } from './server-runtime';
import { isCollaborationStateProof } from './state-proof';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';
import type { TextCollaborationRepresentation } from './types';

export type MarkdownImportIdentity = Pick<PersistedCollaborationState, 'documentId' | 'workspaceId' | 'organizationId'
  | 'path' | 'representation' | 'schemaVersion' | 'lifecycleGeneration' | 'newlineStyle' | 'hasBom'>;
export type MarkdownImportTarget = { kind: 'absent' } | { kind: 'pristine'; documentId: string }
  | ({ kind: 'initialized'; documentSequence: number; stateProof: string } & MarkdownImportIdentity);
/** Private coordinator receipt; never spread this into file/upload API results. */
export type MarkdownFileImportReceipt = {
  version: 1;
  operationId: string;
  requestFingerprint: string;
  sourceHash: string;
  sourceBytes: number;
  target: MarkdownImportIdentity & { lineageId: string; initialSequence: number; initialStateProof: string; persistedAt: number };
  /** The checkpoint/projection journal remains the sole physical writer. */
  checkpointRequired: true;
};
export type MarkdownFileImportResult = { disposition: 'applied' | 'already-applied' | 'commit-recovered';
  receipt: MarkdownFileImportReceipt; currentObservation: { documentSequence: number; stateProof: string; persistedAt: number } };
export type MarkdownFileImportRequest = {
  workspace: WorkspaceContext;
  path: string;
  operationId: string;
  requestId: string;
  actorUserId: string;
  actorSessionId: string | null;
  bytes: Uint8Array;
  expectedTarget: MarkdownImportTarget;
  representation?: TextCollaborationRepresentation | 'auto';
  /** Recheck current actor/path rights under the actual mutation fence. */
  validateAuthority: () => Promise<void>;
};
type Captured = Omit<MarkdownFileImportRequest, 'bytes' | 'validateAuthority'> & {
  prepared: PreparedMarkdownFileImport; fingerprint: string;
};
const fail = (code: MarkdownFileImportError['code']): never => { throw new MarkdownFileImportError(code); };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const knownKeys = (value: object, keys: string[]) => !Object.keys(value).some(key => !keys.includes(key));
const identityKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration', 'newlineStyle', 'hasBom'] as const;
function validIdentity(value: MarkdownImportIdentity): boolean {
  return !!value && typeof value === 'object' && validId(value.documentId) && validId(value.workspaceId)
    && (value.organizationId === null || validId(value.organizationId)) && isCanonicalAdmissionPath(value.path)
    && ['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(value.representation) && value.schemaVersion === 1
    && Number.isSafeInteger(value.lifecycleGeneration) && value.lifecycleGeneration > 0
    && ['lf', 'crlf'].includes(value.newlineStyle) && typeof value.hasBom === 'boolean';
}
function capture(input: MarkdownFileImportRequest): Captured {
  if (typeof input.validateAuthority !== 'function' || !(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength > MARKDOWN_FILE_IMPORT_LIMIT) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  const workspace = structuredClone(input.workspace), expectedTarget = structuredClone(input.expectedTarget);
  if (!workspace.permissions.canRead || !workspace.permissions.canWrite
    || workspace.status !== undefined && workspace.status !== 'active'
    || workspace.actor && workspace.actor.userId !== input.actorUserId) {
    throw Object.assign(new Error('Current workspace import permission is required.'), { status: 403 });
  }
  if (!validId(input.operationId) || !validId(input.requestId) || !validId(input.actorUserId)
    || input.actorSessionId !== null && !validId(input.actorSessionId) || !validId(workspace.workspaceId)
    || workspace.organizationId != null && !validId(workspace.organizationId)
    || !isCanonicalAdmissionPath(input.path) || !/\.(?:md|markdown)$/iu.test(input.path)
    || !expectedTarget || typeof expectedTarget !== 'object') return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  if (expectedTarget.kind === 'absent') {
    if (!knownKeys(expectedTarget, ['kind'])) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  } else if (expectedTarget.kind === 'pristine') {
    if (!validId(expectedTarget.documentId) || !knownKeys(expectedTarget, ['kind', 'documentId'])) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  } else if (expectedTarget.kind === 'initialized') {
    if (!validIdentity(expectedTarget) || expectedTarget.workspaceId !== workspace.workspaceId
      || expectedTarget.organizationId !== (workspace.organizationId ?? null) || expectedTarget.path !== input.path
      || !Number.isSafeInteger(expectedTarget.documentSequence) || expectedTarget.documentSequence < 0
      || expectedTarget.documentSequence >= Number.MAX_SAFE_INTEGER || !isCollaborationStateProof(expectedTarget.stateProof)
      || !knownKeys(expectedTarget, ['kind', 'documentSequence', 'stateProof', ...identityKeys])) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  } else return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  const representation = input.representation ?? (expectedTarget.kind === 'initialized' ? expectedTarget.representation : 'auto');
  const prepared = prepareMarkdownFileImport(new Uint8Array(input.bytes), { representation });
  if (expectedTarget.kind === 'initialized' && (expectedTarget.representation !== prepared.representation
    || expectedTarget.newlineStyle !== prepared.newlineStyle || expectedTarget.hasBom !== prepared.hasBom)) {
    return fail('MARKDOWN_IMPORT_LIFECYCLE_REQUIRED');
  }
  // Canonical key ordering prevents caller property-order changes from becoming a new request.
  const expected = expectedTarget.kind === 'initialized' ? { kind: expectedTarget.kind,
    ...Object.fromEntries(identityKeys.map(key => [key, expectedTarget[key]])),
    documentSequence: expectedTarget.documentSequence, stateProof: expectedTarget.stateProof } : expectedTarget;
  const fingerprint = hash(JSON.stringify({ version: 1, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId ?? null, path: input.path, sourceHash: prepared.sourceHash,
    sourceBytes: prepared.sourceBytes, representation: prepared.representation,
    newlineStyle: prepared.newlineStyle, hasBom: prepared.hasBom, expectedTarget: expected }));
  return { workspace, path: input.path, operationId: input.operationId, requestId: input.requestId,
    actorUserId: input.actorUserId, actorSessionId: input.actorSessionId, expectedTarget, prepared, fingerprint };
}

async function observedState(database: SqlConnection, input: Captured, receipt: MarkdownFileImportReceipt): Promise<PersistedCollaborationState> {
  const documents = await readWorkspaceDocumentCatalogue(database, input.workspace, { paths: [input.path] });
  const document = documents.find(document => document.path === input.path);
  const state = await loadCollaborationStateOnConnection(database, receipt.target.documentId, true);
  const lineage = await database.get(`SELECT id FROM file_collaboration_lineages WHERE id=$1 AND workspace_id=$2
    AND organization_id IS NOT DISTINCT FROM $3 AND path=$4 AND status='active'`,
  [receipt.target.lineageId, input.workspace.workspaceId, input.workspace.organizationId ?? null, input.path]);
  if (documents.length !== 1 || !document || document.id !== receipt.target.documentId
    || document.authority !== 'initialized' || document.yjs_state_lifecycle !== 'initialized'
    || document.lineage_id !== receipt.target.lineageId || !lineage || !state
    || identityKeys.some(key => state[key] !== receipt.target[key]) || state.documentSequence < document.state_version) {
    return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
  }
  authoritativeNativeCollaborationSnapshot(state);
  return state;
}
async function confirmedRetry(database: SqlConnection, input: Captured): Promise<Omit<MarkdownFileImportResult, 'disposition'> | null> {
  const rows = await database.all(`SELECT * FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1
    AND (operation_id=$2 OR (actor_user_id=$3 AND actor_session_id IS NOT DISTINCT FROM $4 AND request_id=$5))`,
  [input.workspace.workspaceId, input.operationId, input.actorUserId, input.actorSessionId, input.requestId]) as Array<Record<string, unknown>>;
  if (!rows.length) return null;
  if (rows.length !== 1) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  const row = rows[0], receipt = row.private_result as MarkdownFileImportReceipt;
  if (row.version !== 1 || row.operation_id !== input.operationId || row.organization_id !== (input.workspace.organizationId ?? null)
    || row.actor_user_id !== input.actorUserId || row.actor_session_id !== input.actorSessionId || row.request_id !== input.requestId
    || row.request_fingerprint !== input.fingerprint || !receipt || !knownKeys(receipt, ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired'])
    || receipt.version !== 1 || receipt.operationId !== input.operationId || receipt.requestFingerprint !== input.fingerprint
    || receipt.sourceHash !== input.prepared.sourceHash || receipt.sourceBytes !== input.prepared.sourceBytes || receipt.checkpointRequired !== true
    || !validIdentity(receipt.target) || receipt.target.workspaceId !== input.workspace.workspaceId
    || receipt.target.organizationId !== (input.workspace.organizationId ?? null) || receipt.target.path !== input.path
    || receipt.target.representation !== input.prepared.representation || receipt.target.newlineStyle !== input.prepared.newlineStyle
    || receipt.target.hasBom !== input.prepared.hasBom || !validId(receipt.target.lineageId)
    || !knownKeys(receipt.target, [...identityKeys, 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'])
    || !Number.isSafeInteger(receipt.target.initialSequence) || receipt.target.initialSequence < 0
    || !isCollaborationStateProof(receipt.target.initialStateProof) || !Number.isSafeInteger(receipt.target.persistedAt) || receipt.target.persistedAt < 0
    || !(row.after_state_snapshot instanceof Uint8Array) || row.after_state_snapshot.byteLength > MARKDOWN_FILE_IMPORT_LIMIT
    || `yjs-snapshot-sha256-v1:${hash(row.after_state_snapshot)}` !== receipt.target.initialStateProof) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  const expected = input.expectedTarget;
  if (expected.kind === 'initialized') {
    if (identityKeys.some(key => receipt.target[key] !== expected[key])
      || receipt.target.initialSequence !== expected.documentSequence + 1) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  } else if (receipt.target.initialSequence !== 0 || receipt.target.lifecycleGeneration !== 1
    || input.expectedTarget.kind === 'pristine' && receipt.target.documentId !== input.expectedTarget.documentId) return fail('MARKDOWN_IMPORT_REQUEST_CONFLICT');
  const state = await observedState(database, input, receipt);
  // The empty initial Plain snapshot is a legitimate subset with no client items.
  const empty = Y.encodeSnapshot(Y.createSnapshot(Y.createDeleteSet(), new Map()));
  if (state.documentSequence < receipt.target.initialSequence || !Buffer.from(row.after_state_snapshot).equals(Buffer.from(empty))
    && !persistedUpdateIncludesAgentSnapshot(state.yjsState, row.after_state_snapshot, Y)) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
  const native = authoritativeNativeCollaborationSnapshot(state);
  return { receipt, currentObservation: { documentSequence: state.documentSequence, stateProof: native.version.stateProof, persistedAt: state.persistedAt } };
}

function importedState(input: Captured, documentId: string, now: number): PersistedCollaborationState {
  return { documentId, workspaceId: input.workspace.workspaceId, organizationId: input.workspace.organizationId ?? null,
    path: input.path, representation: input.prepared.representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: input.prepared.yjsState, stateVector: input.prepared.stateVector, documentSequence: 0, persistedAt: now,
    checkpointedAt: null, checkpointSequence: 0, canonicalHash: null, serializedHash: null,
    newlineStyle: input.prepared.newlineStyle, hasBom: input.prepared.hasBom, degraded: false, status: 'active', projectionFinalized: false };
}
function mutateEmpty(state: PersistedCollaborationState, input: Captured): PersistedCollaborationState {
  const expected = input.expectedTarget;
  if (expected.kind !== 'initialized') return fail('MARKDOWN_IMPORT_INVALID_INPUT');
  return inspectPersistedNativeCollaborationSnapshot(state, (source, snapshot) => {
    if (identityKeys.some(key => state[key] !== expected[key]) || state.documentSequence !== expected.documentSequence
      || snapshot.version.stateProof !== expected.stateProof) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
    const schema = getSchema(richMarkdownSchemaExtensions());
    assertNativeDocumentSchema(source, state.representation, schema);
    if (snapshot.content.kind === 'plain_text') {
      if (snapshot.content.text.length) return fail('MARKDOWN_IMPORT_TARGET_NOT_EMPTY');
    } else {
      const { document, frontmatter, bodyFinalLineEnding } = snapshot.content;
      const nodes = document.content ?? [];
      if (frontmatter.length || bodyFinalLineEnding.length || nodes.length > 1 || nodes.some(node => node.type !== 'paragraph'
        || node.text || node.content?.length || node.marks?.length
        || Object.entries(node.attrs ?? {}).some(([key, value]) => key !== 'id' && value !== schema.nodes.paragraph.spec.attrs?.[key]?.default))) {
        return fail('MARKDOWN_IMPORT_TARGET_NOT_EMPTY');
      }
    }
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, state.yjsState);
      if (state.representation === 'plain_text') candidate.transact(() => {
        if (input.prepared.canonical) candidate.getText('content').insert(0, input.prepared.canonical);
      }, { kind: 'markdown-file-import', operationId: input.operationId });
      else {
        replaceRichMarkdownInYDoc(candidate, input.prepared.canonical, { kind: 'markdown-file-import', operationId: input.operationId });
        if (!validateRichMarkdownYDoc(candidate).valid || richMarkdownFromYDoc(candidate) !== input.prepared.canonical) {
          return fail('MARKDOWN_IMPORT_RICH_UNAVAILABLE');
        }
      }
      return { ...state, yjsState: Y.encodeStateAsUpdate(candidate), stateVector: Y.encodeStateVector(candidate),
        documentSequence: state.documentSequence + 1, persistedAt: Math.max(Date.now(), state.persistedAt), projectionFinalized: false };
    } finally { candidate.destroy(); }
  });
}

/** Internal complete-file capability. No file write, room mutation bypass,
 * representation migration, public response or projection completion occurs. */
export async function persistMarkdownFileImport(request: MarkdownFileImportRequest,
  dependencies: { openConnection: () => Promise<SqlConnection> } = { openConnection: openDb }): Promise<MarkdownFileImportResult> {
  const input = capture(request), validateAuthority = request.validateAuthority;
  return withWorkspaceFileLifecycleGuard({ workspaceId: input.workspace.workspaceId, paths: [input.path] }, async () => {
    await validateAuthority();
    return executeLifecycleTransaction<MarkdownFileImportResult>({ openConnection: dependencies.openConnection,
      execute: async database => {
        await database.run("SET LOCAL statement_timeout='5s'"); await database.run("SET LOCAL lock_timeout='4s'");
        await assertWorkspaceFileLifecycleSqlAvailable(database, input.workspace.workspaceId, [input.path]);
        await lockFileCollaborationPaths(database, input.workspace.workspaceId, [input.path]);
        const prior = await confirmedRetry(database, input);
        if (prior) return { disposition: 'already-applied', ...prior };
        const documents = await readWorkspaceDocumentCatalogue(database, input.workspace, { paths: [input.path] });
        const all = await database.all(`SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active' FOR UPDATE`,
        [input.workspace.workspaceId, input.path]);
        const document = documents.find(document => document.path === input.path);
        if (input.expectedTarget.kind === 'absent' ? documents.length !== 0 || all.length !== 0
          : documents.length !== 1 || all.length !== 1 || !document || document.id !== input.expectedTarget.documentId
            || document.authority !== (input.expectedTarget.kind === 'pristine' ? 'pristine' : 'initialized')) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
        const documentId = document?.id ?? `collab-${randomUUID()}`;
        const active = await database.get(`SELECT operation_id FROM collaboration_agent_operations WHERE document_id=$1
          AND status IN ('preparing','ready','applying','applied_to_ydoc','cancel_requested') LIMIT 1`, [documentId]);
        if (active) return fail('MARKDOWN_IMPORT_BUSY');
        let state: PersistedCollaborationState;
        if (input.expectedTarget.kind === 'initialized') {
          const current = await loadCollaborationStateOnConnection(database, documentId, true);
          if (!current || !document?.lineage_id || document.yjs_state_lifecycle !== 'initialized'
            || current.documentSequence < document.state_version) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
          const existingLineage = await database.get(`SELECT id FROM file_collaboration_lineages WHERE id=$1 AND workspace_id=$2
            AND organization_id IS NOT DISTINCT FROM $3 AND path=$4 AND status='active'`,
          [document.lineage_id, current.workspaceId, current.organizationId, current.path]);
          if (!existingLineage) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
          state = mutateEmpty(current, input);
        } else state = importedState(input, documentId, Date.now());
        const lineage = await ensureActiveFileLineage(database, { id: document?.lineage_id ?? `file-lineage-${randomUUID()}`,
          workspace: input.workspace, path: input.path, nowMs: state.persistedAt });
        if (lineage.organizationId !== state.organizationId || document?.lineage_id && lineage.id !== document.lineage_id) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
        await validateAuthority();
        if (input.expectedTarget.kind === 'initialized') {
          const changed = await database.get(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=$3,persisted_at=$4
            WHERE document_id=$5 AND workspace_id=$6 AND organization_id IS NOT DISTINCT FROM $7 AND path=$8 AND representation=$9
              AND lifecycle_generation=$10 AND schema_version=$11 AND document_sequence=$12 AND status='active' RETURNING document_id`,
          [Buffer.from(state.yjsState), Buffer.from(state.stateVector), state.documentSequence, state.persistedAt, documentId,
            state.workspaceId, state.organizationId, state.path, state.representation, state.lifecycleGeneration, state.schemaVersion, input.expectedTarget.documentSequence]);
          if (!changed) return fail('MARKDOWN_IMPORT_TARGET_CHANGED');
        } else await withWorkspaceFileLifecycleCollaborationWrite(state, async () => {
          const query = async (sql: string, values?: unknown[]) => await database.all(sql, values) as Array<Record<string, unknown>>;
          await lockFileLifecycleCollaborationWriterAdmission(query, state); await assertCollaborationAdmissionOpen(query, state);
          if (document) await database.run(`UPDATE collaboration_documents SET lineage_id=$1,yjs_state_lifecycle='initialized',updated_at=$2
            WHERE id=$3 AND workspace_id=$4 AND organization_id IS NOT DISTINCT FROM $5 AND path=$6 AND provider='yjs' AND status='active'`,
          [lineage.id, state.persistedAt, documentId, state.workspaceId, state.organizationId, state.path]);
          else await database.run(`INSERT INTO collaboration_documents(id,lineage_id,organization_id,customer_id,project_id,workspace_id,
            workspace_type,path,provider,state_version,status,created_at,updated_at,yjs_state_lifecycle)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'yjs',0,'active',$9,$9,'initialized')`,
          [documentId, lineage.id, state.organizationId, input.workspace.customerId ?? null, input.workspace.projectId ?? null,
            state.workspaceId, input.workspace.workspaceType, state.path, state.persistedAt]);
          await database.run(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
            schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
            VALUES($1,$2,$3,$4,$5,1,1,$6,$7,0,$8,NULL,0,NULL,NULL,$9,$10,0,'active')`,
          [documentId, state.workspaceId, state.organizationId, state.path, state.representation, Buffer.from(state.yjsState),
            Buffer.from(state.stateVector), state.persistedAt, state.newlineStyle, state.hasBom ? 1 : 0]);
        });
        const snapshot = authoritativeNativeCollaborationSnapshot(state);
        const after = inspectPersistedNativeCollaborationSnapshot(state, doc => captureAgentStateSnapshot(doc, Y));
        if (!after || after.byteLength > MARKDOWN_FILE_IMPORT_LIMIT) return fail('MARKDOWN_IMPORT_INVALID_INPUT');
        const receipt: MarkdownFileImportReceipt = { version: 1, operationId: input.operationId, requestFingerprint: input.fingerprint,
          sourceHash: input.prepared.sourceHash, sourceBytes: input.prepared.sourceBytes,
          target: { ...Object.fromEntries(identityKeys.map(key => [key, state[key]])) as MarkdownImportIdentity,
            lineageId: lineage.id, initialSequence: state.documentSequence, initialStateProof: snapshot.version.stateProof, persistedAt: state.persistedAt }, checkpointRequired: true };
        await database.run(`INSERT INTO collaboration_markdown_file_import_receipts(workspace_id,operation_id,organization_id,actor_user_id,
          actor_session_id,request_id,version,request_fingerprint,private_result,after_state_snapshot,created_at)
          VALUES($1,$2,$3,$4,$5,$6,1,$7,$8::jsonb,$9,$10)`,
        [state.workspaceId, input.operationId, state.organizationId, input.actorUserId, input.actorSessionId, input.requestId,
          input.fingerprint, JSON.stringify(receipt), Buffer.from(after), state.persistedAt]);
        return { disposition: 'applied', receipt, currentObservation: { documentSequence: state.documentSequence,
          stateProof: snapshot.version.stateProof, persistedAt: state.persistedAt } };
      },
      recoverCommitted: async () => {
        const database = await dependencies.openConnection(); let discard: Error | undefined;
        try {
          const lease = getWorkspaceFileLifecycleLeases()?.get(input.workspace.workspaceId);
          if (!lease?.active || !await lease.verify()) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
          await validateAuthority();
          await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const prior = await confirmedRetry(database, input);
          if (!prior) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
          await database.run('COMMIT');
          if (!lease.active || !await lease.verify()) return fail('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
          return { disposition: 'commit-recovered', ...prior };
        } catch (error) {
          try { await database.run('ROLLBACK'); } catch (rollbackError) { discard = new Error('Discarding unresolved import receipt verification.', { cause: rollbackError }); }
          throw error;
        } finally { await database.close(discard); }
      },
    });
  }, dependencies.openConnection);
}
