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
import { directMcpFileLinkFields } from '../app/lib/mcp/server/file-links';
import { decodeDirectMcpDocumentReadSelection } from '../app/lib/mcp/server/document-read-tool-contract';
import type { WorkspaceSearchText } from '../app/lib/collaboration/workspace-search-reader';

const workspace: WorkspaceContext = {
  workspaceId: 'mcp-read-workspace', workspaceType: 'personal', organizationId: null,
  rootPath: '/no-mcp-history-test-files', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
    canManageWorkspace: true, canRunAgent: true },
};
type ReaderInput = { workspace: WorkspaceContext; path: string; buffer: Buffer;
  principal: { userId: string; sessionId: string } };
type ReaderOutput = { content: string; sha256: string; source: 'file' | 'live_yjs'; documentId?: string;
  nativeIdentity: WorkspaceSearchText['nativeIdentity'] };
type Reader = (input: ReaderInput) => Promise<ReaderOutput>;
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

function stateFor(doc: Y.Doc, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return { documentId: 'mcp-read-document', workspaceId: workspace.workspaceId, organizationId: null,
    path: 'note.md', representation, lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 4,
    persistedAt: 100, checkpointedAt: null, checkpointSequence: 0, canonicalHash: null,
    serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}

/** Execute the real private adapter with controlled persistence boundaries. */
async function readerFor(options: { doc?: Y.Doc; representation?: PersistedCollaborationState['representation']; capable?: boolean;
  afterSnapshot?: (identity: Readonly<{ documentId: string; path: string; lifecycleGeneration: number }>) => void }) {
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
      const state = stateFor(doc, options.representation ?? 'plain_text');
      const snapshot = authoritativeCollaborationSnapshot(state);
      options.afterSnapshot?.(Object.freeze({ documentId: state.documentId, path: state.path,
        lifecycleGeneration: state.lifecycleGeneration }));
      return { ...snapshot, content: snapshot.canonicalContent, sha256: hash(Buffer.from(snapshot.canonicalContent)),
        documentId: state.documentId, path: state.path, lifecycleGeneration: state.lifecycleGeneration,
        schemaVersion: state.schemaVersion, representation: state.representation };
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

type LegacyReadResult = { isError?: boolean; structuredContent?: {
  path: string; content: string; source: string;
} & ReturnType<typeof directMcpFileLinkFields> };

/** Actual legacy dispatcher + actual text adapter and URL builder. The controlled
 * auth/physical boundaries do not establish SQL authority or transport E2E. */
async function legacyDispatchFor(readNative: (buffer: Buffer) => Promise<ReaderOutput>, projection: Buffer) {
  const file = path.resolve('app/lib/mcp/server/workspace-tools.ts');
  const source = await readFile(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = ['executeReadKnowledgeSource', 'isLikelyBinary', 'toIsoDate', 'result', 'errorResult'];
  const declarations = names.map(name => {
    const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert(declaration, `Missing actual MCP function ${name}`);
    return declaration.getText(parsed);
  });
  const dependencies = {
    path, decodeDirectMcpDocumentReadSelection, directMcpFileLinkFields,
    BINARY_FILE_EXTENSIONS: new Set(['.pdf', '.png']), MAX_WORKSPACE_ID_LENGTH: 200, MAX_PATH_LENGTH: 1024,
    MAX_READ_FILE_BYTES: 512 * 1024, DEFAULT_READ_CHARACTERS: 12000, MAX_READ_CHARACTERS: 64000,
    parseArgs: (args: unknown) => args,
    requiredString: (args: Record<string, unknown>, key: string) => String(args[key]),
    optionalInteger: (args: Record<string, unknown>, key: string, fallback: number) => args[key] ?? fallback,
    invalidParams: (message: string) => { throw new Error(message); },
    assertVisibleWorkspacePath: () => {},
    authenticateForTool: async (_auth: unknown, scope: string) => {
      assert.equal(scope, 'knowledge:read');
      return { principal: { userId: 'reader', sessionId: 'read-session' } };
    },
    readableWorkspace: async () => workspace,
    getFileStats: async () => ({ isFile: true, size: projection.length, modified: 100 }),
    readFile: async () => projection,
    readDirectMcpTextContent: async (input: ReaderInput) => readNative(input.buffer),
    readDirectMcpFileLinks: async () => assert.fail('A late path lookup must not attach replacement D2 to the D1 snapshot.'),
    auditWorkspaceToolCall: async () => {},
  };
  const compiled = ts.transpileModule(declarations.join('\n'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const execute = new Function(...Object.keys(dependencies), `${compiled}\nreturn executeReadKnowledgeSource;`)(...Object.values(dependencies)) as
    (args: { workspace_id: string; path: string }) => Promise<LegacyReadResult>;
  return () => execute({ workspace_id: workspace.workspaceId, path: 'note.md' });
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
      assert.deepEqual(result.nativeIdentity, { documentId: 'mcp-read-document', lineageId: null, path: 'note.md' });
      assert.equal(Object.isFrozen(result.nativeIdentity), true);
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
  assert.deepEqual(await reader.read(input), { content: input.toString('utf8'), sha256: hash(input), source: 'file', nativeIdentity: null });
  assert.deepEqual(reader.counters(), { revisions: 0, initializations: 0, reads: 0 });
});

test('legacy MCP read keeps the actual D1 snapshot link when D2 replaces the path before projection', async () => {
  const doc = createPlainTextYDoc('Original D1 native text');
  const d1 = Object.freeze({ documentId: 'mcp-read-document', lineageId: 'unproven-L1', path: 'note.md' });
  const d2 = Object.freeze({ documentId: 'replacement-D2', lineageId: 'replacement-L2', path: 'note.md' });
  const currentPaths = new Map<string, NonNullable<WorkspaceSearchText['nativeIdentity']>>([['note.md', d1]]);
  const reader = await readerFor({ doc, afterSnapshot: observed => {
    assert.equal(observed.documentId, d1.documentId); assert.equal(observed.path, d1.path);
    assert.equal(currentPaths.get(observed.path), d1);
    currentPaths.set(observed.path, d2);
  } });
  try {
    const dispatch = await legacyDispatchFor(reader.read, Buffer.from('Old physical projection'));
    const result = await dispatch();
    assert.equal(result.isError, undefined);
    assert.equal(currentPaths.get('note.md'), d2);
    const content = result.structuredContent;
    assert.ok(content); assert.equal(content.content, 'Original D1 native text');
    assert.equal(content.document_id, d1.documentId);
    assert.equal(content.lineage_id, null, 'A legacy snapshot does not prove the D1 or D2 lineage.');
    assert.equal(content.document_url, directMcpFileLinkFields({ workspaceId: workspace.workspaceId,
      path: d1.path, documentId: d1.documentId, lineageId: null }).document_url);
    const url = new URL(content.document_url);
    assert.equal(url.searchParams.get('documentId'), d1.documentId);
    assert.equal(url.searchParams.has('lineageId'), false);
    assert.equal(url.searchParams.get('path'), d1.path);
    assert.deepEqual(reader.counters(), { revisions: 0, initializations: 0, reads: 1 });
  } finally { reader.dispose(); doc.destroy(); }
});

test('legacy physical read exposes no later native identity and performs no path-link lookup', async () => {
  const reader = await readerFor({ capable: false });
  const projection = Buffer.from('Ordinary physical text');
  try {
    const dispatch = await legacyDispatchFor(reader.read, projection);
    const result = await dispatch();
    assert.equal(result.isError, undefined);
    const content = result.structuredContent;
    assert.ok(content); assert.equal(content.content, projection.toString('utf8'));
    assert.equal(content.source, 'file'); assert.equal(content.document_id, null); assert.equal(content.lineage_id, null);
    const url = new URL(content.document_url);
    assert.equal(url.searchParams.get('path'), 'note.md');
    assert.equal(url.searchParams.has('documentId'), false); assert.equal(url.searchParams.has('lineageId'), false);
    assert.deepEqual(reader.counters(), { revisions: 0, initializations: 0, reads: 0 });
  } finally { reader.dispose(); }
});
