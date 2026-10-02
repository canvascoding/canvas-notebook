import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as Y from 'yjs';

import {
  installCollaborationDocumentReader,
  isLiveCollaborationDocumentReaderAvailable,
} from '../app/lib/collaboration/document-access';
import {
  installCollaborationDirectConnection,
  isCollaborationDirectConnectionAvailable,
  type AgentDirectConnectionInput,
} from '../app/lib/collaboration/direct-connection';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceFileLinkEditV1 } from '../app/lib/markdown/workspace-link-contract-v1';
import {
  createActiveWorkspaceLinkEditService,
  WorkspaceLinkYjsEditError,
  type ActiveWorkspaceLinkEditsInput,
} from '../app/lib/markdown/workspace-link-yjs-edits';
import { Y as ServerY } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc, createRichMarkdownYDoc, replaceRichMarkdownInYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson, richDocumentFormat } from '../app/lib/collaboration/rich-document';

const source = 'A [x](./😀.md) B';
const target = './😀.md';
const replacement = './neu.md';
const start = source.indexOf(target);
const end = start + target.length;
const afterContent = `${source.slice(0, start)}${replacement}${source.slice(end)}`;

test('delete cleanup may empty a Yjs document and exact Undo may restore it', async () => {
  const h = fixture();
  try {
    const cleanup = { ...h.input, afterContent: '', edits: [{ ...h.input.edits[0],
      expectedContentHash: sha256(source), previousTargetLiteral: source, nextTargetLiteral: '',
      targetRange: { startUtf16: 0, endUtf16: source.length,
        startUtf8Byte: 0, endUtf8Byte: Buffer.byteLength(source, 'utf8') } }] };
    await h.service.preflight(cleanup);
    await h.service.apply(cleanup);
    assert.equal(h.doc.getText('content').toString(), '');
    const restore = { ...h.input, afterContent: source, edits: [{ ...h.input.edits[0],
      expectedContentHash: sha256(''), previousTargetLiteral: '', nextTargetLiteral: source,
      targetRange: { startUtf16: 0, endUtf16: 0, startUtf8Byte: 0, endUtf8Byte: 0 } }] };
    await h.service.preflight(restore);
    await h.service.apply(restore);
    assert.equal(h.doc.getText('content').toString(), source);
    assert.equal((await h.service.apply(restore)).status, 'already-applied');
    h.doc.getText('content').insert(0, 'User change ');
    await assert.rejects(h.service.apply(restore), hasCode('LINK_WRITE_STALE'));
    assert.equal(h.doc.getText('content').toString(), `User change ${source}`);
  } finally { h.doc.destroy(); }
});

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function fixture(overrides: {
  content?: string;
  representation?: PersistedCollaborationState['representation'];
  newlineStyle?: PersistedCollaborationState['newlineStyle'];
  hasBom?: boolean;
  documentPath?: string;
  sourceWorkspaceId?: string;
} = {}, providedDoc?: Y.Doc, seedText = true) {
  const doc = providedDoc ?? new Y.Doc();
  if (seedText) doc.getText('content').insert(0, overrides.content ?? source);
  const state = {
    documentId: 'document-1', workspaceId: 'workspace-1', path: overrides.documentPath ?? 'notes.md',
    representation: overrides.representation ?? 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    newlineStyle: overrides.newlineStyle ?? 'lf', hasBom: overrides.hasBom ?? false,
    degraded: false, status: 'active' as const,
  };
  const workspace = { workspaceId: 'workspace-1', workspaceType: 'personal',
    rootPath: '/tmp/workspace-link-yjs-edits-test' } as WorkspaceContext;
  const edit: WorkspaceFileLinkEditV1 = {
    sourceWorkspaceId: overrides.sourceWorkspaceId ?? workspace.workspaceId,
    destinationWorkspaceId: workspace.workspaceId,
    sourcePathBefore: overrides.sourceWorkspaceId ? 'source/notes.md' : 'notes.md',
    sourcePathAfter: state.path,
    expectedContentHash: sha256(source),
    targetRange: {
      startUtf16: start, endUtf16: end,
      startUtf8Byte: Buffer.byteLength(source.slice(0, start), 'utf8'),
      endUtf8Byte: Buffer.byteLength(source.slice(0, end), 'utf8'),
    },
    previousTargetLiteral: target, nextTargetLiteral: replacement,
  };
  const input: ActiveWorkspaceLinkEditsInput = {
    workspace, documentId: state.documentId, documentPath: state.path,
    edits: [edit], afterContent,
    actorId: 'user-1', actorDisplayName: 'Test User', initiatedByUserId: 'user-1',
    operationId: 'workspace-link-test', actorType: 'user',
  };
  let directCalls = 0;
  const service = createActiveWorkspaceLinkEditService({
    loadState: async () => state,
    readCurrent: async (options) => options.read(doc),
    directConnection: async <T>(connection: AgentDirectConnectionInput, apply: (live: Y.Doc) => T): Promise<T> => {
      directCalls += 1;
      assert.equal(connection.documentId, state.documentId);
      assert.equal(connection.documentPath, state.path);
      assert.equal(connection.documentRepresentation, state.representation);
      return apply(doc);
    },
  });
  return { doc, state, input, service, directCalls: () => directCalls };
}

function hasCode(code: WorkspaceLinkYjsEditError['code']) {
  return (error: unknown) => error instanceof WorkspaceLinkYjsEditError && error.code === code;
}

test('preflight is read-only, apply changes only the target and retry returns an idempotent receipt', async () => {
  const h = fixture();
  try {
    const preflight = await h.service.preflight(h.input);
    assert.equal(preflight.status, 'ready');
    assert.equal(h.doc.getText('content').toString(), source);
    assert.equal(h.directCalls(), 0);
    const applied = await h.service.apply(h.input);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.beforeSha256, sha256(source));
    assert.equal(applied.afterSha256, sha256(afterContent));
    assert.equal(h.doc.getText('content').toString(), afterContent);
    assert.equal((await h.service.apply(h.input)).status, 'already-applied');
    assert.equal(h.doc.getText('content').toString(), afterContent);
  } finally { h.doc.destroy(); }
});

test('concurrent live content change after preflight is rejected without overwriting the user edit', async () => {
  const h = fixture();
  try {
    await h.service.preflight(h.input);
    h.doc.getText('content').insert(0, 'User ');
    await assert.rejects(h.service.apply(h.input), hasCode('LINK_WRITE_STALE'));
    assert.equal(h.doc.getText('content').toString(), `User ${source}`);
  } finally { h.doc.destroy(); }
});

test('wrong literal, UTF-8 byte offset, and mismatched result are rejected before mutation', async (t) => {
  const variants: Array<[string, (input: ActiveWorkspaceLinkEditsInput) => ActiveWorkspaceLinkEditsInput,
    WorkspaceLinkYjsEditError['code']]> = [
    ['literal', (input) => ({ ...input, edits: [{ ...input.edits[0], previousTargetLiteral: './wrong.md' }] }), 'LINK_WRITE_STALE'],
    ['byte offset', (input) => ({ ...input, edits: [{ ...input.edits[0], targetRange: {
      ...input.edits[0].targetRange, endUtf8Byte: input.edits[0].targetRange.endUtf8Byte - 1,
    } }] }), 'LINK_WRITE_STALE'],
    ['result', (input) => ({ ...input, afterContent: 'unrelated result' }), 'LINK_WRITE_INVALID_PLAN'],
  ];
  for (const [name, change, code] of variants) await t.test(name, async () => {
    const h = fixture();
    try {
      await assert.rejects(h.service.apply(change(h.input)), hasCode(code));
      assert.equal(h.doc.getText('content').toString(), source);
    } finally { h.doc.destroy(); }
  });
});

test('invalid rich roots, CRLF profile, BOM, and formatted Y.Text fail closed', async (t) => {
  for (const [name, options] of [
    ['invalid rich root', { representation: 'tiptap_blocks' as const }],
    ['CRLF', { newlineStyle: 'crlf' as const }],
    ['BOM', { hasBom: true }],
  ] as const) await t.test(name, async () => {
    const h = fixture(options);
    try {
      await assert.rejects(h.service.preflight(h.input), hasCode('LINK_WRITE_UNSUPPORTED'));
      assert.equal(h.directCalls(), 0);
    } finally { h.doc.destroy(); }
  });
  const h = fixture();
  try {
    h.doc.getText('content').format(start, target.length, { bold: true });
    await assert.rejects(h.service.apply(h.input), hasCode('LINK_WRITE_UNSUPPORTED'));
    assert.equal(h.doc.getText('content').toString(), source);
  } finally { h.doc.destroy(); }
});

test('path identity mismatch fails before opening the write connection', async () => {
  const h = fixture();
  try {
    h.state.path = 'moved.md';
    await assert.rejects(h.service.apply(h.input), hasCode('LINK_WRITE_STALE_DOCUMENT'));
    assert.equal(h.directCalls(), 0);
  } finally { h.doc.destroy(); }
});

test('a copied Markdown document may have a different source workspace', async () => {
  const h = fixture({ sourceWorkspaceId: 'source-workspace' });
  try {
    h.state.workspaceId = 'source-workspace';
    h.state.path = 'source/notes.md';
    const sourceInput = { ...h.input,
      workspace: { ...h.input.workspace, workspaceId: 'source-workspace' },
      documentPath: 'source/notes.md',
    };
    assert.equal((await h.service.preflight(sourceInput)).status, 'ready');
    await assert.rejects(h.service.apply(sourceInput), hasCode('LINK_WRITE_INVALID_PLAN'));
    h.state.workspaceId = 'workspace-1';
    h.state.path = 'notes.md';
    assert.equal((await h.service.apply(h.input)).status, 'applied');
    assert.equal(h.doc.getText('content').toString(), afterContent);
  } finally { h.doc.destroy(); }
});

test('direct-connection availability is a read-only bridge check', () => {
  assert.equal(isCollaborationDirectConnectionAvailable(), false);
  const uninstall = installCollaborationDirectConnection(async (_input, apply) => apply(new Y.Doc()));
  try {
    assert.equal(isCollaborationDirectConnectionAvailable(), true);
  } finally { uninstall(); }
  assert.equal(isCollaborationDirectConnectionAvailable(), false);
});

test('live-room reader availability excludes the persisted fallback', () => {
  assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
  const uninstall = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(new Y.Doc()));
  try {
    assert.equal(isLiveCollaborationDocumentReaderAvailable(), true);
  } finally { uninstall(); }
  assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
});

test('a real ESM Y.Text remains editable through the CJS server adapter', async () => {
  const esmYjs: typeof import('yjs') = await import(new URL('../node_modules/yjs/dist/yjs.mjs', import.meta.url).href);
  const doc = new esmYjs.Doc();
  const h = fixture({}, doc as Y.Doc);
  try {
    assert.equal(doc.share.get('content') instanceof ServerY.Text, false,
      'The regression needs distinct Yjs module constructors.');
    assert.equal((await h.service.preflight(h.input)).status, 'ready');
    assert.equal((await h.service.apply(h.input)).status, 'applied');
    assert.equal(doc.getText('content').toString(), afterContent);
  } finally { doc.destroy(); }
});

test('a non-text top-level content type is rejected without creating Y.Text', async () => {
  const doc = new Y.Doc();
  doc.getArray('content').insert(0, ['not text']);
  const h = fixture({}, doc, false);
  try {
    const originalType = doc.share.get('content');
    await assert.rejects(h.service.preflight(h.input), hasCode('LINK_WRITE_UNSUPPORTED'));
    assert.strictEqual(doc.share.get('content'), originalType);
    assert.equal(doc.getArray('content').toArray()[0], 'not text');
  } finally { doc.destroy(); }
});

test('a persisted plain Yjs update materializes AbstractType without changing its state vector', async () => {
  const initial = createPlainTextYDoc(source);
  const hydrated = new ServerY.Doc();
  try {
    ServerY.applyUpdate(hydrated, ServerY.encodeStateAsUpdate(initial));
    assert.equal(hydrated.share.get('content')?.constructor.name, 'AbstractType');
    const vectorBefore = Buffer.from(ServerY.encodeStateVector(hydrated));
    const h = fixture({}, hydrated as Y.Doc, false);
    assert.equal((await h.service.preflight(h.input)).status, 'ready');
    assert.equal(hydrated.share.get('content')?.constructor.name, 'YText');
    assert.deepEqual(Buffer.from(ServerY.encodeStateVector(hydrated)), vectorBefore);
    assert.equal((await h.service.apply(h.input)).status, 'applied');
    assert.equal(hydrated.getText('content').toString(), afterContent);
  } finally { hydrated.destroy(); initial.destroy(); }
});

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation} exact Wiki repair preserves rich identities, metadata and idempotent Undo`, async () => {
    const markdown = '---\ntitle: Note\n---\n# Keep\n\n[[A/Plan|Plan]]\n\n**Bold** and [External](https://example.com).\n';
    const doc = createRichMarkdownYDoc(markdown, representation);
    const h = fixture({ representation }, doc, false);
    try {
      const before = richMarkdownFromYDoc(doc);
      const previous = 'A/Plan';
      const next = 'final/Other';
      const offset = before.indexOf(previous);
      const after = before.slice(0, offset) + next + before.slice(offset + previous.length);
      const input = { ...h.input, afterContent: after, edits: [{ ...h.input.edits[0],
        expectedContentHash: sha256(before), previousTargetLiteral: previous, nextTargetLiteral: next,
        targetRange: { startUtf16: offset, endUtf16: offset + previous.length,
          startUtf8Byte: Buffer.byteLength(before.slice(0, offset)), endUtf8Byte: Buffer.byteLength(before.slice(0, offset + previous.length)) } }] };
      doc.getMap('comments').set('retained-comment', { body: 'Keep comment metadata' });
      const beforeJson = readRichDocumentJson(doc);
      const vectorBefore = Buffer.from(Y.encodeStateVector(doc));
      const invalid = { ...input, afterContent: before.slice(0, offset) + 'new]] invalid' + before.slice(offset + previous.length),
        edits: [{ ...input.edits[0], nextTargetLiteral: 'new]] invalid' }] };
      await assert.rejects(h.service.preflight(invalid), hasCode('LINK_WRITE_UNSUPPORTED'));
      await assert.rejects(h.service.apply(invalid), hasCode('LINK_WRITE_UNSUPPORTED'));
      assert.deepEqual(Buffer.from(Y.encodeStateVector(doc)), vectorBefore, 'a non-round-tripping rich result never mutates the room');
      assert.equal((await h.service.preflight(input)).status, 'ready');
      assert.deepEqual(Buffer.from(Y.encodeStateVector(doc)), vectorBefore, 'rich preflight never mutates the room');
      assert.equal(richMarkdownFromYDoc(doc), before);
      assert.equal((await h.service.apply(input)).status, 'applied');
      assert.equal(richMarkdownFromYDoc(doc), after);
      assert.equal(richDocumentFormat(doc), representation);
      assert.deepEqual(doc.getMap('comments').get('retained-comment'), { body: 'Keep comment metadata' });
      assert.deepEqual(readRichDocumentJson(doc).content?.map((node) => node.attrs?.id), beforeJson.content?.map((node) => node.attrs?.id),
        'existing rich block identities survive a link target rewrite');
      const appliedVector = Buffer.from(Y.encodeStateVector(doc));
      assert.equal((await h.service.apply(input)).status, 'already-applied');
      assert.deepEqual(Buffer.from(Y.encodeStateVector(doc)), appliedVector);
      const undo = { ...input, afterContent: before, edits: [{ ...input.edits[0], expectedContentHash: sha256(after),
        previousTargetLiteral: next, nextTargetLiteral: previous,
        targetRange: { startUtf16: offset, endUtf16: offset + next.length,
          startUtf8Byte: Buffer.byteLength(after.slice(0, offset)), endUtf8Byte: Buffer.byteLength(after.slice(0, offset + next.length)) } }] };
      assert.equal((await h.service.preflight(undo)).status, 'ready');
      await h.service.apply(undo);
      assert.equal(richMarkdownFromYDoc(doc), before);
      const wrapper = '[[A/Plan|Plan]]';
      const wrapperOffset = before.indexOf(wrapper);
      const cleaned = before.slice(0, wrapperOffset) + 'Plan' + before.slice(wrapperOffset + wrapper.length);
      const cleanup = { ...input, afterContent: cleaned, edits: [{ ...input.edits[0],
        previousTargetLiteral: wrapper, nextTargetLiteral: 'Plan',
        targetRange: { startUtf16: wrapperOffset, endUtf16: wrapperOffset + wrapper.length,
          startUtf8Byte: Buffer.byteLength(before.slice(0, wrapperOffset)), endUtf8Byte: Buffer.byteLength(before.slice(0, wrapperOffset + wrapper.length)) } }] };
      await h.service.preflight(cleanup);
      await h.service.apply(cleanup);
      assert.equal(richMarkdownFromYDoc(doc), cleaned, 'delete cleanup removes the wrapper and retains its visible label');
      const restore = { ...cleanup, afterContent: before, edits: [{ ...cleanup.edits[0], expectedContentHash: sha256(cleaned),
        previousTargetLiteral: 'Plan', nextTargetLiteral: wrapper,
        targetRange: { startUtf16: wrapperOffset, endUtf16: wrapperOffset + 4,
          startUtf8Byte: Buffer.byteLength(cleaned.slice(0, wrapperOffset)), endUtf8Byte: Buffer.byteLength(cleaned.slice(0, wrapperOffset + 4)) } }] };
      await h.service.preflight(restore);
      await h.service.apply(restore);
      assert.equal(richMarkdownFromYDoc(doc), before);
      await h.service.preflight(input);
      replaceRichMarkdownInYDoc(doc, before.replace('**Bold**', '**User edit**'));
      const concurrent = richMarkdownFromYDoc(doc);
      await assert.rejects(h.service.apply(input), hasCode('LINK_WRITE_STALE'));
      assert.equal(richMarkdownFromYDoc(doc), concurrent, 'a concurrent rich edit is never overwritten');
    } finally { doc.destroy(); }
  });
}
