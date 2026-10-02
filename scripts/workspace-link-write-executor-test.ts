import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { FileCollaborationState, getFileCollaborationState, readFileCollaborationState } from '../app/lib/files/collaboration-policy';
import type { resolveTextCollaborationState } from '../app/lib/collaboration/document-state-service';
import type { loadCollaborationStateIncludingArchived } from '../app/lib/collaboration/persistence';
import type { getFileStats, readFile } from '../app/lib/filesystem/workspace-files';
import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';
import { groupWorkspaceLinkWrites } from '../app/lib/markdown/workspace-link-write-groups';
import type { ActiveWorkspaceLinkEditsInput } from '../app/lib/markdown/workspace-link-yjs-edits';
import {
  createWorkspaceLinkWriteExecutor,
  WorkspaceLinkWriteExecutorError,
  type WorkspaceLinkWriteExecutorInput,
  type WorkspaceLinkWritePreflight,
} from '../app/lib/markdown/workspace-link-write-executor';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { createActiveWorkspaceLinkEditService } from '../app/lib/markdown/workspace-link-yjs-edits';
import { CollaborationDocumentStateError } from '../app/lib/collaboration/document-state-service';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';

const original = '[x](./asset.png)';
const rewritten = '[x](../images/asset.png)';
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
  test(`checkpointed ${representation} Wiki repair preflights and writes without representation migration`, async () => {
    const doc = createRichMarkdownYDoc('[[A/Plan|Plan]]\n', representation);
    try {
      const content = richMarkdownFromYDoc(doc);
      const plan = createWorkspaceFileOperationPlan({ kind: 'move', sourceWorkspaceId: 'src', destinationWorkspaceId: 'src',
        selections: [{ sourcePath: 'A/Plan.md', destinationPath: 'final/Other.md' }],
        snapshots: [{ workspaceId: 'src', entries: [
          { path: 'A/Plan.md', kind: 'file', identity: 'source', markdownContent: '# Original\n' },
          { path: 'home.md', kind: 'file', identity: 'home', markdownContent: content },
        ] }] });
      assert.equal(plan.readiness, 'ready');
      const workspace = { workspaceId: 'src', workspaceType: 'personal', rootPath: '/tmp/rich-checkpoint-test' } as WorkspaceContext;
      const state = { documentId: 'rich-document', workspaceId: 'src', path: 'home.md', representation,
        lifecycleGeneration: 1, schemaVersion: 1, newlineStyle: 'lf', hasBom: false,
        degraded: false, status: 'active' } as PersistedCollaborationState;
      let disk = Buffer.from(content);
      let resolutions = 0;
      const active = createActiveWorkspaceLinkEditService({ loadState: async () => state,
        readCurrent: async (input) => input.read(doc), directConnection: async (input, apply) => {
          assert.equal(input.documentRepresentation, representation);
          const result = apply(doc);
          disk = Buffer.from(richMarkdownFromYDoc(doc));
          return result;
        } });
      const executor = createWorkspaceLinkWriteExecutor({
        isDirectConnectionAvailable: () => true, isLiveReaderAvailable: () => true,
        loadPersistedState: async () => state,
        readFile: async () => disk,
        readCollaborationState: async (): Promise<FileCollaborationState> => ({
          lineageId: 'home-lineage', path: state.path, strategy: 'crdt_text', crdtCapable: true,
          sceneCapable: false, lockRequired: false, requiresRevisionCheck: false,
          latestRevision: null, activeLock: null,
          document: { id: state.documentId, organizationId: null, customerId: null, projectId: null,
            workspaceId: state.workspaceId, workspaceType: 'personal', path: state.path,
            provider: 'yjs', stateVersion: 1, snapshotRevisionId: 'home-checkpoint',
            status: 'active', createdAt: 1, updatedAt: 1 },
        }),
        resolveTextState: async (input) => {
          resolutions += 1;
          if (input.requireRepresentationMatch && input.initialRepresentation !== state.representation) {
            throw new CollaborationDocumentStateError('The collaboration document representation is stale.', 'COLLABORATION_REPRESENTATION_MISMATCH');
          }
          return { state, initialized: false };
        }, preflightActive: active.preflight, applyActive: active.apply,
      });
      const input: WorkspaceLinkWriteExecutorInput = { plan, source: { workspace, fileOptions: { workspace } },
        destination: { workspace, fileOptions: { workspace } }, actorUserId: 'reviewer', actorId: 'reviewer',
        actorDisplayName: 'Reviewer', actorType: 'user', operationId: 'rich-checkpoint-repair' };
      const preflight = await executor.preflight(input);
      assert.equal(resolutions, 1);
      assert.equal(disk.toString(), content);
      assert.equal(preflight.sources[0].mode, 'active-yjs');
      const group = groupWorkspaceLinkWrites(plan)[0];
      assert.equal((await executor.applyGroup(input, group, { preflight })).status, 'applied');
      assert.equal(disk.toString(), '[[final/Other|Plan]]\n');
      assert.equal((await executor.applyGroup(input, group, { preflight })).status, 'already-applied');
      assert.equal(state.representation, representation);
    } finally { doc.destroy(); }
  });
}

function copyPlan(markdownContent = original) {
  const plan = createWorkspaceFileOperationPlan({
    kind: 'copy', sourceWorkspaceId: 'src', destinationWorkspaceId: 'dest',
    selections: [
      { sourcePath: 'notes.md', destinationPath: 'archive/notes.md' },
      { sourcePath: 'asset.png', destinationPath: 'images/asset.png' },
    ],
    snapshots: [
      { workspaceId: 'src', entries: [
        { path: 'notes.md', identity: 'note-identity', kind: 'file', markdownContent },
        { path: 'asset.png', identity: 'asset-identity', kind: 'file' },
      ] },
      { workspaceId: 'dest', entries: [] },
    ],
  });
  assert.equal(plan.readiness, 'ready');
  assert.equal(plan.previewContents[0]?.content,
    markdownContent.replace('./asset.png', '../images/asset.png'));
  return plan;
}

function renamePlan() {
  const plan = createWorkspaceFileOperationPlan({
    kind: 'rename', sourceWorkspaceId: 'src', destinationWorkspaceId: 'src',
    selections: [{ sourcePath: 'asset.png', destinationPath: 'other.png' }],
    snapshots: [{ workspaceId: 'src', entries: [
      { path: 'A.md', identity: `1:2:${Buffer.byteLength(original)}:100:101`, kind: 'file', markdownContent: original },
      { path: 'B.md', identity: `1:3:${Buffer.byteLength(original)}:100:101`, kind: 'file', markdownContent: original },
      { path: 'asset.png', identity: 'asset', kind: 'file' },
    ] }],
  });
  assert.equal(plan.readiness, 'ready');
  return plan;
}

function movedNotePlan() {
  const plan = createWorkspaceFileOperationPlan({
    kind: 'rename', sourceWorkspaceId: 'src', destinationWorkspaceId: 'src',
    selections: [{ sourcePath: 'notes.md', destinationPath: 'archive/notes.md' }],
    snapshots: [{ workspaceId: 'src', entries: [
      { path: 'notes.md', identity: `1:5:${Buffer.byteLength(original)}:100:101`, kind: 'file', markdownContent: original },
      { path: 'asset.png', identity: 'asset', kind: 'file' },
    ] }],
  });
  assert.equal(plan.readiness, 'ready');
  assert.equal(plan.previewContents[0].content, '[x](../asset.png)');
  return plan;
}

function harness(plan = copyPlan()) {
  const bytes = new Map<string, Buffer>([
    ['src:notes.md', Buffer.from(original)],
    ['src:A.md', Buffer.from(original)],
    ['src:B.md', Buffer.from(original)],
  ]);
  const documents = new Map<string, string>();
  const activeContents = new Map<string, string>();
  const initializedStates = new Set<string>();
  const resolutionCalls: string[] = [];
  const fileVersions = new Map<string, string>([
    ['src:A.md', `1:2:${Buffer.byteLength(original)}:100:999`],
    ['src:B.md', `1:3:${Buffer.byteLength(original)}:100:999`],
    ['src:archive/notes.md', `1:5:${Buffer.byteLength(original)}:100:999`],
  ]);
  const preflightCalls: ActiveWorkspaceLinkEditsInput[] = [];
  const activeApplyCalls: ActiveWorkspaceLinkEditsInput[] = [];
  const plainWrites: string[] = [];
  let failActivePath: string | null = null;
  let directAvailable = true;
  let liveReaderAvailable = true;
  let onResolve: (() => void) | null = null;
  const workspace = (id: string) => ({ workspaceId: id, workspaceType: 'personal',
    rootPath: `/tmp/workspace-link-write-executor-${id}` }) as WorkspaceContext;
  const source = workspace('src');
  const destination = workspace(plan.pathMappings[0].destinationWorkspaceId);
  const input: WorkspaceLinkWriteExecutorInput = {
    plan, source: { workspace: source, fileOptions: { workspace: source } },
    destination: { workspace: destination, fileOptions: { workspace: destination } },
    actorUserId: 'user-1', actorId: 'agent-1', actorDisplayName: 'Agent',
    actorType: 'agent', operationId: 'copy-operation-1',
  };
  const executor = createWorkspaceLinkWriteExecutor({
    isDirectConnectionAvailable: () => directAvailable,
    isLiveReaderAvailable: () => liveReaderAvailable,
    ensureCollaborationState: (async ({ workspace: scope, path }) => {
      const key = `${scope.workspaceId}:${path}`;
      const id = documents.get(key) ?? `allocated:${key}`;
      documents.set(key, id);
      return { document: { id, status: 'active', provider: 'yjs' } };
    }) as typeof getFileCollaborationState,
    loadPersistedState: (async (documentId) => initializedStates.has(documentId)
      ? { documentId, status: 'active' } : null) as typeof loadCollaborationStateIncludingArchived,
    resolveTextState: (async (resolve) => {
      resolutionCalls.push(resolve.document.id);
      const initialized = !initializedStates.has(resolve.document.id);
      initializedStates.add(resolve.document.id);
      onResolve?.();
      return { initialized, state: {
        documentId: resolve.document.id, workspaceId: resolve.workspace.workspaceId,
        path: resolve.path, representation: 'plain_text', status: 'active', degraded: false,
      } };
    }) as typeof resolveTextCollaborationState,
    getFileStats: (async (path, options) => ({
      fileVersion: fileVersions.get(`${options?.workspace?.workspaceId}:${path}`) ?? '0:0:0:0:0',
      isFile: true,
    })) as typeof getFileStats,
    readFile: (async (path, options) => {
      const key = `${options?.workspace?.workspaceId}:${path}`;
      const content = bytes.get(key);
      if (!content) throw new Error(`Missing test bytes: ${key}`);
      return content;
    }) as typeof readFile,
    readCollaborationState: (async ({ workspace: scope, path }) => {
      const documentId = documents.get(`${scope.workspaceId}:${path}`);
      return { document: documentId ? { id: documentId, status: 'active' } : null };
    }) as typeof readFileCollaborationState,
    preflightActive: async (active) => {
      if (active.workspace.workspaceId === active.edits[0].sourceWorkspaceId
        && active.documentPath === active.edits[0].sourcePathBefore) {
        assert(initializedStates.has(active.documentId), 'Yjs state must exist before the source preflight');
      }
      preflightCalls.push(active);
      const key = `${active.workspace.workspaceId}:${active.documentPath}`;
      return {
        documentId: active.documentId, documentPath: active.documentPath,
        lifecycleGeneration: 1, schemaVersion: 1,
        beforeSha256: active.edits[0].expectedContentHash,
        afterSha256: sha256(active.afterContent), editCount: active.edits.length,
        status: activeContents.get(key) === active.afterContent ? 'already-applied' : 'ready',
      };
    },
    applyActive: async (active) => {
      if (active.documentPath === failActivePath) throw new Error('Injected second write failure');
      activeApplyCalls.push(active);
      const key = `${active.workspace.workspaceId}:${active.documentPath}`;
      const status = activeContents.get(key) === active.afterContent ? 'already-applied' : 'applied';
      activeContents.set(key, active.afterContent);
      bytes.set(key, Buffer.from(active.afterContent));
      return {
        documentId: active.documentId, documentPath: active.documentPath,
        lifecycleGeneration: 1, schemaVersion: 1,
        beforeSha256: active.edits[0].expectedContentHash,
        afterSha256: sha256(active.afterContent), editCount: active.edits.length,
        status,
      };
    },
    applyPlain: async (write) => {
      const key = `${write.workspace.workspaceId}:${write.path}`;
      const current = bytes.get(key);
      if (!current) throw new Error(`Missing test destination: ${key}`);
      const after = Buffer.from(write.afterContent);
      const status = current.equals(after) ? 'already-applied' : 'applied';
      if (status === 'applied' && sha256(current) !== write.edits[0].expectedContentHash) {
        throw new Error('Stale destination content');
      }
      if (status === 'applied') bytes.set(key, after);
      plainWrites.push(key);
      return { path: write.path, beforeSha256: write.edits[0].expectedContentHash,
        afterSha256: sha256(after), status };
    },
  });
  return { bytes, documents, activeContents, initializedStates, resolutionCalls,
    input, executor, preflightCalls, activeApplyCalls, plainWrites,
    fileVersions,
    setDirectAvailable: (available: boolean) => { directAvailable = available; },
    setLiveReaderAvailable: (available: boolean) => { liveReaderAvailable = available; },
    afterResolve: (callback: () => void) => { onResolve = callback; },
    failActiveAt: (path: string) => { failActivePath = path; } };
}

function hasCode(code: WorkspaceLinkWriteExecutorError['code']) {
  return (error: unknown) => error instanceof WorkspaceLinkWriteExecutorError && error.code === code;
}

test('unregistered cross-workspace copy preflights source and initializes active destination; replay needs no source', async () => {
  const h = harness();
  const preflight = await h.executor.preflight(h.input);
  assert.equal(preflight.sources[0].mode, 'plain-file');
  assert.equal(preflight.sources[0].beforeSha256, sha256(original));
  assert.equal(h.plainWrites.length, 0);
  h.bytes.set('dest:archive/notes.md', Buffer.from(original));
  h.bytes.delete('src:notes.md');
  const receipt = await h.executor.apply(h.input, { preflight });
  assert.deepEqual(receipt.map((entry) => entry.status), ['applied']);
  assert.equal(receipt[0].mode, 'active-yjs');
  assert.equal(receipt[0].documentId, 'allocated:dest:archive/notes.md');
  assert.equal(h.bytes.get('dest:archive/notes.md')?.toString(), rewritten);
  assert.equal((await h.executor.apply(h.input))[0].status, 'already-applied');
  assert.equal(h.plainWrites.length, 0);
});

test('active source preflight uses source workspace while active copy destination is applied by new identity', async () => {
  const h = harness();
  h.documents.set('src:notes.md', 'original-doc');
  const preflight = await h.executor.preflight(h.input);
  assert.equal(preflight.sources[0].documentId, 'original-doc');
  assert.equal(h.preflightCalls[0].workspace.workspaceId, 'src');
  assert.equal(h.preflightCalls[0].documentPath, 'notes.md');
  h.documents.set('dest:archive/notes.md', 'copied-doc');
  h.bytes.set('dest:archive/notes.md', Buffer.from(original));
  const receipts = await h.executor.apply(h.input, { preflight });
  assert.equal(receipts[0].mode, 'active-yjs');
  assert.equal(receipts[0].documentId, 'copied-doc');
  assert.equal(h.activeApplyCalls[0].workspace.workspaceId, 'dest');
  assert.equal(h.plainWrites.length, 0);
});

test('stale source bytes or malformed link spans block the entire preflight', async () => {
  const stale = harness();
  stale.bytes.set('src:notes.md', Buffer.from('[x](./other.png)'));
  await assert.rejects(stale.executor.preflight(stale.input), hasCode('LINK_WRITE_STALE'));
  assert.equal(stale.plainWrites.length, 0);

  const malformed = harness();
  const changed = { ...malformed.input.plan, linkEdits: malformed.input.plan.linkEdits.map((edit) => ({
    ...edit, targetRange: { ...edit.targetRange, endUtf8Byte: edit.targetRange.endUtf8Byte - 1 },
  })) };
  await assert.rejects(malformed.executor.preflight({ ...malformed.input, plan: changed }),
    hasCode('LINK_WRITE_INVALID_PLAN'));
  assert.equal(malformed.plainWrites.length, 0);
});

test('a moved active document must retain its identity after the path operation', async () => {
  const h = harness(renamePlan());
  h.documents.set('src:A.md', 'doc-A');
  const preflight = await h.executor.preflight(h.input);
  h.documents.set('src:A.md', 'replacement-doc');
  await assert.rejects(h.executor.apply(h.input, { preflight }), hasCode('LINK_WRITE_PARTIAL'));
  assert.equal(h.activeApplyCalls.length, 0);
});

test('partial failure reports completed receipts for durable recovery', async () => {
  const h = harness(renamePlan());
  const preflight = await h.executor.preflight(h.input);
  h.failActiveAt('B.md');
  await assert.rejects(h.executor.apply(h.input, { preflight }), (error) => {
    assert(error instanceof WorkspaceLinkWriteExecutorError);
    assert.equal(error.code, 'LINK_WRITE_PARTIAL');
    assert.equal(error.completed.length, 1);
    assert.equal(error.completed[0].path, 'A.md');
    return true;
  });
  assert.equal(h.bytes.get('src:A.md')?.toString(), '[x](./other.png)');
  assert.equal(h.bytes.get('src:B.md')?.toString(), original);
});

test('active preflight fails before path mutation when the direct writer is unavailable', async () => {
  const h = harness();
  h.documents.set('src:notes.md', 'active-source');
  h.setDirectAvailable(false);
  await assert.rejects(h.executor.preflight(h.input), hasCode('LINK_WRITE_STALE_DOCUMENT'));
  assert.equal(h.preflightCalls.length, 0);
  assert.equal(h.plainWrites.length, 0);

  h.setDirectAvailable(true);
  h.setLiveReaderAvailable(false);
  await assert.rejects(h.executor.preflight(h.input), hasCode('LINK_WRITE_STALE_DOCUMENT'));
  assert.equal(h.preflightCalls.length, 0);
});

test('unregistered copy source also requires the Yjs bridge before path mutation', async () => {
  const h = harness();
  h.setDirectAvailable(false);
  await assert.rejects(h.executor.preflight(h.input), hasCode('LINK_WRITE_STALE_DOCUMENT'));
  assert.equal(h.documents.size, 0);
  assert.equal(h.resolutionCalls.length, 0);
});

test('unregistered Markdown sources gain a durable Yjs identity before a rename', async () => {
  const h = harness(renamePlan());
  const preflight = await h.executor.preflight(h.input);
  assert.deepEqual(preflight.sources.map((source) => source.mode), ['active-yjs', 'active-yjs']);
  assert.deepEqual(preflight.sources.map((source) => source.documentId),
    ['allocated:src:A.md', 'allocated:src:B.md']);
  assert.deepEqual(h.resolutionCalls, ['allocated:src:A.md', 'allocated:src:B.md']);
  const [group] = groupWorkspaceLinkWrites(h.input.plan);
  assert.equal(await h.executor.probeGroup(h.input, group, { preflight }), 'before');
  const receipt = await h.executor.applyGroup(h.input, group, { preflight });
  assert.equal(receipt.mode, 'active-yjs');
  assert.equal(h.plainWrites.length, 0);
  assert.equal(await h.executor.probeGroup(h.input, group, { preflight }), 'after');
});

test('previously unregistered moved Markdown keeps its preflight document identity', async () => {
  const h = harness(movedNotePlan());
  const preflight = await h.executor.preflight(h.input);
  assert.equal(preflight.sources[0].documentId, 'allocated:src:notes.md');
  h.bytes.set('src:archive/notes.md', h.bytes.get('src:notes.md')!);
  h.bytes.delete('src:notes.md');
  h.documents.set('src:archive/notes.md', h.documents.get('src:notes.md')!);
  h.documents.delete('src:notes.md');
  const [group] = groupWorkspaceLinkWrites(h.input.plan);
  assert.equal(await h.executor.probeGroup(h.input, group, { preflight }), 'before');
  const receipt = await h.executor.applyGroup(h.input, group, { preflight });
  assert.equal(receipt.mode, 'active-yjs');
  assert.equal(receipt.documentId, preflight.sources[0].documentId);
  assert.equal(h.plainWrites.length, 0);
});

test('a newly written Markdown file initializes plain Yjs state only during apply preflight', async () => {
  const h = harness();
  h.documents.set('src:notes.md', 'allocated-but-unopened-document');
  assert.equal(h.initializedStates.has('allocated-but-unopened-document'), false);
  const preflight = await h.executor.preflight(h.input);
  assert.equal(preflight.sources[0].documentId, 'allocated-but-unopened-document');
  assert.deepEqual(h.resolutionCalls, ['allocated-but-unopened-document']);
  assert.equal(h.initializedStates.has('allocated-but-unopened-document'), true);
  assert.equal(h.bytes.get('src:notes.md')?.toString(), original);
  assert.equal(h.plainWrites.length, 0);
});

test('initialization rechecks source bytes and document identity before path mutation', async () => {
  const changedBytes = harness();
  changedBytes.documents.set('src:notes.md', 'new-document');
  changedBytes.afterResolve(() => changedBytes.bytes.set('src:notes.md', Buffer.from('[x](./other.png)')));
  await assert.rejects(changedBytes.executor.preflight(changedBytes.input), hasCode('LINK_WRITE_STALE'));
  assert.equal(changedBytes.preflightCalls.length, 0);

  const changedDocument = harness();
  changedDocument.documents.set('src:notes.md', 'new-document');
  changedDocument.afterResolve(() => changedDocument.documents.set('src:notes.md', 'replacement-document'));
  await assert.rejects(changedDocument.executor.preflight(changedDocument.input), hasCode('LINK_WRITE_STALE_DOCUMENT'));
  assert.equal(changedDocument.preflightCalls.length, 0);
});

test('unsupported newline encoding is rejected before initializing a new Yjs state', async () => {
  const content = `${original}\r\n`;
  const h = harness(copyPlan(content));
  h.bytes.set('src:notes.md', Buffer.from(content));
  h.documents.set('src:notes.md', 'unopened-crlf-document');
  await assert.rejects(h.executor.preflight(h.input), hasCode('LINK_WRITE_UNSUPPORTED'));
  assert.equal(h.resolutionCalls.length, 0);
  assert.equal(h.initializedStates.has('unopened-crlf-document'), false);
});

test('recovery without preflight verifies moved active file identity and planned hash', async () => {
  const h = harness(movedNotePlan());
  h.bytes.set('src:archive/notes.md', Buffer.from(original));
  h.bytes.delete('src:notes.md');
  h.documents.set('src:archive/notes.md', 'moved-document');
  const receipts = await h.executor.apply(h.input);
  assert.equal(receipts[0].mode, 'active-yjs');
  assert.equal(h.activeApplyCalls[0].documentId, 'moved-document');

  const wrongIdentity = harness(movedNotePlan());
  wrongIdentity.bytes.set('src:archive/notes.md', Buffer.from(original));
  wrongIdentity.documents.set('src:archive/notes.md', 'unrelated-document');
  wrongIdentity.fileVersions.set('src:archive/notes.md', `1:999:${Buffer.byteLength(original)}:100:999`);
  await assert.rejects(wrongIdentity.executor.apply(wrongIdentity.input), hasCode('LINK_WRITE_PARTIAL'));
  assert.equal(wrongIdentity.activeApplyCalls.length, 0);

  const wrongHash = harness(movedNotePlan());
  wrongHash.bytes.set('src:archive/notes.md', Buffer.from('[x](./other.png)'));
  wrongHash.documents.set('src:archive/notes.md', 'moved-document');
  await assert.rejects(wrongHash.executor.apply(wrongHash.input), hasCode('LINK_WRITE_PARTIAL'));
  assert.equal(wrongHash.activeApplyCalls.length, 0);
});

test('one planned group can be probed and applied idempotently as a journal step', async () => {
  const h = harness();
  const [group] = groupWorkspaceLinkWrites(h.input.plan);
  h.bytes.set('dest:archive/notes.md', Buffer.from(original));
  assert.equal(await h.executor.probeGroup(h.input, group), 'before');
  const first = await h.executor.applyGroup(h.input, group);
  assert.equal(first.status, 'applied');
  assert.equal(await h.executor.probeGroup(h.input, group), 'after');
  assert.equal((await h.executor.applyGroup(h.input, group)).status, 'already-applied');
  assert.equal(h.plainWrites.length, 0);
  assert.equal(h.activeApplyCalls.length, 2);

  const forged = { ...group, afterContent: 'wrong' };
  assert.equal(await h.executor.probeGroup(h.input, forged), 'unknown');
  await assert.rejects(h.executor.applyGroup(h.input, forged), hasCode('LINK_WRITE_INVALID_PLAN'));
});

test('active copy probe reads destination state; unavailable bridge and invalid moved identity stay unknown', async () => {
  const h = harness();
  const [group] = groupWorkspaceLinkWrites(h.input.plan);
  h.bytes.set('dest:archive/notes.md', Buffer.from(original));
  h.documents.set('dest:archive/notes.md', 'copy-document');
  assert.equal(await h.executor.probeGroup(h.input, group), 'before');
  await h.executor.applyGroup(h.input, group);
  assert(h.resolutionCalls.includes('copy-document'));
  assert.equal(await h.executor.probeGroup(h.input, group), 'after');
  h.setDirectAvailable(false);
  assert.equal(await h.executor.probeGroup(h.input, group), 'unknown');
  h.setDirectAvailable(true);
  h.setLiveReaderAvailable(false);
  assert.equal(await h.executor.probeGroup(h.input, group), 'unknown');

  const moved = harness(movedNotePlan());
  const [movedGroup] = groupWorkspaceLinkWrites(moved.input.plan);
  moved.bytes.set('src:archive/notes.md', Buffer.from(original));
  moved.documents.set('src:archive/notes.md', 'unrelated-document');
  moved.fileVersions.set('src:archive/notes.md', `1:999:${Buffer.byteLength(original)}:100:999`);
  assert.equal(await moved.executor.probeGroup(moved.input, movedGroup), 'unknown');
});

test('persisted document-id fence proves an applied Yjs write after checkpoint replaces the inode', async () => {
  const h = harness(movedNotePlan());
  h.documents.set('src:notes.md', 'moved-document');
  const preflight: WorkspaceLinkWritePreflight = JSON.parse(JSON.stringify(await h.executor.preflight(h.input)));
  const [group] = groupWorkspaceLinkWrites(h.input.plan);
  h.documents.delete('src:notes.md');
  h.documents.set('src:archive/notes.md', 'moved-document');
  h.bytes.delete('src:notes.md');
  h.bytes.set('src:archive/notes.md', Buffer.from(group.afterContent));
  h.activeContents.set('src:archive/notes.md', group.afterContent);
  h.fileVersions.set('src:archive/notes.md', `1:999:${Buffer.byteLength(group.afterContent)}:200:201`);
  assert.equal(await h.executor.probeGroup(h.input, group, { preflight }), 'after');

  h.documents.set('src:archive/notes.md', 'foreign-document');
  assert.equal(await h.executor.probeGroup(h.input, group, { preflight }), 'unknown');
  await assert.rejects(h.executor.applyGroup(h.input, group, { preflight }), hasCode('LINK_WRITE_STALE_DOCUMENT'));

  // Without the persisted document-id fence, the replacement inode cannot
  // establish the old source identity, even though the projected bytes match.
  h.documents.set('src:archive/notes.md', 'moved-document');
  assert.equal(await h.executor.probeGroup(h.input, group), 'unknown');
});
