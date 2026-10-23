import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { getToolOutputMetadata } from '../../app/lib/pi/tool-output-metadata';

type Result = Record<string, unknown>;
export type OwnedSandboxOriginalResult = { result: Result; source: { kind: 'inline' } | {
  kind: 'archive'; reference: string; sha256: string; bytes: number; characters: number; pages: number;
} };

/** Read the existing owner-authorized session output API, never private store paths.
 * All pages and the assembled bytes must match the exact emitted+persisted
 * complete reference. Missing or ambiguous originals cannot certify the edit.
 */
export async function readOwnedSandboxToolResult(input: {
  request: APIRequestContext; sessionId: string; agentId: string; workspaceId: string; toolCallId: string;
  live: Result; persisted: Result;
}): Promise<OwnedSandboxOriginalResult> {
  for (const id of [input.sessionId, input.agentId, input.workspaceId, input.toolCallId]) {
    assert(typeof id === 'string' && id.length > 0 && id.length <= 200 && id === id.trim() && !/[\u0000-\u001f\u007f]/u.test(id));
  }
  const metadata = getToolOutputMetadata(input.live.details);
  const saved = getToolOutputMetadata(input.persisted.details);
  assert(metadata && saved);
  assert.deepEqual(saved.references, metadata.references, 'The stored reference must be the real emitted reference.');
  assert.equal(metadata.storageError, undefined); assert.equal(saved.storageError, undefined);
  if (metadata.references.length === 0) return { result: structuredClone(input.live), source: { kind: 'inline' } };
  assert.equal(metadata.references.length, 1, 'This fixture requires one unambiguous complete original.');
  const reference = metadata.references[0];
  const call = createHash('sha256').update(input.toolCallId).digest('hex');
  assert.match(reference.reference, new RegExp(`^tool-output://call-${call}/output-[a-f0-9]{32}\\.json$`, 'u'));
  assert.equal(reference.complete, true); assert.match(reference.sha256, /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(reference.bytes) && reference.bytes > 0 && reference.bytes <= 2 * 1024 * 1024);
  assert(Number.isSafeInteger(reference.characters) && reference.characters > 0 && reference.characters <= 500_000);
  const chunks: string[] = [];
  let offset = 0, pages = 0;
  while (offset < reference.characters) {
    assert(++pages <= 64);
    const response = await input.request.get(`/api/sessions/${encodeURIComponent(input.sessionId)}/tool-output`, {
      params: { agentId: input.agentId, workspaceId: input.workspaceId, reference: reference.reference,
        offset: String(offset), maxChars: '10000' }, maxRedirects: 0, timeout: 10_000,
    });
    let page: Record<string, unknown>;
    try {
      assert(response.ok(), `Owned original output returned HTTP ${response.status()}.`);
      const body = await response.body(); assert(body.length <= 128 * 1024);
      page = JSON.parse(body.toString()); assert(page && typeof page === 'object' && !Array.isArray(page));
    } finally { await response.dispose(); }
    assert.equal(page.sha256, reference.sha256); assert.equal(page.totalChars, reference.characters); assert.equal(page.offset, offset);
    assert(typeof page.content === 'string' && page.content.length > 0 && page.content.length <= 10_000);
    assert.equal(typeof page.eof, 'boolean');
    chunks.push(page.content); offset += page.content.length;
    assert(offset <= reference.characters);
    if (page.eof) { assert.equal(offset, reference.characters); assert.equal(page.nextOffset, offset); break; }
    assert.equal(page.nextOffset, offset); assert(offset < reference.characters);
  }
  const content = chunks.join('');
  assert.equal(content.length, reference.characters); assert.equal(Buffer.byteLength(content), reference.bytes);
  assert.equal(createHash('sha256').update(content).digest('hex'), reference.sha256);
  const result = JSON.parse(content) as unknown;
  assert(result && typeof result === 'object' && !Array.isArray(result));
  const original = result as Result;
  assert(Array.isArray(original.content) && original.details && typeof original.details === 'object' && !Array.isArray(original.details));
  return { result: original, source: { kind: 'archive', reference: reference.reference, sha256: reference.sha256,
    bytes: reference.bytes, characters: reference.characters, pages } };
}
