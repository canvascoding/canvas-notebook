import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestCollaborationDocumentLocation } from '../app/lib/collaboration/document-location-request';

test('location accepts pending identity but rejects partial or malformed generation metadata', async () => {
  const original = globalThis.fetch;
  const identity = { success: true, workspaceId: 'workspace', documentId: 'document', path: 'note.md' };
  let body: Record<string, unknown> = { ...identity, lifecycleGeneration: null, representation: null };
  globalThis.fetch = async () => Response.json(body);
  const resolve = () => requestCollaborationDocumentLocation('workspace', 'document', new AbortController().signal);
  try {
    assert.deepEqual(await resolve(), { workspaceId: 'workspace', documentId: 'document', path: 'note.md',
      lifecycleGeneration: null, representation: null });
    for (const extra of [
      {}, { lifecycleGeneration: null }, { representation: null },
      { lifecycleGeneration: 1, representation: null }, { lifecycleGeneration: null, representation: 'tiptap_blocks' },
      { lifecycleGeneration: 0, representation: 'tiptap_blocks' },
      { lifecycleGeneration: null, representation: null, documentId: 'replacement' },
    ]) {
      body = { ...identity, ...extra };
      await assert.rejects(resolve, /Invalid document location/);
    }
    body = { ...identity, lifecycleGeneration: 1, representation: 'tiptap_blocks' };
    assert.equal((await resolve())?.lifecycleGeneration, 1);
  } finally { globalThis.fetch = original; }
});
