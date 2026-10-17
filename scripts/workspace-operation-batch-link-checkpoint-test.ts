/** Branch regression for the complete current Executor's private checkpointBatchLink.
 * No copied product algorithm. Append one private export, then transpile/evaluate
 * the entire current source with real runtime imports. Only load-state, pending
 * SQL/status and materializer boundaries are modeled; real Yjs serialization, workspace
 * path resolution, filesystem bytes and SHA checks remain in the product path.
 * All PG Client/Pool connect/query attempts fail. This is not genuine PG/native
 * checkpoint persistence, quarantine behavior, complete batch recovery, transport or UI acceptance.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceLinkWriteExecutorInput } from '../app/lib/markdown/workspace-link-write-executor';
import type { WorkspaceLinkWriteGroup } from '../app/lib/markdown/workspace-link-write-groups';

const repo = process.cwd(), requireLocal = createRequire(path.join(repo, 'package.json'));
const ts = requireLocal('typescript') as typeof import('typescript');
const { Pool, Client } = requireLocal('pg') as typeof import('pg');
const executorFile = path.join(repo, 'app/lib/files/workspace-operation-batch-executor.ts');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type CheckpointInput = Pick<WorkspaceLinkWriteExecutorInput, 'destination' | 'actorUserId' | 'actorType' | 'actorSessionId'>;
type Checkpoint = (input: CheckpointInput, group: WorkspaceLinkWriteGroup, documentId: string | null) => Promise<void>;
type Scenario = { name: string; pending: boolean; finalized?: boolean; checkpointSequence: number; disk: 'after' | 'before' | 'foreign' | 'absent';
  native: 'after' | 'foreign'; documentId: string | null; materializations: number; error?: string;
  fault?: { at: 'status' | 'pending' | 'materializer'; error: Error } };
const scenarios: Scenario[] = [
  { name: 'pending-with-equal-sequences-and-after-bytes', pending: true, checkpointSequence: 10, disk: 'after', native: 'after', documentId: 'native-document', materializations: 1 },
  { name: 'receipt-unfinalized-despite-backlog-false', pending: false, finalized: false, checkpointSequence: 10, disk: 'after', native: 'after', documentId: 'native-document', materializations: 1 },
  { name: 'registry-lag-despite-finalized-receipt', pending: true, finalized: true, checkpointSequence: 10, disk: 'after', native: 'after', documentId: 'native-document', materializations: 1 },
  { name: 'finalized-with-equal-sequences-and-after-bytes', pending: false, checkpointSequence: 10, disk: 'after', native: 'after', documentId: 'native-document', materializations: 0 },
  { name: 'document-sequence-ahead', pending: false, checkpointSequence: 9, disk: 'after', native: 'after', documentId: 'native-document', materializations: 1 },
  { name: 'disk-still-before', pending: false, checkpointSequence: 10, disk: 'before', native: 'after', documentId: 'native-document', materializations: 1 },
  { name: 'foreign-disk-bytes-rejected', pending: true, checkpointSequence: 10, disk: 'foreign', native: 'after', documentId: 'native-document', materializations: 0, error: 'BATCH_CHECKPOINT_FILE_CHANGED' },
  { name: 'foreign-native-bytes-rejected', pending: true, checkpointSequence: 10, disk: 'after', native: 'foreign', documentId: 'native-document', materializations: 0, error: 'BATCH_CHECKPOINT_STATE_CHANGED' },
  { name: 'no-document-id-skips-even-absent-file', pending: true, checkpointSequence: 10, disk: 'absent', native: 'after', documentId: null, materializations: 0 },
  { name: 'status-error-propagates-same-object', pending: true, checkpointSequence: 10, disk: 'after', native: 'after', documentId: 'native-document', materializations: 0, fault: { at: 'status', error: new Error('Exact projection-status boundary error') } },
  { name: 'pending-error-with-finalized-receipt-propagates-same-object', pending: true, finalized: true, checkpointSequence: 10, disk: 'after', native: 'after', documentId: 'native-document', materializations: 0, fault: { at: 'pending', error: new Error('Exact projection-pending boundary error') } },
  { name: 'materializer-error-propagates-same-object', pending: true, checkpointSequence: 10, disk: 'after', native: 'after', documentId: 'native-document', materializations: 1, fault: { at: 'materializer', error: new Error('Exact materializer boundary error') } },
];

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  const dataRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-checkpoint-batch-link-')));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
  const saved = [
    [Pool.prototype, 'query', Object.getOwnPropertyDescriptor(Pool.prototype, 'query')],
    [Pool.prototype, 'connect', Object.getOwnPropertyDescriptor(Pool.prototype, 'connect')],
    [Client.prototype, 'query', Object.getOwnPropertyDescriptor(Client.prototype, 'query')],
    [Client.prototype, 'connect', Object.getOwnPropertyDescriptor(Client.prototype, 'connect')],
  ] as const;
  let forbiddenDatabaseAttempts = 0;
  const noDatabase = () => { forbiddenDatabaseAttempts++; throw new Error('PG access is forbidden in checkpointBatchLink branch regression.'); };
  for (const [prototype, key] of saved) Object.defineProperty(prototype, key, { configurable: true, writable: true, value: noDatabase });
  Object.assign(process.env, { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot });
  const checks: Array<{ name: string; passed: boolean; stateLoads: number; pendingReads: number; statusReads: number; materializations: number }> = [];
  const failures: Error[] = [];
  let sourceHash: string | undefined;
  try {
    const originalSource = await fs.readFile(executorFile, 'utf8'); sourceHash = hash(originalSource);
    const requireExecutor = createRequire(executorFile);
    // Real helpers and real Yjs implementation; these calls must not touch PG.
    const persistence = requireExecutor('@/app/lib/collaboration/persistence') as typeof import('../app/lib/collaboration/persistence');
    const checkpoint = requireExecutor('@/app/lib/collaboration/checkpoint') as typeof import('../app/lib/collaboration/checkpoint');
    const projection = requireExecutor('@/app/lib/collaboration/projection-repository') as typeof import('../app/lib/collaboration/projection-repository');
    const { Y } = requireExecutor('@/app/lib/collaboration/server-runtime') as typeof import('../app/lib/collaboration/server-runtime');
    const { COLLABORATION_SCHEMA_VERSION } = requireExecutor('@/app/lib/collaboration/types') as typeof import('../app/lib/collaboration/types');
    let active: { scenario: Scenario; state: PersistedCollaborationState; input: CheckpointInput;
      stateLoads: number; pendingReads: number; statusReads: number; materializations: number } | undefined;
    const exports = {};
    const compiled = ts.transpileModule(originalSource + '\nexport { checkpointBatchLink as __checkpointBatchLinkForTest };\n', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    new Function('require', 'module', 'exports', compiled.outputText)((specifier: string) => {
      if (specifier === '@/app/lib/collaboration/persistence') return { ...persistence,
        loadCollaborationState: async (documentId: string) => {
          assert(active); active.stateLoads++; assert.equal(documentId, active.scenario.documentId); return active.state;
        } };
      if (specifier === '@/app/lib/collaboration/projection-repository') return { ...projection,
        hasPendingCollaborationProjection: async (state: PersistedCollaborationState) => {
          assert(active); active.pendingReads++; assert.equal(state, active.state);
          if (active.scenario.fault?.at === 'pending') throw active.scenario.fault.error;
          return active.scenario.pending;
        },
        loadCollaborationProjectionStatus: async (state: PersistedCollaborationState) => {
          assert(active); active.statusReads++; assert.equal(state, active.state);
          if (active.scenario.fault?.at === 'status') throw active.scenario.fault.error;
          return { degraded: state.degraded, projectionError: state.projectionError,
            projectionFinalized: active.scenario.finalized ?? !active.scenario.pending };
        } };
      if (specifier === '@/app/lib/collaboration/checkpoint') return { ...checkpoint,
        materializeCollaborationCheckpoint: async (input: Parameters<typeof checkpoint.materializeCollaborationCheckpoint>[0]) => {
          assert(active); active.materializations++;
          assert.equal(input.state, active.state); assert.equal(input.workspace, active.input.destination.workspace);
          assert.equal(input.actorUserId, active.input.actorUserId); assert.equal(input.actorType, active.input.actorType);
          assert.equal(input.sourceSessionId, active.input.actorSessionId);
          if (active.scenario.fault?.at === 'materializer') throw active.scenario.fault.error;
          return { content: 'modeled materializer result only', revisionId: 'modeled-checkpoint-revision', serializedContent: 'modeled materializer result only' };
        } };
      return requireExecutor(specifier);
    }, { exports }, exports);
    const invoke = (exports as { __checkpointBatchLinkForTest: Checkpoint }).__checkpointBatchLinkForTest;
    assert.equal(typeof invoke, 'function');
    const workspace: WorkspaceContext = { workspaceId: `branch-${randomUUID()}`, workspaceType: 'personal',
      rootPath: path.join(dataRoot, 'workspace'), rootRelativePath: 'workspace', actor: { userId: 'tester', role: 'owner' },
      ownerUserId: 'tester', organizationId: null, legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canCreatePublicLinks: false, canManageWorkspace: true } };
    await fs.mkdir(workspace.rootPath, { mode: 0o700 });
    const before = '# Before\n\n[Asset](asset.pdf)\n', after = '# After\n\nAsset removed.\n', foreign = '# Unrelated content\n';
    for (const scenario of scenarios) {
      const filePath = `${scenario.name}.md`, absolute = path.join(workspace.rootPath, filePath);
      const diskBytes = scenario.disk === 'after' ? after : scenario.disk === 'before' ? before : foreign;
      if (scenario.disk !== 'absent') await fs.writeFile(absolute, diskBytes, { mode: 0o600, flag: 'wx' });
      const doc = new Y.Doc({ gc: true });
      let state: PersistedCollaborationState;
      try {
        doc.getText('content').insert(0, scenario.native === 'after' ? after : foreign);
        state = { documentId: 'native-document', workspaceId: workspace.workspaceId, organizationId: null, path: filePath,
          representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: COLLABORATION_SCHEMA_VERSION,
          yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 10,
          checkpointSequence: scenario.checkpointSequence, checkpointedAt: 1, persistedAt: 1,
          canonicalHash: hash(after), serializedHash: hash(after), newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
      } finally { doc.destroy(); }
      const input: CheckpointInput = { destination: { workspace, fileOptions: { workspace } }, actorUserId: 'tester', actorType: 'agent', actorSessionId: 'actual-branch-session' };
      const group: WorkspaceLinkWriteGroup = { workspaceId: workspace.workspaceId, path: filePath,
        sourceWorkspaceId: workspace.workspaceId, sourcePathBefore: filePath, beforeSha256: hash(before), afterSha256: hash(after), afterContent: after, edits: [] };
      active = { scenario, state, input, stateLoads: 0, pendingReads: 0, statusReads: 0, materializations: 0 };
      let passed = false;
      try {
        if (scenario.fault) await assert.rejects(invoke(input, group, scenario.documentId), (error: unknown) => {
          assert.equal(error, scenario.fault!.error, 'The exact original boundary Error object must reach the caller.'); return true;
        });
        else if (scenario.error) await assert.rejects(invoke(input, group, scenario.documentId), { message: scenario.error });
        else await invoke(input, group, scenario.documentId);
        assert.equal(active.materializations, scenario.materializations, scenario.name);
        assert.equal(active.stateLoads, scenario.documentId === null ? 0 : 1);
        if (scenario.documentId === null) { assert.equal(active.pendingReads, 0); assert.equal(active.statusReads, 0); }
        if (scenario.disk === 'absent') await assert.rejects(fs.lstat(absolute), { code: 'ENOENT' });
        else assert.equal(hash(await fs.readFile(absolute)), hash(diskBytes), 'The modeled materializer must not alter real disk bytes.');
        passed = true;
      } catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      checks.push({ name: scenario.name, passed, stateLoads: active.stateLoads, pendingReads: active.pendingReads, statusReads: active.statusReads, materializations: active.materializations });
      active = undefined;
    }
    assert.equal(forbiddenDatabaseAttempts, 0);
    assert.equal(hash(await fs.readFile(executorFile)), sourceHash, 'The complete original Executor source must remain unchanged.');
    assert.equal(checks.length, 12);
    console.log(JSON.stringify({ suite: 'checkpoint-batch-link-branch', sourceHash, checks,
      scope: 'Complete original Executor; real imports, Yjs, FS, SHA and path guard; modeled state/pending/status SQL and materializer only. No genuine PG/checkpoint persistence or batch/UI claim.' }));
    if (failures.length) throw new AggregateError(failures, 'checkpointBatchLink branch assertions failed.');
  } finally {
    try { assert.equal(forbiddenDatabaseAttempts, 0); }
    finally {
      for (const [prototype, key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor); else Reflect.deleteProperty(prototype, key);
      }
      for (const key of ['DATA', 'CANVAS_DATA_ROOT'] as const) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  }
}
let completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('checkpoint-batch-link-branch: INCOMPLETE'); process.exitCode = 1; } });
void main().then(() => { completed = true; console.log('checkpoint-batch-link-branch: COMPLETED: all twelve assertions and cleanup settled.'); })
  .catch(error => { console.error(error); process.exitCode = 1; });
