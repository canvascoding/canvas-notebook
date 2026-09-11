import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { Value } from 'typebox/value';
import { readTextWindow } from '../app/lib/pi/text-read-window';
import { formatTextReadResult } from '../app/lib/pi/text-read-result';
import { agentEditFileParameters } from '../app/lib/pi/agent-file-tool-schemas';
import { TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS } from '../app/lib/pi/tool-output-policy';
import type { CollaborationTextSnapshot } from '../app/lib/collaboration/agent-file-edits';
import type { AgentBlockEditRequest } from '../app/lib/collaboration/agent-block-edits';
import type { AgentEditFileInput, AgentFileChangeResult } from '../app/lib/pi/agent-file-operations';
import type * as Core from '../app/lib/pi/core-tools';
import type * as ToolResults from '../app/lib/pi/agent-file-tool-results';
import type * as OutputPreparation from '../app/lib/pi/tool-output-preparation';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as T;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const document = { documentId: 'document-1', lifecycleGeneration: 3, schemaVersion: 2 };
type Structure = NonNullable<CollaborationTextSnapshot['structure']>;
type Block = Structure['blocks'][number];
type Metadata = { document: typeof document; representation: string; structure: Structure };
const block = (index: number, text = `Paragraph ${index}`): Block => ({
  id: `block-${index}`, type: 'paragraph', parentId: null, beforeId: `block-${index + 1}`,
  attrs: { id: `block-${index}` }, text, textTruncated: false,
  subtreeHash: hash(`subtree-${index}`), placementHash: hash(`placement-${index}`),
});

async function harness() {
  const snapshot: CollaborationTextSnapshot = { ...document, path: 'document.md', representation: 'tiptap_blocks',
    content: '# Live heading\n\nLive paragraph 😀\n', sha256: hash('authoritative live content'),
    stateVector: 'durable-vector', documentSequence: 9, checkpointSequence: 4 };
  const controls = { blocks: [block(0), block(1), block(2)], live: true,
    source: 'workspace', readError: null as Error | null, editError: null as Error | null,
    projectedReads: 0, fileReads: [] as unknown[][], edits: [] as AgentEditFileInput[],
    result: { path: 'document.md', resolvedPath: '/workspace/document.md', changed: true, snapshot: null,
      beforeSha256: hash('before'), afterSha256: hash('after'), size: 28, diff: '-before\n+after',
      validation: { ok: true, checks: [] },
      collaboration: { operationId: 'agent-operation-1', operationStatus: 'persisted_yjs',
        durability: 'persisted_yjs', reviewRequired: false, proposedSha256: hash('proposed') },
    } as AgentFileChangeResult,
  };
  const projected = 'Projected ordinary file 😀\n';
  const helper = {
    DEFAULT_READ_TEXT_LIMIT: 40000, MAX_READ_TEXT_LIMIT: 120000,
    DEFAULT_PDF_TEXT_PAGE_LIMIT: 10, MAX_PDF_TEXT_PAGE_LIMIT: 20,
    DEFAULT_PDF_IMAGE_LIMIT: 2, MAX_PDF_IMAGE_LIMIT: 5,
    PDF_AUTO_IMAGE_MAX_PAGES: 2, PDF_AUTO_IMAGE_MAX_BYTES: 100000, PDF_MAX_IN_MEMORY_BYTES: 1000000,
    resolveReadToolPath: async (filePath: string) => ({ fullPath: `/workspace/${filePath}`, displayPath: filePath, source: controls.source }),
    assertAgentPathAllowed: async () => {}, throwIfAborted() {},
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    clampReadTextLimit: (limit?: number) => Math.min(limit ?? 40000, 120000),
    clampPositiveInteger: (limit: number | undefined, fallback: number, maximum: number) => Math.min(limit ?? fallback, maximum),
    isPdfPath: () => false, imageContentForBuffer: async () => null, isPdfBuffer: () => false, bufferLooksBinary: () => false,
    sha256Buffer: (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex'),
    readAgentCollaborativeTextFile: async (...args: [string, Buffer | undefined, {
      includeStructure?: boolean; structureOffset?: number; structureLimit?: number;
    }]) => {
      controls.fileReads.push(args);
      if (controls.readError) throw controls.readError;
      if (!controls.live) return null;
      const options = args[2];
      if (!options.includeStructure) return { ...snapshot };
      const offset = options.structureOffset ?? 0;
      const limit = options.structureLimit ?? 25;
      return { ...snapshot, structure: { blocks: controls.blocks.slice(offset, offset + limit), offset,
        nextOffset: offset + limit < controls.blocks.length ? offset + limit : null, totalBlocks: controls.blocks.length } };
    },
    editAgentFile: async (input: AgentEditFileInput) => {
      controls.edits.push(input);
      if (controls.editError) throw controls.editError;
      return controls.result;
    },
  };
  const results = await compile<typeof ToolResults>('app/lib/pi/agent-file-tool-results.ts', {
    './agent-file-operations': { AgentFileOperationOutcomeUnavailableError: class extends Error {} },
  });
  const factories = new Proxy({}, { get: (_, key) => String(key) === 'createPdfTools' || String(key) === 'createOfficeDocumentTools'
    ? () => [] : () => ({ name: `unused-${String(key)}` }) });
  const mocks: Record<string, unknown> = {
    fs: { promises: { stat: async () => ({ size: 30 }), readFile: async () => { controls.projectedReads++; return Buffer.from(projected); } } },
    '@/app/lib/pi/tool-runtime-helpers': helper,
    '@/app/lib/pi/agent-file-tool-results': results,
    '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => null },
  };
  for (const dependency of ['@/app/lib/mcp/proxy-tool', '@/app/lib/pi/browser/tool', '@/app/lib/pi/studio-tools',
    '@/app/lib/pi/web-tools', '@/app/lib/pi/document-relations-tool', '@/app/lib/pi/pdf-tools', '@/app/lib/pi/office-document-tools',
    '@/app/lib/pi/agent-shell-sandbox', '@/app/lib/pi/agent-runtime-temp', '@/app/lib/pi/agent-bash-runtime']) mocks[dependency] = factories;
  const core = await compile<typeof Core>('app/lib/pi/core-tools.ts', mocks);
  const read = core.piTools.find(tool => tool.name === 'read')!;
  const edit = core.piTools.find(tool => tool.name === 'edit_file')!;
  return { controls, snapshot, projected, read, edit,
    readStructure: (params: Record<string, unknown> = {}) => read.execute('read-1', { path: 'document.md', includeStructure: true, ...params }, undefined),
  };
}

function textOf(result: Awaited<ReturnType<(typeof Core)['piTools'][number]['execute']>>): string {
  return result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
}

test('read returns live structure and lifecycle reference in JSON content and details', async () => {
  const h = await harness();
  const result = await h.readStructure({ structureOffset: 1, structureLimit: 1 });
  const content = JSON.parse(textOf(result)) as Metadata;
  assert.deepEqual(content, { document, representation: 'tiptap_blocks',
    structure: { blocks: [h.controls.blocks[1]], offset: 1, nextOffset: 2, totalBlocks: 3 } });
  const details = result.details as Metadata & { sha256: string; collaboration: typeof document };
  assert.deepEqual(details.document, content.document);
  assert.deepEqual(details.structure, content.structure);
  assert.equal(details.sha256, h.snapshot.sha256);
  assert.deepEqual(h.controls.fileReads, [['/workspace/document.md', undefined,
    { includeStructure: true, structureOffset: 1, structureLimit: 1 }]]);
  assert.equal(h.controls.projectedReads, 0);
  assert.doesNotMatch(textOf(result), /Live heading|durable-vector/u, 'structure is bounded metadata, not a second full-document or binary dump');
});

test('structure maxChars paginates whole blocks using the actual count and independent block offset', async () => {
  const h = await harness();
  h.controls.blocks = Array.from({ length: 7 }, (_, i) => block(i));
  const oneBlock = JSON.parse(textOf(await h.readStructure({ structureLimit: 1 }))) as Metadata;
  const budget = JSON.stringify(oneBlock).length + 8;
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await h.readStructure({ structureOffset: offset, structureLimit: 7, maxChars: budget });
    assert.ok(textOf(result).length <= budget);
    const content = JSON.parse(textOf(result)) as Metadata;
    assert.equal(content.structure.blocks.length, 1);
    assert.equal(content.structure.offset, offset);
    assert.deepEqual(content.structure.blocks[0], h.controls.blocks[offset]);
    seen.push(content.structure.blocks[0].id);
    offset = content.structure.nextOffset;
  }
  assert.deepEqual(seen, h.controls.blocks.map(entry => entry.id));
});

test('an oversized first block only shortens text, retaining complete IDs, attributes and hashes', async () => {
  const h = await harness();
  h.controls.blocks = [block(0, '😀"\\\n'.repeat(350)), block(1)];
  const original = structuredClone(h.controls.blocks[0]);
  const result = await h.readStructure({ maxChars: 650 });
  assert.ok(textOf(result).length <= 650);
  const content = JSON.parse(textOf(result)) as Metadata;
  const shortened = content.structure.blocks[0];
  assert.deepEqual({ ...shortened, text: original.text, textTruncated: false }, original);
  assert.equal(shortened.textTruncated, true);
  assert.ok(shortened.text.length > 0 && original.text.startsWith(shortened.text));
  assert.equal(shortened.text.isWellFormed(), true, 'pagination preserves surrogate pairs');
  assert.equal(content.structure.nextOffset, 1);
  assert.deepEqual(h.controls.blocks[0], original, 'formatting does not mutate the read snapshot');
});

test('insufficient structure budget returns a specific minimum without broken JSON or lost identifiers', async () => {
  const h = await harness();
  const result = await h.readStructure({ maxChars: 20 });
  assert.match(textOf(result), /IDs, hashes and attributes require maxChars of at least \d+/u);
  assert.equal(h.controls.projectedReads, 0);
  h.controls.blocks = [];
  assert.match(textOf(await h.readStructure({ maxChars: 20 })), /Structure metadata requires maxChars of at least \d+/u);
});

test('empty or exhausted structure pages retain identity and terminate pagination', async () => {
  const h = await harness();
  for (const offset of [3, 100]) {
    const content = JSON.parse(textOf(await h.readStructure({ structureOffset: offset }))) as Metadata;
    assert.deepEqual(content.document, document);
    assert.deepEqual(content.structure, { blocks: [], offset, nextOffset: null, totalBlocks: 3 });
  }
});

test('large structure reads fit both generic content and details budgets without silently breaking JSON', async () => {
  const h = await harness();
  h.controls.blocks = Array.from({ length: 100 }, (_, index) => block(index, 'x'.repeat(2000)));
  const result = await h.readStructure({ structureLimit: 100, maxChars: 120000 });
  const metadata = JSON.parse(textOf(result)) as Metadata;
  assert.ok(textOf(result).length <= TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS);
  assert.ok(JSON.stringify(result.details).length <= TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS);
  assert.ok(metadata.structure.blocks.length > 1 && metadata.structure.blocks.length < 100);
  assert.equal(metadata.structure.nextOffset, metadata.structure.blocks.length);
  assert.deepEqual(metadata.structure.blocks, h.controls.blocks.slice(0, metadata.structure.blocks.length));
  const preparation = await compile<typeof OutputPreparation>('app/lib/pi/tool-output-preparation.ts', {
    'server-only': {}, './tool-output-store': { storeToolOutput: async () => { throw new Error('A bounded structure page must not need archival.'); } },
  });
  const prepared = await preparation.prepareToolOutput({ identity: null, toolCallId: 'large-structure', toolName: 'read', result });
  assert.equal(textOf(prepared), textOf(result), 'the real output pipeline preserves parseable structure JSON');
  assert.deepEqual((prepared.details as Metadata).structure, metadata.structure);
});

test('ordinary live and file reads preserve existing content, SHA and UTF-16 text windows', async () => {
  const h = await harness();
  for (const live of [true, false]) {
    h.controls.live = live;
    const result = await h.read.execute('read-normal', { path: 'document.md', offset: 2, maxChars: 12 }, undefined);
    const source = live ? h.snapshot.content : h.projected;
    const window = readTextWindow(source, 2, 12);
    const sha256 = live ? h.snapshot.sha256 : hash(source);
    const formatted = formatTextReadResult(window.text, window, sha256, live ? '\nSource: live Yjs collaboration state' : '');
    assert.equal(textOf(result), formatted.text);
    const details = result.details as Record<string, unknown>;
    assert.deepEqual(details.toolOutputReadWindow, formatted.layout);
    assert.equal(details.sha256, sha256);
    assert.equal(details.nextOffset, window.nextOffset);
    assert.equal(details.document, undefined);
    assert.equal(details.structure, undefined);
  }
  assert.equal(h.controls.projectedReads, 1);
});

test('structure mode rejects text offsets, missing opt-in, non-live files and legacy errors without fallback', async () => {
  const h = await harness();
  assert.match(textOf(await h.readStructure({ offset: 0 })), /cannot be combined with text offset/u);
  assert.equal(h.controls.fileReads.length, 0);
  assert.match(textOf(await h.read.execute('read', { path: 'document.md', structureOffset: 1 }, undefined)), /require includeStructure: true/u);
  h.controls.live = false;
  assert.match(textOf(await h.readStructure()), /active block collaboration document/u);
  h.controls.live = true;
  h.controls.readError = new Error('Structured reads require a block collaboration document; this document has not been migrated.');
  assert.match(textOf(await h.readStructure()), /has not been migrated/u);
  h.controls.source = 'tool-output';
  assert.match(textOf(await h.readStructure()), /active block collaboration document/u);
  assert.equal(h.controls.projectedReads, 0);
});

const operations: AgentBlockEditRequest[] = [
  { kind: 'move_block', blockId: 'one', placementHash: hash('placement'), parentId: null, beforeId: 'two' },
  { kind: 'delete_block', blockId: 'one', subtreeHash: hash('subtree') },
  { kind: 'insert_blocks', parentId: null, beforeId: null, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'New text', marks: [{ type: 'bold' }] }] }] },
  { kind: 'format_block', blockId: 'heading', beforeAttrs: { level: 2 }, afterAttrs: { level: 3 } },
  { kind: 'table_operation', cellId: 'cell', subtreeHash: hash('table'), action: 'addRowAfter' },
];

test('edit_file forwards each public operation, document identity and trusted call ID without requiring a global SHA', async () => {
  const h = await harness();
  for (const operation of operations) {
    const input = { path: 'document.md', document, operations: [operation] };
    const result = await h.edit.execute(`call-${operation.kind}`, input, undefined);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.deepEqual(h.controls.edits.at(-1), { ...input, idempotencyKey: `call-${operation.kind}` });
    const details = result.details as { outcome: string; collaboration: { durability: string }; resolvedPath?: string };
    assert.equal(details.outcome, 'applied');
    assert.equal(details.collaboration.durability, 'persisted_yjs');
    assert.equal(details.resolvedPath, undefined);
    assert.match(textOf(result), /Live collaboration operation: agent-operation-1 \(persisted_yjs, persisted_yjs\)/u);
  }
});

test('exact and block-targeted text adapters preserve existing options and use the same handler', async () => {
  const h = await harness();
  const inputs = [
    { path: 'document.md', oldText: 'old', newText: 'new', expectedSha256: hash('before'), expectedOccurrences: 2 },
    { path: 'document.md', oldText: 'old', newText: 'new', replaceAll: true },
    { path: 'document.md', oldText: 'old', newText: 'new', blockId: 'block-0', document },
  ];
  for (const input of inputs) {
    const result = await h.edit.execute('call-exact', input, undefined);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.deepEqual(h.controls.edits.at(-1), { ...input, idempotencyKey: 'call-exact' });
  }
});

test('structured edit outcomes retain review and failure semantics instead of promising application', async () => {
  const h = await harness();
  const input = { path: 'document.md', document, operations: [operations[0]] };
  h.controls.result = { ...h.controls.result, changed: false,
    collaboration: { ...h.controls.result.collaboration!, reviewRequired: true, operationStatus: 'needs_review', durability: 'none' } };
  const review = await h.edit.execute('review', input, undefined);
  assert.equal((review.details as { outcome: string }).outcome, 'review_required');
  assert.match(textOf(review), /Accept and Reject/u);
  h.controls.editError = new Error('The structured document reference is stale. Read its current structure again.');
  const failed = await h.edit.execute('stale', input, undefined);
  assert.equal((failed as { isError?: boolean }).isError, true);
  assert.equal((failed.details as { safeToAutoRetry: boolean }).safeToAutoRetry, false);
  assert.match(textOf(failed), /document reference is stale/u);
});

test('the edit schema strictly rejects ambiguous input, missing conditions and internal/raw payloads before the handler', async () => {
  const h = await harness();
  const input = { path: 'document.md', document, operations: [operations[0]] };
  const invalid = [
    { ...input, oldText: 'old', newText: 'new' }, { ...input, replaceAll: true }, { ...input, expectedOccurrences: 1 },
    { path: 'document.md', operations: [operations[0]] }, { ...input, operations: [] },
    { ...input, operations: Array.from({ length: 33 }, () => operations[0]) },
    { path: 'document.md', oldText: 'old', newText: 'new', blockId: 'block-0' },
    { ...input, document: { ...document, lifecycleGeneration: 0 } },
    { ...input, document: { ...document, rawUpdate: 'AA==' } },
    { ...input, idempotencyKey: 'caller-controlled' }, { ...input, prepared: { updateBase64: 'AA==' } },
    { ...input, operations: [{ ...operations[0], placementHash: undefined }] },
    { ...input, operations: [{ ...operations[0], placementHash: 'short' }] },
    { ...input, operations: [{ ...operations[0], rawUpdate: 'AA==' }] },
    { ...input, operations: [{ kind: 'prepared', updateBase64: 'AA==' }] },
    { ...input, operations: [{ ...operations[2], blocks: [] }] },
    { ...input, operations: [{ ...operations[2], blocks: [{ type: 'paragraph', prepared: { updateBase64: 'AA==' } }] }] },
    { ...input, operations: [{ ...operations[3], afterAttrs: { level: 3, id: 'overwrite' } }] },
    { ...input, operations: [{ ...operations[3], afterAttrs: { level: 7 } }] },
    { ...input, operations: [{ ...operations[3], afterAttrs: { style: 'color:red' } }] },
    { ...input, operations: [{ ...operations[3], beforeAttrs: { checked: false } }] },
    { ...input, operations: [{ ...operations[4], action: 'mergeCells' }] },
  ];
  for (const params of invalid) {
    assert.equal(Value.Check(agentEditFileParameters, params), false, JSON.stringify(params));
    const result = await h.edit.execute('invalid', params, undefined);
    assert.equal((result as { isError?: boolean }).isError, true, JSON.stringify(params));
    assert.match(textOf(result), /Supply either an exact/u);
  }
  assert.equal(h.controls.edits.length, 0);
});

test('schemas expose all supported table commands and bounded formatting and structure pagination', async () => {
  const h = await harness();
  for (const action of ['addRowBefore', 'addRowAfter', 'deleteRow', 'addColumnBefore', 'addColumnAfter', 'deleteColumn',
    'deleteTable', 'alignLeft', 'alignCenter', 'alignRight', 'alignNone', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight']) {
    assert.equal(Value.Check(h.edit.parameters, { path: 'document.md', document,
      operations: [{ ...operations[4], action }] }), true, action);
  }
  for (const attrs of [{ level: 6 }, { checked: false }, { start: 2 }, { language: null }, { language: 'c++' }]) {
    assert.equal(Value.Check(h.edit.parameters, { path: 'document.md', document,
      operations: [{ ...operations[3], beforeAttrs: attrs, afterAttrs: attrs }] }), true);
  }
  assert.equal(Value.Check(h.edit.parameters, { path: 'document.md', document, operations: Array.from({ length: 32 }, () => operations[0]) }), true);
  for (const params of [{ structureOffset: -1 }, { structureOffset: 0.5 }, { structureLimit: 0 }, { structureLimit: 101 }]) {
    assert.equal(Value.Check(h.read.parameters, { path: 'document.md', includeStructure: true, ...params }), false);
  }
  assert.equal(Value.Check(h.read.parameters, { path: 'document.md', includeStructure: true, structureLimit: 100 }), true);
  assert.equal((h.edit.parameters as { type?: string }).type, 'object', 'provider schemas and parameter discovery retain their object root');
});

test('inline formatting accepts supported marks and requires a link URL only when enabling a link', async () => {
  const h = await harness();
  const operation = { kind: 'format_text', blockId: 'paragraph', subtreeHash: hash('inline'), from: 0, to: 5, mark: 'bold', enabled: true };
  const input = (override: Record<string, unknown>) => ({ path: 'document.md', document, operations: [{ ...operation, ...override }] });
  for (const override of [{}, { mark: 'italic' }, { mark: 'strike', enabled: false }, { mark: 'code' },
    { mark: 'link', href: 'https://example.com' }, { mark: 'link', enabled: false }]) {
    const params = input(override);
    assert.equal(Value.Check(h.edit.parameters, params), true);
    const result = await h.edit.execute('inline-format', params, undefined);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.deepEqual(h.controls.edits.at(-1), { ...params, idempotencyKey: 'inline-format' });
  }
  for (const override of [{ mark: 'link' }, { mark: 'link', href: '' }, { href: 'https://example.com' },
    { mark: 'link', enabled: false, href: 'https://example.com' }, { from: -1 }, { to: 0.5 }, { mark: 'custom' },
    { mark: 'link', href: 'x'.repeat(2049) }, { updateBase64: 'AA==' }]) {
    assert.equal(Value.Check(h.edit.parameters, input(override)), false, JSON.stringify(override));
  }
});

test('the actual agent SDK validates the object-root edit alternatives and local guards', async () => {
  const h = await harness();
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  for (const operation of operations) {
    const args = { path: 'document.md', document, operations: [operation] };
    assert.deepEqual(validateToolArguments(h.edit, { type: 'toolCall', id: 'validate', name: 'edit_file', arguments: args }), args);
  }
  for (const args of [
    { path: 'document.md', document, operations: [operations[0]], oldText: 'ambiguous', newText: 'edit' },
    { path: 'document.md', operations: [operations[0]] },
    { path: 'document.md', document, operations: [{ ...operations[0], updateBase64: 'AA==' }] },
  ]) {
    assert.throws(() => validateToolArguments(h.edit, { type: 'toolCall', id: 'validate', name: 'edit_file', arguments: args }), /Validation failed/u);
  }
});
