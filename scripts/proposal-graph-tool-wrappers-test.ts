import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { Value } from 'typebox/value';

import type * as Core from '../app/lib/pi/core-tools';
import type * as ToolResults from '../app/lib/pi/agent-file-tool-results';
import { ProposalGraphContractError } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolEditV1, ProposalToolReadResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS } from '../app/lib/pi/tool-output-policy';
import { readTextWindow } from '../app/lib/pi/text-read-window';
import { formatTextReadResult } from '../app/lib/pi/text-read-result';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 };
const source: ProposalToolReadResultV1['source'] = {
  kind: 'proposal', scope, proposalId: 'parent', proposalCasVersion: 2, authoredCandidateHash: hash('authored'),
  candidateHash: hash('candidate'), evaluationId: 'evaluation',
  current: { revisionId: 'revision', contentHash: hash('current'), structureHash: hash('structure'),
    stateVectorHash: hash('vector'), deleteSetHash: hash('delete'), fullStateHash: hash('state') },
  snapshot: { ref: 'candidate-snapshot', sha256: hash('candidate'), sizeBytes: 100, encoding: 'yjs_full_update_v1' },
  anchorMap: { ref: 'anchor-map', sha256: hash('anchors'), sizeBytes: 100 },
};
const intent: ProposalToolEditV1 = {
  contractVersion: 1, creationKind: 'extends', source, expectedParentCandidateHash: hash('candidate'),
  expectedParentCasVersion: 2, replaces: null, choice: null,
};
const selector = { contractVersion: 1 as const, proposalId: 'parent' };

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file); const load = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  return exports as T;
}
async function harness() {
  const controls = { content: 'Candidate parent text', sourceKind: 'workspace', projectionReads: 0, missing: false,
    metadataMissing: false, returnSource: structuredClone(source), backendError: null as Error | null,
    readCalls: [] as unknown[][], writes: [] as Record<string, unknown>[], edits: [] as Record<string, unknown>[], patches: [] as Record<string, unknown>[] };
  const results = await compile<typeof ToolResults>('app/lib/pi/agent-file-tool-results.ts', {
    './agent-file-operations': { AgentFileOperationOutcomeUnavailableError: class extends Error {} },
  });
  const result = { path: 'notes.md', resolvedPath: '/workspace/notes.md', changed: false, snapshot: null,
    beforeSha256: hash('before'), afterSha256: hash('before'), size: 20, diff: '+proposal', validation: { ok: true, checks: [] },
    collaboration: { operationId: 'operation', operationStatus: 'needs_review', durability: 'none', reviewRequired: false, proposedSha256: hash('proposed') },
    proposal: { contractVersion: 1 as const, proposalId: 'child', operationId: 'operation', scope, creationKind: 'extends' as const,
      casVersion: 1, candidateHash: hash('child'), source, relationships: { dependency: { proposalId: 'parent', candidateHash: hash('authored') }, replacesProposalId: null, choiceGroupId: null }, reviewRequired: true as const } };
  const helpers = {
    DEFAULT_READ_TEXT_LIMIT: 40000, MAX_READ_TEXT_LIMIT: 120000, DEFAULT_PDF_TEXT_PAGE_LIMIT: 10, MAX_PDF_TEXT_PAGE_LIMIT: 20,
    DEFAULT_PDF_IMAGE_LIMIT: 2, MAX_PDF_IMAGE_LIMIT: 5, PDF_AUTO_IMAGE_MAX_PAGES: 2, PDF_AUTO_IMAGE_MAX_BYTES: 100000, PDF_MAX_IN_MEMORY_BYTES: 1000000,
    resolveReadToolPath: async (file: string) => ({ fullPath: `/workspace/${file}`, displayPath: file, source: controls.sourceKind }),
    assertAgentPathAllowed: async () => {}, throwIfAborted() {},
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    clampReadTextLimit: (limit?: number) => Math.min(limit ?? 40000, 120000),
    clampPositiveInteger: (limit: number | undefined, fallback: number, maximum: number) => Math.min(limit ?? fallback, maximum),
    isPdfPath: () => false, imageContentForBuffer: async () => null, isPdfBuffer: () => false, bufferLooksBinary: () => false,
    sha256Buffer: (buffer: Buffer) => hash(buffer.toString('utf8')),
    readAgentCollaborativeTextFile: async (...args: unknown[]) => {
      controls.readCalls.push(args); if (controls.backendError) throw controls.backendError; if (controls.missing) return null;
      const options = args[2] as { includeStructure?: boolean; proposal?: unknown };
      return { documentId: scope.documentId, lifecycleGeneration: 1, schemaVersion: 1, representation: 'tiptap_blocks',
        documentSequence: 5, checkpointSequence: 3, stateVector: 'vector', content: controls.content, sha256: hash(controls.content),
        sourceUpdate: 'PRIVATE_YJS_BYTES_MUST_NOT_LEAK',
        ...(options.proposal && !controls.metadataMissing ? { proposal: { contractVersion: 1, source: controls.returnSource, contentSha256: hash(controls.content), graphRevision: 2 } } : {}),
        ...(options.includeStructure ? { structure: { offset: 0, nextOffset: null, totalBlocks: 1, blocks: [{ id: 'block', type: 'paragraph',
          parentId: null, beforeId: null, attrs: {}, text: controls.content, textTruncated: false, subtreeHash: hash('subtree'), placementHash: hash('placement') }] } } : {}) };
    },
    writeAgentTextFile: async (input: Record<string, unknown>) => { controls.writes.push(input); if (controls.backendError) throw controls.backendError; return result; },
    editAgentFile: async (input: Record<string, unknown>) => { controls.edits.push(input); if (controls.backendError) throw controls.backendError; return result; },
    applyAgentFilePatch: async (input: Record<string, unknown>) => { controls.patches.push(input); if (controls.backendError) throw controls.backendError; return [result]; },
  };
  const factories = new Proxy({}, { get: (_, key) => String(key) === 'createPdfTools' || String(key) === 'createOfficeDocumentTools' ? () => [] : () => ({ name: `unused-${String(key)}` }) });
  const mocks: Record<string, unknown> = {
    fs: { promises: { stat: async () => ({ size: 20 }), readFile: async () => { controls.projectionReads++; return Buffer.from('File fallback'); } } },
    '@/app/lib/pi/tool-runtime-helpers': helpers,
    '@/app/lib/pi/text-read-window': { readTextWindow }, '@/app/lib/pi/text-read-result': { formatTextReadResult },
    '@/app/lib/pi/agent-file-tool-results': results,
    '@/app/lib/pi/tool-file-formatters': { formatFileChangeResult: () => 'review required', formatFileChangeResults: () => 'review required' },
    '@/app/lib/pi/file-change-tool-result': {
      asAgentFileToolAppSuccess: results.asAgentFileToolSuccess,
      asAgentFilePatchToolAppSuccess: (values: typeof result[]) => ({ results: values.map(value => results.asAgentFileToolSuccess(value, 'apply_patch')) }),
    },
    '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => null },
  };
  for (const dependency of ['@/app/lib/mcp/proxy-tool', '@/app/lib/pi/browser/tool', '@/app/lib/pi/studio-tools', '@/app/lib/pi/web-tools',
    '@/app/lib/pi/document-relations-tool', '@/app/lib/pi/pdf-tools', '@/app/lib/pi/office-document-tools', '@/app/lib/pi/agent-shell-sandbox',
    '@/app/lib/pi/agent-runtime-temp', '@/app/lib/pi/agent-bash-runtime']) mocks[dependency] = factories;
  const core = await compile<typeof Core>('app/lib/pi/core-tools.ts', mocks);
  const tool = (name: string) => core.piTools.find(entry => entry.name === name)!;
  return { controls, tool, run: (name: string, input: Record<string, unknown>) => tool(name).execute('trusted-call', input, undefined) };
}
type Response = Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['run']>>;
const textOf = (response: Response) => response.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
function blocked(response: Response, code: string) {
  assert.equal((response as Response & { isError?: boolean }).isError, true, textOf(response));
  assert.equal((response.details as { code: string }).code, code);
}

test('write/edit/patch forward exact provenance and trusted retry key, reporting review-required', async () => {
  const h = await harness();
  for (const name of ['write', 'edit_file', 'apply_patch']) {
    const response = await h.run(name, name === 'write' ? { path: 'notes.md', content: 'child', proposal: intent }
      : name === 'edit_file' ? { path: 'notes.md', oldText: 'parent', newText: 'child', proposal: intent }
        : { files: [{ path: 'notes.md', edits: [{ oldText: 'parent', newText: 'child' }], proposal: intent }] });
    const details = response.details as ToolResults.AgentFileToolSuccess & { results?: ToolResults.AgentFileToolSuccess[] };
    const value = name === 'apply_patch' ? details.results![0] : details;
    assert.equal(value.outcome, 'review_required'); assert.equal(value.collaboration?.reviewRequired, true); assert.equal(value.changed, false);
  }
  assert.deepEqual(h.controls.writes[0].proposal, intent); assert.equal(h.controls.writes[0].idempotencyKey, 'trusted-call');
  assert.deepEqual(h.controls.edits[0].proposal, intent); assert.equal(h.controls.edits[0].idempotencyKey, 'trusted-call');
  assert.deepEqual((h.controls.patches[0].files as Record<string, unknown>[])[0].proposal, intent);
  assert.equal(h.controls.patches[0].idempotencyKeyPrefix, 'trusted-call');
});
test('declared null, undefined, malformed or stale references never reach a mutation facade', async () => {
  const h = await harness();
  for (const proposal of [null, undefined, {}, { ...intent, expectedParentCasVersion: 1 }]) {
    const code = proposal && 'expectedParentCasVersion' in proposal ? 'PROPOSAL_PARENT_CHANGED' : 'PROPOSAL_INVALID_REQUEST';
    blocked(await h.run('write', { path: 'notes.md', content: 'x', proposal }), code);
    blocked(await h.run('edit_file', { path: 'notes.md', oldText: 'x', newText: 'y', proposal }), code);
    blocked(await h.run('apply_patch', { files: [{ path: 'notes.md', edits: [], proposal }] }), code);
  }
  assert.equal(h.controls.writes.length + h.controls.edits.length + h.controls.patches.length, 0);
});
test('edit argument preparation preserves stable proposal errors before generic edit validation', async () => {
  const h = await harness(); const tool = h.tool('edit_file') as ReturnType<typeof h.tool> & { prepareArguments(input: unknown): unknown };
  assert.throws(() => tool.prepareArguments({ path: 'notes.md', proposal: null }), (error: unknown) => error instanceof ProposalGraphContractError && error.code === 'PROPOSAL_INVALID_REQUEST');
});
test('proposal patch rejects mixed documents and misplaced top-level declaration', async () => {
  const h = await harness();
  blocked(await h.run('apply_patch', { files: [{ path: 'a.md', edits: [], proposal: intent }, { path: 'b.md', edits: [] }] }), 'PROPOSAL_INVALID_REQUEST');
  blocked(await h.run('apply_patch', { proposal: null, files: [] }), 'PROPOSAL_INVALID_REQUEST');
  assert.equal(h.controls.patches.length, 0);
});
test('ordinary calls retain absent-proposal facade shapes', async () => {
  const h = await harness();
  await h.run('write', { path: 'notes.md', content: 'normal' });
  await h.run('edit_file', { path: 'notes.md', oldText: 'x', newText: 'y' });
  await h.run('apply_patch', { files: [{ path: 'a.md', edits: [] }, { path: 'b.md', edits: [] }] });
  assert.equal(Object.hasOwn(h.controls.writes[0], 'proposal'), false); assert.equal(Object.hasOwn(h.controls.writes[0], 'idempotencyKey'), false);
  assert.equal(Object.hasOwn(h.controls.edits[0], 'proposal'), false); assert.equal(h.controls.patches.length, 1);
});
test('proposal read returns exact complete proof in text and details, bounded and without Yjs payloads', async () => {
  const h = await harness(); h.controls.content = 'Long candidate 😀 '.repeat(5000);
  const response = await h.run('read', { path: 'notes.md', proposal: selector, maxChars: 120000 });
  const details = response.details as { proposal: ProposalToolReadResultV1; nextOffset: number };
  assert.deepEqual((h.controls.readCalls[0][2] as { proposal: unknown }).proposal, selector);
  assert.deepEqual(details.proposal.source, source); assert.equal(details.proposal.contentSha256, hash(h.controls.content));
  assert.match(textOf(response), /Proposal source proof:/u); assert.doesNotMatch(textOf(response), /PRIVATE_YJS|sourceUpdate/u);
  assert.ok(textOf(response).length <= TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS);
  assert.ok(JSON.stringify(response.details).length <= TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS);
  assert.ok(details.nextOffset > 0 && details.nextOffset < h.controls.content.length); assert.equal(h.controls.projectionReads, 0);
});
test('block proposal read includes untruncated proof in both JSON metadata surfaces', async () => {
  const h = await harness();
  const response = await h.run('read', { path: 'notes.md', proposal: selector, source: 'blocks', maxChars: 4000 });
  const content = JSON.parse(textOf(response));
  assert.deepEqual(content.proposal, (response.details as { proposal: unknown }).proposal);
  assert.deepEqual(content.proposal.source, source); assert.equal(content.structure.blocks.length, 1);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_YJS|sourceUpdate/u);
});
test('explicit null selector returns authoritative provenance, never an implicit latest proposal', async () => {
  const h = await harness();
  h.controls.returnSource = { kind: 'authoritative', scope, current: source.current, snapshot: source.snapshot, anchorMap: source.anchorMap };
  const response = await h.run('read', { path: 'notes.md', proposal: { contractVersion: 1, proposalId: null } });
  assert.equal((response.details as { proposal: ProposalToolReadResultV1 }).proposal.source.kind, 'authoritative');
  assert.match(textOf(response), /authoritative document source/u);
});
test('proposal read refuses unavailable, mismatched, stored-output and malformed references without fallback', async () => {
  const h = await harness();
  for (const proposal of [null, undefined, {}]) blocked(await h.run('read', { path: 'notes.md', proposal }), 'PROPOSAL_INVALID_REQUEST');
  assert.equal(h.controls.readCalls.length, 0);
  h.controls.missing = true; blocked(await h.run('read', { path: 'notes.md', proposal: selector }), 'PROPOSAL_SOURCE_INVALID'); h.controls.missing = false;
  h.controls.metadataMissing = true; blocked(await h.run('read', { path: 'notes.md', proposal: selector }), 'PROPOSAL_SOURCE_INVALID'); h.controls.metadataMissing = false;
  blocked(await h.run('read', { path: 'notes.md', proposal: { ...selector, proposalId: 'other' } }), 'PROPOSAL_SOURCE_INVALID');
  blocked(await h.run('read', { path: 'notes.md', proposal: { ...selector, expectedScope: { ...scope, lifecycleGeneration: 2 } } }), 'PROPOSAL_SCOPE_MISMATCH');
  h.controls.sourceKind = 'tool-output'; blocked(await h.run('read', { path: 'tool-output://old', proposal: selector }), 'PROPOSAL_SOURCE_INVALID');
  assert.equal(h.controls.projectionReads, 0);
});
test('tiny proposal-read budgets fail explicitly instead of truncating proof', async () => {
  const h = await harness(); blocked(await h.run('read', { path: 'notes.md', proposal: selector, maxChars: 100 }), 'PROPOSAL_LIMIT_EXCEEDED');
});
test('facade feature gates preserve their stable proposal error and never become success', async () => {
  const h = await harness(); h.controls.backendError = new ProposalGraphContractError('PROPOSAL_UPGRADE_REQUIRED', 'Not enabled yet');
  blocked(await h.run('read', { path: 'notes.md', proposal: selector }), 'PROPOSAL_UPGRADE_REQUIRED');
  blocked(await h.run('write', { path: 'notes.md', content: 'x', proposal: intent }), 'PROPOSAL_UPGRADE_REQUIRED');
  assert.equal(h.controls.projectionReads, 0);
});
test('public schemas expose shared provenance consistently on all four tools', async () => {
  const h = await harness();
  assert(Value.Check(h.tool('read').parameters, { path: 'notes.md', proposal: selector }));
  assert(Value.Check(h.tool('write').parameters, { path: 'notes.md', content: 'x', proposal: intent }));
  assert(Value.Check(h.tool('edit_file').parameters, { path: 'notes.md', oldText: 'x', newText: 'y', proposal: intent }));
  assert(Value.Check(h.tool('apply_patch').parameters, { files: [{ path: 'notes.md', edits: [], proposal: intent }] }));
});
