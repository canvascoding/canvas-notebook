import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as Admission from '../app/lib/collaboration/room-admission-contract';
import * as Representation from '../app/lib/collaboration/representation-admission-contract';
import * as Persistence from '../app/lib/collaboration/persistence';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { collaborationUpdateStateProof } from '../app/lib/collaboration/state-proof';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { RichMigrationRequest } from '../app/lib/collaboration/representation-migration-contract';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type * as Migration from '../app/lib/collaboration/representation-migration';

type Scenario = {
  current: PersistedCollaborationState | null;
  stored: Admission.CollaborationAdmissionRequest | null;
  status: Admission.CollaborationAdmissionStatus;
  outcome: { version: 1 | 2 } | null;
  lookupError?: Error;
  outcomeError?: Error;
  executeError?: Error;
  abortError?: Error;
  projectionError?: Error;
  revoked?: boolean;
  runtimeReady?: boolean;
  ownerEpoch?: number;
  retainedRoomCount?: number;
  concurrentReserveAtRuntimeCheck?: boolean;
  loseStateAfterCommit?: boolean;
  freshOrganizationId?: string;
  lineageDocumentId?: string;
};

/** Fault injection exercises the real migration outcome wrapper; the PG test proves its durable coordinator separately. */
async function main() {
  const document = createPlainTextYDoc('# Outcome fixture\n\nBody.\n');
  const state: PersistedCollaborationState = {
    documentId: 'outcome-document', workspaceId: 'outcome-workspace', organizationId: null, path: 'outcome.md',
    lifecycleGeneration: 1, representation: 'plain_text', documentSequence: 1, checkpointSequence: 1,
    stateVector: Y.encodeStateVector(document), yjsState: Y.encodeStateAsUpdate(document), status: 'active', schemaVersion: 1,
    persistedAt: 1, checkpointedAt: 1, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false,
  };
  document.destroy();
  const proof = collaborationUpdateStateProof(state.yjsState, Y)!;
  const migration: RichMigrationRequest = { requestId: randomUUID(), expectedDocumentId: state.documentId,
    expectedLifecycleGeneration: 1, documentSequence: 1, stateProof: proof };
  const request = Representation.createRepresentationAdmissionRequest(state, 'outcome-actor', migration);
  const workspace = { workspaceId: state.workspaceId, organizationId: null,
    actor: { userId: 'outcome-actor' }, permissions: { canWrite: true } } as WorkspaceContext;
  const newState: PersistedCollaborationState = { ...state, representation: 'tiptap_blocks',
    lifecycleGeneration: 2, documentSequence: 2, schemaVersion: 3 };
  let scenario: Scenario;
  let events: string[] = [];
  let authorizedPaths: string[] = [];
  let lifecycleLocked = false;
  const reset = (overrides: Partial<Scenario> = {}) => {
    scenario = { current: state, stored: request, status: 'reserved', outcome: null, runtimeReady: true, ...overrides };
    events = [];
    authorizedPaths = [];
  };
  const resultFor = () => ({ requestId: request.requestId, requestDigest: Admission.captureCollaborationAdmissionRequest(request).requestDigest,
    status: scenario.status, revision: 1, targets: [{ document: request.expectedDocuments[0], ownerToken: null }] });
  const filename = path.resolve('app/lib/collaboration/representation-migration.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const moduleExports = {} as typeof Migration;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@/app/lib/db') return { openDb: async () => ({ get: async () => ({ room_owner_epoch: scenario.ownerEpoch ?? 1 }), close: async () => {} }) };
    if (name.endsWith('/workspace-mutation-lock')) return { withWorkspaceMutationLock: async (_id: string, operation: () => unknown) => operation() };
    if (name.endsWith('/collaboration-policy')) return { readFileCollaborationState: async (input: { path: string }) => {
      authorizedPaths.push(input.path);
      return { document: { id: scenario.lineageDocumentId ?? state.documentId } };
    } };
    if (name.endsWith('/postgres-runtime')) return { readPostgresWorkspaceForActor: async () => ({ ...workspace,
      organizationId: scenario.freshOrganizationId ?? workspace.organizationId,
      permissions: { canWrite: !scenario.revoked } }) };
    if (name === './checkpoint') return { materializeCollaborationCheckpoint: async () => {
      if (scenario.projectionError) throw scenario.projectionError;
      return { state: scenario.current };
    } };
    if (name === './room-admission') return { createCollaborationAdmissionService: () => ({
      read: async () => scenario.stored ? resultFor() : null,
      reserve: async () => { assert.equal(lifecycleLocked, true); events.push('reserve'); scenario.stored = request; return resultFor(); },
      cancel: async () => { assert.equal(lifecycleLocked, true); events.push('cancel'); scenario.status = 'cancelled'; },
      startDrain: async () => { events.push('drain'); scenario.status = 'draining'; },
    }) };
    if (name === './room-admission-handoff') return { createCollaborationAdmissionHandoffService: () => ({
      loadRequest: async () => { if (scenario.lookupError) throw scenario.lookupError; return scenario.stored; },
      readOutcome: async () => { if (scenario.outcomeError) throw scenario.outcomeError; return scenario.outcome; },
      execute: async () => { if (scenario.executeError) throw scenario.executeError;
        events.push('execute');
        scenario.current = scenario.loseStateAfterCommit ? null : newState; scenario.outcome = { version: 1 }; },
      abort: async () => { if (scenario.abortError) throw scenario.abortError; events.push('abort'); scenario.status = 'committed'; scenario.outcome = { version: 2 }; },
    }) };
    if (name === './room-admission-quiescence') return { createCollaborationAdmissionQuiescenceService: () => ({ prove: async () => {} }) };
    if (name === './room-admission-contract') return Admission;
    if (name === './representation-admission-contract') return Representation;
    if (name === './persistence') return { ...Persistence, loadCollaborationState: async () => scenario.current };
    if (name === './projection-repository') return { loadCollaborationProjectionStatus: async () => ({ projectionFinalized: true }) };
    if (name === './runtime-state') return { getCollaborationRoomConnectionCount: () => scenario.retainedRoomCount ?? 0,
      withCollaborationRoomLifecycleLock: async (_id: string, operation: () => unknown) => {
        assert.equal(lifecycleLocked, false);
        lifecycleLocked = true;
        try { return await operation(); } finally { lifecycleLocked = false; }
      } };
    if (name === './representation-migration-runtime') return { richMigrationRuntimeAvailable: () => {
      if (scenario.concurrentReserveAtRuntimeCheck) { scenario.stored = request; scenario.status = 'reserved'; }
      return scenario.runtimeReady;
    },
      richMigrationConnectedClients: () => 0 };
    return load(name);
  }, { exports: moduleExports }, moduleExports);
  const advance = (currentWorkspace = workspace, cancel = false, inputState = state, inputMigration = migration) => moduleExports.advanceRichRepresentationMigration({ workspace: currentWorkspace,
    path: inputState.path, state: inputState, migration: inputMigration, cancel });
  const unresolved = async (label: string, overrides: Partial<Scenario>) => {
    reset(overrides);
    const result = await advance();
    assert.equal(result.migration.status, 'pending', `${label} must never authorize resuming the old writer.`);
    assert.equal(result.state.lifecycleGeneration, scenario.current?.lifecycleGeneration ?? 1);
    if (scenario.loseStateAfterCommit || scenario.current === null) assert.equal(result.migration.reason, 'outcome_unconfirmed',
      `${label} must suppress session-ticket issuance until canonical identity is available.`);
  };
  await unresolved('durable outcome recovery error', { outcomeError: new Admission.CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED') });
  await unresolved('revoked write rights with existing reservation', { revoked: true });
  await unresolved('unknown lookup outcome', { lookupError: new Error('Storage unavailable before historical lookup') });
  await unresolved('failed guarded abort', { executeError: new Persistence.CollaborationRepresentationMigrationError('Checkpoint changed', 'checkpoint_stale'),
    abortError: new Admission.CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED') });
  await unresolved('committed new lifecycle with unavailable outcome', { current: newState,
    outcomeError: new Admission.CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED') });
  await unresolved('projection failure after committed switch', { projectionError: new Error('Deliberate projection failure') });
  await unresolved('missing current state after committed switch', { loseStateAfterCommit: true });
  reset({ status: 'cancelled' });
  assert.equal((await advance()).migration.status, 'blocked', 'Verified terminal cancellation may safely retain old identity.');
  reset({ stored: null, runtimeReady: false });
  assert.equal((await advance()).migration.status, 'blocked', 'A new rejected request with no durable operation may safely retain old identity.');
  assert.equal(scenario!.status, 'cancelled', 'A definitive rejection must leave a tombstone that prevents a concurrent same-ID request.');
  reset({ stored: null, runtimeReady: false, concurrentReserveAtRuntimeCheck: true });
  const racedRejection = await advance();
  if (racedRejection.migration.status === 'blocked') assert.equal(scenario!.status, 'cancelled',
    'A request accepted concurrently with preflight rejection must be terminal before old-writer resume.');
  else assert.equal(racedRejection.migration.status, 'pending');
  reset({ stored: null, ownerEpoch: 0, retainedRoomCount: 1 });
  const cancelled = await advance(workspace, true);
  assert.equal(cancelled.migration.status, 'blocked');
  assert.equal(cancelled.migration.reason, 'cancelled');
  assert.deepEqual(events, ['reserve', 'cancel'], 'No-history cancellation must durably reserve and cancel inside the lifecycle lock.');
  assert.equal(scenario!.status, 'cancelled');
  assert.equal((await advance()).migration.status, 'blocked', 'A later same-ID first request must replay the terminal cancellation.');
  reset();
  const denied = await advance({ ...workspace, permissions: { ...workspace.permissions, canWrite: false } });
  assert.equal(denied.migration.status, 'pending', 'Early rights denial must not hide an existing active reservation.');
  const movedRich = { ...newState, path: 'renamed/outcome.md' };
  const movedPlain = { ...state, path: 'renamed/outcome.md' };
  reset({ current: movedRich, status: 'committed', outcome: { version: 1 } });
  const movedCommit = await advance(workspace, false, movedRich);
  assert.equal(movedCommit.migration.status, 'migrated', 'A lost successful response must resolve after a closed-file rename.');
  assert.equal(movedCommit.state.path, movedRich.path);
  assert.equal(movedCommit.state.lifecycleGeneration, 2);
  assert.deepEqual(events, [], 'A historical committed result must not reserve, drain or apply again.');
  assert.ok(authorizedPaths.length > 0 && authorizedPaths.every(currentPath => currentPath === movedRich.path));
  reset({ current: movedPlain, status: 'cancelled' });
  const movedCancel = await advance(workspace, false, movedPlain);
  assert.equal(movedCancel.migration.status, 'blocked', 'Durable cancellation may resolve at the moved canonical path.');
  assert.equal(movedCancel.state.path, movedPlain.path); assert.deepEqual(events, []);
  reset({ current: movedPlain, status: 'committed', outcome: { version: 2 } });
  assert.equal((await advance(workspace, false, movedPlain)).migration.status, 'blocked');
  assert.deepEqual(events, [], 'Historical guarded abort may resolve without new mutation authority.');
  reset({ current: movedRich, status: 'committed', outcome: { version: 1 }, projectionError: new Error('Moved projection failure') });
  const movedProjection = await advance(workspace, false, movedRich);
  assert.equal(movedProjection.migration.status, 'pending'); assert.equal(movedProjection.state.path, movedRich.path);
  assert.equal(movedProjection.state.lifecycleGeneration, 2); assert.deepEqual(events, []);
  reset({ current: movedPlain, status: 'reserved' });
  const movedUncommitted = await advance(workspace, false, movedPlain);
  assert.equal(movedUncommitted.migration.status, 'pending', 'An uncommitted operation cannot acquire a different path.');
  assert.equal(movedUncommitted.migration.reason, 'ADMISSION_SCOPE_CHANGED'); assert.deepEqual(events, []);
  for (const [label, overrides, currentWorkspace] of [
    ['revoked rights', { revoked: true }, workspace],
    ['wrong organization', { freshOrganizationId: 'other-organization' }, workspace],
    ['reused path with another document', { lineageDocumentId: 'different-document' }, workspace],
    ['different actor', {}, { ...workspace, actor: { ...workspace.actor!, userId: 'different-actor' } }],
    ['unverified historical outcome', { outcomeError: new Admission.CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED') }, workspace],
  ] as Array<[string, Partial<Scenario>, WorkspaceContext]>) {
    reset({ current: movedRich, status: 'committed', outcome: { version: 1 }, ...overrides });
    assert.equal((await advance(currentWorkspace, false, movedRich)).migration.status, 'pending', `${label} cannot authorize a moved historical result.`);
    assert.deepEqual(events, []);
  }
  reset({ current: movedRich, status: 'committed', outcome: { version: 1 } });
  assert.equal((await advance(workspace, false, movedRich, { ...migration, stateProof: `yjs-snapshot-sha256-v1:${'0'.repeat(64)}` })).migration.reason,
    'ADMISSION_REQUEST_CHANGED', 'Moved replay must still bind the immutable five-field request.');
  const movedText = { ...newState, path: 'renamed/outcome.txt' };
  reset({ current: movedText, status: 'committed', outcome: { version: 1 } });
  assert.equal((await advance(workspace, false, movedText)).migration.status, 'migrated', 'A TXT rename may resolve a historical result without starting a new migration.');
  assert.deepEqual(events, []);
  reset({ current: { ...state, path: movedText.path }, stored: null });
  assert.equal((await advance(workspace, false, { ...state, path: movedText.path })).migration.status, 'unsupported');
  assert.deepEqual(events, [], 'A new TXT request remains protected from Rich migration.');
  console.log('Representation outcome faults: passed (reservation/recovery/abort/ACL errors remain pending, committed identity preserved, terminal-only safe resume, moved verified outcomes with immutable actor/org/document/ACL checks).');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
