import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { WorkspaceSearchReadError, type WorkspaceSearchText } from '../app/lib/collaboration/workspace-search-reader';
import { directMcpFileLinkFields } from '../app/lib/mcp/server/file-links';
import { decodeDirectMcpDocumentSearchSelection } from '../app/lib/mcp/server/document-search-tool-contract';

type SearchResult = { isError?: boolean; structuredContent?: { results: Array<{
  path: string; excerpt: string; modified_at: string | null;
} & ReturnType<typeof directMcpFileLinkFields>>; truncated: boolean } };
type Fixture = { paths: string[]; diskPaths?: string[]; maxCandidates?: number;
  read?: (filePath: string) => Promise<WorkspaceSearchText>; catalogueUnavailable?: boolean };

/** Runs the real private MCP routing function; auth and I/O are explicit test seams. */
async function routing(fixture: Fixture) {
  const file = path.resolve('app/lib/mcp/server/workspace-tools.ts');
  const source = await readFile(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = ['executeSearchKnowledge', 'isVisibleWorkspaceNode', 'isSearchableTextFile', 'matchingExcerpt', 'toIsoDate', 'result', 'errorResult'];
  const declarations = names.map(name => {
    const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert(declaration, `Missing real function ${name}`); return declaration.getText(parsed);
  });
  const reads: string[] = [];
  const dependencies = {
    decodeDirectMcpDocumentSearchSelection,
    path, WorkspaceSearchReadError, TEXT_FILE_EXTENSIONS: new Set(['.md', '.txt']),
    MAX_WORKSPACE_ID_LENGTH: 200, MAX_PATH_LENGTH: 1024, MAX_TREE_DEPTH: 6, DEFAULT_SEARCH_RESULTS: 10,
    MAX_SEARCH_RESULTS: 25, MAX_SEARCH_CANDIDATES: fixture.maxCandidates ?? 400, MAX_SEARCH_FILE_BYTES: 256 * 1024,
    parseArgs: (args: unknown) => args,
    requiredString: (args: Record<string, unknown>, name: string) => String(args[name]),
    optionalString: (args: Record<string, unknown>, name: string, fallback: string) => args[name] ?? fallback,
    optionalInteger: (args: Record<string, unknown>, name: string, fallback: number) => args[name] ?? fallback,
    assertVisibleWorkspacePath: () => {}, invalidParams: (message: string) => { throw new Error(message); },
    authenticateForTool: async (_auth: unknown, scope: string) => {
      assert.equal(scope, 'knowledge:search', 'Identity links must not require the full-read scope.');
      return { principal: { userId: 'reader' } };
    },
    readableWorkspace: async () => ({ workspaceId: 'native-search-workspace' }),
    listBoundedWorkspaceTree: async () => ({ entries: (fixture.diskPaths ?? []).map(filePath => ({ path: filePath, type: 'file' })), truncated: false }),
    listWorkspaceSearchDocuments: async () => {
      if (fixture.catalogueUnavailable) throw new Error('Unavailable catalogue'); return fixture.paths;
    },
    readWorkspaceSearchText: async (_workspace: unknown, filePath: string, maxBytes: number) => {
      assert.equal(maxBytes, 256 * 1024); reads.push(filePath);
      return fixture.read ? fixture.read(filePath) : { content: 'fresh native target', modifiedAt: 1791894173000,
        source: 'persisted_yjs' as const, nativeIdentity: Object.freeze({ documentId: `native:${filePath}`,
          lineageId: `lineage:${filePath}`, path: filePath }) };
    },
    directMcpFileLinkFields,
    readDirectMcpFileLinks: async () => assert.fail('A late path lookup could attach replacement D2 to captured D1 text.'),
    getFileStats: async () => assert.fail('Search must not require a physical projection.'),
    readFile: async () => assert.fail('Search must not read a stale projection.'),
    auditWorkspaceToolCall: async () => {},
  };
  const compiled = ts.transpileModule(declarations.join('\n'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const execute = new Function(...Object.keys(dependencies), `${compiled}\nreturn executeSearchKnowledge;`)(...Object.values(dependencies)) as
    (args: { workspace_id: string; query: string; max_results?: number }) => Promise<SearchResult>;
  return { reads, search: (max_results?: number) => execute({ workspace_id: 'native-search-workspace', query: 'target', max_results }) };
}

test('MCP finds native-only and stale-projection documents once and filters hidden registry paths', async () => {
  const fixture = await routing({ paths: ['only-native.md', 'stale.md', '.hidden/note.md', 'folder/.hidden.md', 'picture.png'], diskPaths: ['stale.md'] });
  const result = await fixture.search();
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent?.truncated, false);
  assert.deepEqual(fixture.reads, ['only-native.md', 'stale.md']);
  assert.deepEqual(result.structuredContent?.results.map(row => row.path), fixture.reads);
  for (const row of result.structuredContent?.results ?? []) {
    assert.match(row.excerpt, /fresh native target/u);
    assert.equal(row.modified_at, new Date(1791894173000).toISOString());
    assert.deepEqual({ document_id: row.document_id, lineage_id: row.lineage_id, document_url: row.document_url },
      directMcpFileLinkFields({ workspaceId: 'native-search-workspace', path: row.path,
        documentId: `native:${row.path}`, lineageId: `lineage:${row.path}` }));
  }
});

test('MCP candidate and result limits expose incomplete search instead of silently complete coverage', async () => {
  const bounded = await routing({ paths: ['a.md', 'b.md', 'c.md'], maxCandidates: 2 });
  assert.equal((await bounded.search()).structuredContent?.truncated, true);
  assert.deepEqual(bounded.reads, ['a.md', 'b.md']);
  const results = await routing({ paths: ['a.md', 'b.md'] });
  const read = await results.search(1);
  assert.equal(read.structuredContent?.truncated, true); assert.equal(read.structuredContent?.results.length, 1);
});

test('MCP reports bounded/binary omissions and returns a failure for unavailable authority', async () => {
  const size = await routing({ paths: ['a.md', 'b.md'], read: async filePath => {
    if (filePath === 'a.md') throw new WorkspaceSearchReadError('SOURCE_TOO_LARGE');
    return { content: 'live target', modifiedAt: null, source: 'live_yjs',
      nativeIdentity: Object.freeze({ documentId: 'live-document', lineageId: 'live-lineage', path: filePath }) };
  } });
  const result = await size.search();
  assert.equal(result.structuredContent?.truncated, true);
  assert.equal(result.structuredContent?.results[0].modified_at, null);
  const offline = await routing({ paths: [], catalogueUnavailable: true });
  assert.equal((await offline.search()).isError, true); assert.deepEqual(offline.reads, []);
  const missing = await routing({ paths: ['missing.md'], read: async () => { throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE'); } });
  assert.equal((await missing.search()).isError, true);
});

test('MCP search links remain bound to D1 when the same path is replaced by D2 before result projection', async () => {
  const filePath = 'folder/note.md';
  const d1 = Object.freeze({ documentId: 'D1', lineageId: 'L1', path: filePath });
  const d2 = Object.freeze({ documentId: 'D2', lineageId: 'L2', path: filePath });
  const currentPaths = new Map<string, NonNullable<WorkspaceSearchText['nativeIdentity']>>([[filePath, d1]]);
  const fixture = await routing({ paths: [filePath], read: async selectedPath => {
    const captured = currentPaths.get(selectedPath);
    assert.ok(captured);
    assert.equal(captured, d1);
    currentPaths.set(selectedPath, d2);
    return { content: 'Original D1 target', modifiedAt: null, source: 'live_yjs', nativeIdentity: captured };
  } });
  const result = await fixture.search();
  assert.equal(result.isError, undefined);
  assert.equal(currentPaths.get(filePath), d2);
  assert.deepEqual(fixture.reads, [filePath]);
  const row = result.structuredContent?.results[0];
  assert.ok(row);
  assert.match(row.excerpt, /Original D1 target/u);
  assert.equal(row.document_id, 'D1'); assert.equal(row.lineage_id, 'L1');
  assert.equal(row.document_url, directMcpFileLinkFields({ workspaceId: 'native-search-workspace', ...d1 }).document_url);
  const url = new URL(row.document_url);
  assert.equal(url.searchParams.get('documentId'), 'D1');
  assert.equal(url.searchParams.get('lineageId'), 'L1');
  assert.equal(url.searchParams.get('path'), filePath);
});

test('physical search text keeps null native identity even when a native D2 appears at its path', async () => {
  const filePath = 'ordinary.txt';
  let currentPathIdentity: WorkspaceSearchText['nativeIdentity'] = null;
  const fixture = await routing({ paths: [], diskPaths: [filePath], read: async () => {
    const captured = currentPathIdentity;
    currentPathIdentity = Object.freeze({ documentId: 'D2', lineageId: 'L2', path: filePath });
    return { content: 'Physical target', modifiedAt: 1000, source: 'file', nativeIdentity: captured };
  } });
  const result = await fixture.search();
  assert.equal(result.isError, undefined);
  assert.ok(currentPathIdentity);
  const row = result.structuredContent?.results[0];
  assert.ok(row); assert.match(row.excerpt, /Physical target/u);
  assert.equal(row.document_id, null); assert.equal(row.lineage_id, null);
  const url = new URL(row.document_url);
  assert.equal(url.searchParams.has('documentId'), false); assert.equal(url.searchParams.has('lineageId'), false);
  assert.equal(url.searchParams.get('path'), filePath);
});
