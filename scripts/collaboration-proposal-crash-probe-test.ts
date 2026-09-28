import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as Y from 'yjs';
import type { AgentDirectConnectionInput } from '../app/lib/collaboration/direct-connection';
import type { FileRevisionRecord } from '../app/lib/files/collaboration-policy';
import type { FileVersionContentBinding } from '../app/lib/file-version-center/version-content-store';
import {
  installProposalCrashProbe,
  type CrashPoint,
  type CrashTarget,
} from './collaboration-proposal-crash-probe';

type ProbeOptions = Parameters<typeof installProposalCrashProbe>[0];
type Bridge = ProbeOptions['bridge'];
type Handler = NonNullable<Bridge['__canvasCollaborationDirectConnection']>;
type History = ProbeOptions['history'];
type HistoryInput = Parameters<History['capturePersistedCollaboration']>[0];
type CaptureResult = Awaited<ReturnType<History['capturePersistedCollaboration']>>;

const target: CrashTarget = {
  documentId: 'document-1',
  workspaceId: 'workspace-1',
  path: 'fvrc-1008-ordinary-00000000-0000-0000-0000-000000000001.md',
  userId: 'user-1',
};

const disabledCapture: CaptureResult = { outcome: 'disabled', revision: null, binding: null };
const revision: FileRevisionRecord = {
  id: 'revision-1', lineageId: 'lineage-1', organizationId: null, customerId: null, projectId: null,
  workspaceId: target.workspaceId, workspaceType: 'personal', path: target.path, contentHash: 'a'.repeat(64),
  sizeBytes: 0, createdByUserId: target.userId, createdByActorType: 'user', sourceSessionId: 'session-1',
  baseRevisionId: null, createdAt: 1,
};
const binding: FileVersionContentBinding = {
  revisionId: revision.id, workspaceId: target.workspaceId, lineageId: revision.lineageId!, blobId: 'blob-1',
  format: 'markdown', source: 'agent_apply', stateVectorHash: 'b'.repeat(64), sha256: 'a'.repeat(64),
  rawSizeBytes: 0, storedSizeBytes: 20, createdAt: 1,
};
function successfulCapture(outcome: 'captured' | 'already_captured'): CaptureResult {
  return { outcome, revision, binding };
}

function makeInput(overrides: Partial<AgentDirectConnectionInput> = {}): AgentDirectConnectionInput {
  return {
    documentId: target.documentId,
    documentPath: target.path,
    documentRepresentation: 'plain_text',
    documentLifecycleGeneration: 1,
    documentSchemaVersion: 1,
    requiresFileCheckpointIdentity: true,
    workspace: { workspaceId: target.workspaceId, organizationId: null } as AgentDirectConnectionInput['workspace'],
    actorId: target.userId,
    actorDisplayName: 'Reviewer',
    initiatedByUserId: target.userId,
    operationId: 'action-1',
    actorType: 'user',
    actorSessionId: 'session-1',
    versionSource: 'agent_apply',
    ...overrides,
  };
}

function makeHistoryInput(overrides: Record<string, unknown> = {}): HistoryInput {
  return {
    state: {
      documentId: target.documentId,
      workspaceId: target.workspaceId,
      path: target.path,
      documentSequence: 17,
      yjsState: Uint8Array.of(0x41),
    },
    source: 'agent_apply',
    ...overrides,
  } as unknown as HistoryInput;
}

function harness(point: CrashPoint, captureResult = successfulCapture('captured')) {
  const events: string[] = [];
  const evidence: Array<Parameters<ProbeOptions['interrupt']>[0]> = [];
  let mutations = 0;
  let acknowledgements = 0;
  let historyCalls = 0;
  const directCalls: Array<{ input: AgentDirectConnectionInput; apply: unknown; onApplied: unknown }> = [];
  const original: Handler = async function <T>(input: AgentDirectConnectionInput,
    apply: (doc: Y.Doc) => T, onApplied?: (result: T) => Promise<void>): Promise<T> {
    directCalls.push({ input, apply, onApplied });
    events.push('direct-enter');
    const result = apply({} as Y.Doc);
    await onApplied?.(result);
    events.push('direct-return');
    return result;
  };
  const bridge: Bridge = { __canvasCollaborationDirectConnection: original };
  const originalCapture: History['capturePersistedCollaboration'] = async () => {
    historyCalls++;
    events.push('history');
    return captureResult;
  };
  const history: History = { capturePersistedCollaboration: originalCapture };
  const uninstall = installProposalCrashProbe({
    bridge,
    history,
    target,
    point,
    encodeApplied: () => Uint8Array.of(0x41),
    persistedMatches: ({ persistedUpdate, candidateUpdate }) => persistedUpdate.length === candidateUpdate.length
      && persistedUpdate.every((byte, index) => byte === candidateUpdate[index]),
    interrupt: async (item) => {
      evidence.push(item);
      events.push('interrupt');
      return undefined as never;
    },
  });
  const current = () => {
    const handler = bridge.__canvasCollaborationDirectConnection;
    assert.equal(typeof handler, 'function');
    return handler!;
  };
  const apply: Parameters<Handler>[1] = () => {
    mutations++;
    events.push('apply');
    return 'applied-once';
  };
  const onApplied: NonNullable<Parameters<Handler>[2]> = async () => {
    acknowledgements++;
    events.push('ack');
  };
  return {
    bridge, history, original, originalCapture, uninstall, current, apply, onApplied, directCalls,
    events, evidence, get mutations() { return mutations; },
    get acknowledgements() { return acknowledgements; }, get historyCalls() { return historyCalls; },
  };
}

test('crash probe passes foreign document/workspace/path/user and non-user operations through unchanged', async () => {
  for (const overrides of [
    { documentId: 'other-document' },
    { workspace: { workspaceId: 'other-workspace', organizationId: null } as AgentDirectConnectionInput['workspace'] },
    { documentPath: 'other.md' },
    { initiatedByUserId: 'other-user' },
    { actorType: 'agent' as const },
  ]) {
    const h = harness('persisted-before-history');
    try {
      const input = makeInput(overrides);
      const apply = h.apply;
      const onApplied = h.onApplied;
      await h.current()(input, apply, onApplied);
      assert.equal(h.directCalls.length, 1);
      assert.strictEqual(h.directCalls[0]!.input, input);
      assert.strictEqual(h.directCalls[0]!.apply, apply);
      assert.strictEqual(h.directCalls[0]!.onApplied, onApplied);
      assert.equal(h.mutations, 1);
      assert.equal(h.acknowledgements, 1);
      assert.equal(h.evidence.length, 0);
      assert.deepEqual(h.events, ['direct-enter', 'apply', 'ack', 'direct-return']);
      assert.notStrictEqual(h.bridge.__canvasCollaborationDirectConnection, h.original);
    } finally { h.uninstall(); }
  }
});

test('persisted-before-ack holds only the applied acknowledgement until matching history arrives', async () => {
  const h = harness('persisted-before-ack');
  try {
    const pending = h.current()(makeInput(), h.apply, h.onApplied);
    await Promise.resolve();
    assert.deepEqual(h.events, ['direct-enter', 'apply']);
    assert.equal(h.mutations, 1);
    assert.equal(h.acknowledgements, 0);

    await h.history.capturePersistedCollaboration(makeHistoryInput());
    assert.deepEqual(h.events, ['direct-enter', 'apply', 'interrupt']);
    assert.equal(h.historyCalls, 0, 'the before-ack probe interrupts instead of capturing history');
    assert.deepEqual(h.evidence, [{ point: 'persisted-before-ack', operationId: 'action-1', mutations: 1,
      acknowledged: false, historyCaptured: false, documentSequence: 17 }]);

    await assert.rejects(h.current()(makeInput({ operationId: 'action-2' }), h.apply, h.onApplied), /only one action/u);
    assert.equal(h.mutations, 1, 'a second call cannot run the mutation callback again');
    void pending;
  } finally { h.uninstall(); }
});

test('persisted-before-history acknowledges first but interrupts before the history capture', async () => {
  const h = harness('persisted-before-history');
  try {
    await h.current()(makeInput(), h.apply, h.onApplied);
    assert.deepEqual(h.events, ['direct-enter', 'apply', 'ack', 'direct-return']);
    await h.history.capturePersistedCollaboration(makeHistoryInput({
      state: { documentId: target.documentId, workspaceId: target.workspaceId, path: target.path,
        documentSequence: 16, yjsState: Uint8Array.of(0x42) },
    }));
    assert.deepEqual(h.events, ['direct-enter', 'apply', 'ack', 'direct-return', 'history']);
    assert.equal(h.evidence.length, 0, 'a matching path/source is insufficient if persisted bytes differ');
    await h.history.capturePersistedCollaboration(makeHistoryInput());
    assert.deepEqual(h.events, ['direct-enter', 'apply', 'ack', 'direct-return', 'history', 'interrupt']);
    assert.equal(h.historyCalls, 1, 'only the false match reaches the ordinary history handler');
    assert.deepEqual(h.evidence, [{ point: 'persisted-before-history', operationId: 'action-1', mutations: 1,
      acknowledged: true, historyCaptured: false, documentSequence: 17 }]);
    await assert.rejects(h.current()(makeInput({ operationId: 'action-2' }), h.apply, h.onApplied), /only one action/u);
    assert.equal(h.mutations, 1);
  } finally { h.uninstall(); }
});

test('history-before-receipt awaits one history capture before interrupting', async () => {
  const h = harness('history-before-receipt', successfulCapture('already_captured'));
  try {
    await h.current()(makeInput(), h.apply, h.onApplied);
    assert.deepEqual(h.events, ['direct-enter', 'apply', 'ack', 'direct-return']);
    await h.history.capturePersistedCollaboration(makeHistoryInput());
    assert.deepEqual(h.events, ['direct-enter', 'apply', 'ack', 'direct-return', 'history', 'interrupt']);
    assert.equal(h.historyCalls, 1);
    assert.deepEqual(h.evidence, [{ point: 'history-before-receipt', operationId: 'action-1', mutations: 1,
      acknowledged: true, historyCaptured: true, documentSequence: 17 }]);
    await assert.rejects(h.current()(makeInput({ operationId: 'action-2' }), h.apply, h.onApplied), /only one action/u);
    assert.equal(h.mutations, 1);
  } finally { h.uninstall(); }
});

test('history-before-receipt does not interrupt for disabled, unsupported, or incomplete captures', async () => {
  const invalidCaptures: CaptureResult[] = [
    disabledCapture,
    { outcome: 'unsupported', revision: null, binding: null },
    { outcome: 'captured', revision: null, binding },
    { outcome: 'captured', revision, binding: null },
    { outcome: 'already_captured', revision: null, binding },
    { outcome: 'deduplicated_checkpoint', revision, binding },
  ];
  for (const result of invalidCaptures) {
    const h = harness('history-before-receipt', result);
    try {
      await h.current()(makeInput(), h.apply, h.onApplied);
      await h.history.capturePersistedCollaboration(makeHistoryInput());
      assert.deepEqual(h.events, ['direct-enter', 'apply', 'ack', 'direct-return', 'history']);
      assert.equal(h.historyCalls, 1);
      assert.equal(h.evidence.length, 0, `${result.outcome} without a complete captured revision is not a history boundary`);
      assert.equal(h.mutations, 1);
    } finally { h.uninstall(); }
  }
});

test('crash probe validates bridge, crash point, and fixture identity before installing wrappers', () => {
  const history: History = { capturePersistedCollaboration: async () => disabledCapture };
  const options = {
    bridge: {} as Bridge,
    history,
    target,
    point: 'persisted-before-ack' as CrashPoint,
    encodeApplied: () => Uint8Array.of(0x41),
    persistedMatches: () => true,
    interrupt: async () => undefined as never,
  } satisfies ProbeOptions;
  assert.throws(() => installProposalCrashProbe(options), /bridge is not ready/u);

  const bridge: Bridge = { __canvasCollaborationDirectConnection: async <T>() => undefined as T };
  const originalHandler = bridge.__canvasCollaborationDirectConnection;
  const originalCapture = history.capturePersistedCollaboration;
  for (const invalid of [
    { ...options, bridge, point: 'before-mutation' as CrashPoint },
    { ...options, bridge, target: { ...target, path: '../outside.md' } },
    { ...options, bridge, target: { ...target, documentId: 'bad id' } },
    { ...options, bridge, target: { ...target, workspaceId: '' } },
    { ...options, bridge, target: { ...target, userId: 'bad/id' } },
  ]) assert.throws(() => installProposalCrashProbe(invalid as ProbeOptions), /Invalid crash fixture scope/u);
  assert.strictEqual(bridge.__canvasCollaborationDirectConnection, originalHandler, 'validation failures do not replace the bridge');
  assert.strictEqual(history.capturePersistedCollaboration, originalCapture, 'validation failures do not wrap history');
});

test('uninstall does not overwrite a later bridge or history installation', () => {
  const h = harness('persisted-before-history');
  try {
    const laterHandler: Handler = async <T>() => 'later' as T;
    const laterCapture: History['capturePersistedCollaboration'] = async () => disabledCapture;
    h.bridge.__canvasCollaborationDirectConnection = laterHandler;
    h.history.capturePersistedCollaboration = laterCapture;
    h.uninstall();
    assert.strictEqual(h.bridge.__canvasCollaborationDirectConnection, laterHandler);
    assert.strictEqual(h.history.capturePersistedCollaboration, laterCapture);
  } finally { h.uninstall(); }
});
