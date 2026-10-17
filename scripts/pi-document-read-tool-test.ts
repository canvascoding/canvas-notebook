import assert from 'node:assert/strict';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { DocumentReadError, type DocumentReadPageV1 } from '../app/lib/documents/contracts';
import {
  decodePiDocumentReadSelection,
  formatPiDocumentReadError,
  formatPiDocumentReadPage,
  piDocumentReadParameters,
  PI_DOCUMENT_READ_DEFAULT_MAX_BYTES,
  PI_DOCUMENT_READ_MAX_BYTES,
} from '../app/lib/pi/document-read-tool-contract';
import { filterToolsForPlanningMode } from '../app/lib/pi/planning-mode';
import { getPiToolsetsForTool } from '../app/lib/pi/toolsets';
import { TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS } from '../app/lib/pi/tool-output-policy';

// Pure selection/serialization fixtures and actual planning/toolset filters only.
// This suite never invokes the native service and makes no authentication claim.
const version = `canvas-document-v1:${'a'.repeat(64)}`;
const metadataVersion = `canvas-document-metadata-v1:${'b'.repeat(64)}`;
const selectors = { workspaceId: 'workspace', documentId: 'document' };
let checks = 0;
function check(name: string, operation: () => void): void {
  operation();
  checks++;
  console.log(`PASS ${name}`);
}
const invalid = (error: unknown) => error instanceof DocumentReadError && error.code === 'INVALID_REQUEST';
function page(patch: Partial<DocumentReadPageV1> = {}): DocumentReadPageV1 {
  return { apiVersion: 1, document: { kind: 'native_document', ...selectors, organizationId: null,
    lineageId: 'lineage', lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1,
    path: 'note.md', title: 'Note', version, metadataVersion },
  currency: { source: 'persisted_yjs', observedVersion: version, observedDurable: true,
    durableVersion: version, durableSequence: 4, persistedAt: 1 },
  projection: { checkpointSequence: 3, checkpointedAt: 1, status: 'pending' },
  format: 'text', mediaType: 'text/plain', encoding: 'utf-8', fragment: '😀\n',
  byteOffset: 0, byteLength: 5, totalBytes: 10, nextCursor: 'opaque-fixture-cursor', complete: false, ...patch };
}
function text(result: ReturnType<typeof formatPiDocumentReadPage>): string {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return (result.content[0] as { type: 'text'; text: string }).text;
}

check('selection sets internal API/defaults without changing caller selectors', () => {
  const input = { ...selectors };
  const selected = decodePiDocumentReadSelection(input);
  assert.deepEqual(input, selectors);
  assert.deepEqual(selected, { apiVersion: 1, ...selectors, format: 'native', maxBytes: 1024 });
  assert(Object.isFrozen(selected));
  assert.equal(PI_DOCUMENT_READ_DEFAULT_MAX_BYTES, 1024);
  assert.equal(PI_DOCUMENT_READ_MAX_BYTES, 1024);
});

check('formats/full version/cursor survive explicit smaller-page selections', () => {
  for (const format of ['native', 'text', 'markdown'] as const) {
    for (const maxBytes of [4, 512, 1024]) {
      const selected = decodePiDocumentReadSelection({ ...selectors, format, maxBytes,
        expectedVersion: version, cursor: 'same-original-input-cursor' });
      assert.deepEqual(selected, { apiVersion: 1, ...selectors, format, maxBytes,
        expectedVersion: version, cursor: 'same-original-input-cursor' });
    }
  }
});

check('byte limits reject invalid numbers and values instead of clamping', () => {
  for (const maxBytes of [0, 3, 1025, 1.5, NaN, Infinity, '512', null, undefined]) {
    assert.throws(() => decodePiDocumentReadSelection({ ...selectors, maxBytes }), invalid);
  }
});

check('canonical selector validation rejects paths/extra fields/invalid identity or version', () => {
  for (const patch of [{ path: 'note.md' }, { apiVersion: 1 }, { offset: 0 }, { expected_sha256: 'a'.repeat(64) },
    { workspaceId: '' }, { workspaceId: ' workspace' }, { documentId: 'x'.repeat(257) },
    { documentId: 'doc\u0000id' }, { format: 'blocks' }, { expectedVersion: 'a'.repeat(64) },
    { cursor: '' }, { cursor: 'x'.repeat(4097) }]) {
    assert.throws(() => decodePiDocumentReadSelection({ ...selectors, ...patch }), invalid);
  }
});

check('accessors and non-data object shapes are rejected without evaluating getters', () => {
  let reads = 0;
  const accessor = { ...selectors };
  Object.defineProperty(accessor, 'maxBytes', { enumerable: true, get() { reads++; return 512; } });
  const nonenumerable = Object.defineProperty({ ...selectors }, 'maxBytes', { value: 512 });
  const symbol = { ...selectors, [Symbol('unexpected')]: true };
  for (const input of [accessor, nonenumerable, symbol, Object.assign(Object.create(null), selectors), [], null]) {
    assert.throws(() => decodePiDocumentReadSelection(input), invalid);
  }
  assert.equal(reads, 0);
});

check('advertised schema preserves the PI byte/cursor bounds and closed selectors', () => {
  assert.equal(Check(piDocumentReadParameters, selectors), true);
  assert.equal(Check(piDocumentReadParameters, { ...selectors, maxBytes: 512, expectedVersion: version }), true);
  for (const patch of [{ maxBytes: 3 }, { maxBytes: 1025 }, { maxBytes: 512.5 }, { path: 'note.md' },
    { apiVersion: 1 }, { cursor: 'x'.repeat(4097) }, { expectedVersion: 'old-sha' }]) {
    assert.equal(Check(piDocumentReadParameters, { ...selectors, ...patch }), false);
  }
});

check('successful serialization retains the same complete DTO and exact UTF-8 metadata', () => {
  const fixture = page();
  const result = formatPiDocumentReadPage(fixture);
  assert.equal(result.isError, undefined);
  assert.equal(result.details, fixture);
  assert.deepEqual(JSON.parse(text(result)), fixture);
  assert.equal(fixture.byteLength, 5);
  assert.equal(fixture.complete, false);
  assert.equal(fixture.nextCursor, 'opaque-fixture-cursor');
  assert.equal(fixture.projection.status, 'pending');
});

check('final and empty pages preserve complete/null cursor without invented continuation', () => {
  const fixture = page({ fragment: '', byteLength: 0, totalBytes: 0, nextCursor: null, complete: true });
  const result = formatPiDocumentReadPage(fixture);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(text(result)), fixture);
});

check('a byte-bounded control-character fragment is serialized faithfully', () => {
  const fixture = page({ fragment: '\u0000'.repeat(1024), byteLength: 1024, totalBytes: 2048 });
  const result = formatPiDocumentReadPage(fixture);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(text(result)), fixture);
  assert(text(result).length <= TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS);
  assert(JSON.stringify(result.details).length <= TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS);
});

check('serializer accepts the exact shared limit and rejects one additional character', () => {
  // Boundary serialization fixture, independent of the smaller PI selection cap.
  const seed = page({ fragment: 'x'.repeat(12000), byteLength: 12000, totalBytes: 12000, nextCursor: null, complete: true });
  const overhead = JSON.stringify(seed).length - seed.fragment.length;
  const count = TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS - overhead;
  const fixture = page({ fragment: 'x'.repeat(count), byteLength: count, totalBytes: count, nextCursor: null, complete: true });
  assert.equal(JSON.stringify(fixture).length, TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS);
  assert.equal(formatPiDocumentReadPage(fixture).isError, undefined);
  const larger = { ...fixture, fragment: `${fixture.fragment}x`, byteLength: count + 1, totalBytes: count + 1 };
  assert.equal((formatPiDocumentReadPage(larger).details as { code: string }).code, 'DOCUMENT_READ_OUTPUT_BUDGET_EXCEEDED');
});

check('metadata can defeat 1024/512/4 pages; errors expose no partial page or cursor', () => {
  for (const maxBytes of [1024, 512, 4]) {
    const fixture = page({ fragment: 'x'.repeat(maxBytes), byteLength: maxBytes, totalBytes: 2048,
      document: { ...page().document, title: '\u0000'.repeat(4096) } });
    const result = formatPiDocumentReadPage(fixture);
    assert.equal(result.isError, true);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.code, 'DOCUMENT_READ_OUTPUT_BUDGET_EXCEEDED');
    assert.equal(details.success, false);
    assert.equal(details.safeToAutoRetry, false);
    for (const key of ['fragment', 'cursor', 'nextCursor', 'complete', 'document', 'version', 'byteOffset']) {
      assert.equal(Object.hasOwn(details, key), false);
    }
    assert.deepEqual(JSON.parse(text(result)), details);
    assert(text(result).length < 1000);
  }
});

check('public service errors survive while unexpected/private messages remain bounded', () => {
  for (const code of ['DOCUMENT_VERSION_CONFLICT', 'ACCESS_DENIED', 'READ_OUTCOME_UNCONFIRMED'] as const) {
    const error = new DocumentReadError(code);
    error.message = 'private SQL token must not escape';
    const result = formatPiDocumentReadError(error);
    assert.equal(result.isError, true);
    assert.equal((result.details as { code: string }).code, code);
    assert.equal(text(result).includes('private'), false);
  }
  for (const error of [new Error('SELECT private_token'), { code: 'ACCESS_DENIED', message: 'private_token' }]) {
    const result = formatPiDocumentReadError(error);
    assert.equal((result.details as { code: string }).code, 'DOCUMENT_READ_UNAVAILABLE');
    assert.equal(text(result).includes('private_token'), false);
  }
  const cyclic = page() as DocumentReadPageV1 & { cycle?: unknown };
  cyclic.cycle = cyclic;
  assert.equal((formatPiDocumentReadPage(cyclic).details as { code: string }).code, 'DOCUMENT_READ_UNAVAILABLE');
});

check('actual planning filter allows native read and continues to exclude mutation names', () => {
  const names = ['read_document', 'read', 'write', 'edit_file', 'delete_path', 'move_path', 'apply_patch'];
  const tools: AgentTool[] = names.map(name => ({ name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'unused fixture' }], details: {} }) }));
  assert.deepEqual(filterToolsForPlanningMode(tools).map(tool => tool.name), ['read_document', 'read']);
  assert.deepEqual(getPiToolsetsForTool('read_document'), ['file']);
});

assert.equal(checks, 13);
console.log('pi-document-read-tool-test: 13 pure contract/filter checks passed (no service or authorization claim)');
