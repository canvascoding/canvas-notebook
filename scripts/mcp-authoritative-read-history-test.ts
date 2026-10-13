import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = {
  workspaceId: 'mcp-read-workspace', workspaceType: 'personal', organizationId: null,
  rootPath: '/no-mcp-history-test-files', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
    canManageWorkspace: true, canRunAgent: true },
};
type ReaderInput = { workspace: WorkspaceContext; path: string; buffer: Buffer;
  principal: { userId: string; sessionId: string } };
type Reader = (input: ReaderInput) => Promise<{ content: string; sha256: string; source: 'file' | 'live_yjs'; documentId?: string }>;
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

function stateFor(doc: Y.Doc, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return { documentId: 'mcp-read-document', workspaceId: workspace.workspaceId, organizationId: null,
    path: 'note.md', representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 4,
    persistedAt: 100, checkpointedAt: null, checkpointSequence: 0, canonicalHash: null,
    serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}

/** Execute the real private adapter with controlled persistence boundaries. */
async function readerFor(options: { doc?: Y.Doc; representation?: PersistedCollaborationState['representation']; capable?: boolean }) {
  const file = path.resolve('app/lib/mcp/server/workspace-tools.ts');
  const source = await readFile(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'readDirectMcpTextContent');
  assert(declaration);
  let revisions = 0, initializations = 0, reads = 0;
  let doc = options.doc;
  const dependencies = {
    sha256Buffer: hash,
    getFileCollaborationState: async () => ({ crdtCapable: options.capable !== false,
      document: { id: 'mcp-read-document' } }),
    ensureFileRevisionForCurrentContent: async () => { revisions++; throw new Error('A read attempted to capture physical history.'); },
    selectInitialTextCollaborationRepresentation: () => options.representation ?? 'plain_text',
    resolveTextCollaborationState: async (input: { initialContent: string }) => {
      if (!doc) { doc = createPlainTextYDoc(input.initialContent); initializations++; }
    },
    readCurrentCollaborationTextSnapshot: async () => {
      reads++; assert(doc);
      const snapshot = authoritativeCollaborationSnapshot(stateFor(doc, options.representation ?? 'plain_text'));
      return { content: snapshot.canonicalContent, sha256: hash(Buffer.from(snapshot.canonicalContent)), documentId: 'mcp-read-document' };
    },
  };
  const compiled = ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const read = new Function(...Object.keys(dependencies), `${compiled}\nreturn readDirectMcpTextContent;`)(...Object.values(dependencies)) as Reader;
  return { read: (buffer: Buffer) => read({ workspace, path: 'note.md', buffer,
    principal: { userId: 'reader', sessionId: 'read-session' } }),
  counters: () => ({ revisions, initializations, reads }),
  dispose: () => { if (!options.doc) doc?.destroy(); } };
}

test('MCP reads current native content without capturing stale or empty physical revisions', async () => {
  const doc = createPlainTextYDoc('Current native text\n😀');
  try {
    const before = Y.encodeStateAsUpdate(doc);
    for (const projection of [Buffer.alloc(0), Buffer.from('Old physical text')]) {
      const reader = await readerFor({ doc });
      const result = await reader.read(projection);
      assert.equal(result.content, 'Current native text\n😀');
      assert.equal(result.source, 'live_yjs');
      assert.equal(result.sha256, hash(Buffer.from(result.content)));
      assert.deepEqual(reader.counters(), { revisions: 0, initializations: 0, reads: 1 });
    }
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { doc.destroy(); }
});

test('first collaboration initialization does not turn a read into a file-history write', async () => {
  const reader = await readerFor({});
  try {
    const input = Buffer.from('Initial text\n');
    assert.equal((await reader.read(input)).content, input.toString('utf8'));
    assert.deepEqual(reader.counters(), { revisions: 0, initializations: 1, reads: 1 });
  } finally { reader.dispose(); }
});

test('an unavailable strict native export never falls back to the old file or captures it', async () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| Target |', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) {
      if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
        (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
      }
    }
    tree.read().check();
    const reader = await readerFor({ doc, representation: 'tiptap_blocks' });
    await assert.rejects(reader.read(Buffer.from('Old projection')), /roundtrip_unstable/u);
    assert.deepEqual(reader.counters(), { revisions: 0, initializations: 0, reads: 1 });
  } finally { doc.destroy(); }
});

test('ordinary text files keep their physical read contract without creating collaboration or history', async () => {
  const reader = await readerFor({ capable: false });
  const input = Buffer.from('Ordinary file\n');
  assert.deepEqual(await reader.read(input), { content: input.toString('utf8'), sha256: hash(input), source: 'file' });
  assert.deepEqual(reader.counters(), { revisions: 0, initializations: 0, reads: 0 });
});
