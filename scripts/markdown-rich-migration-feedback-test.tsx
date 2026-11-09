import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import * as Y from 'yjs';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import en from '../messages/en.json';
import de from '../messages/de.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'localStorage'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

async function main() {
  const { render, cleanup, screen, fireEvent, waitFor } = await import('@testing-library/react');
  const { MarkdownRichMigration } = await import('../app/components/editor/MarkdownDocumentModes');
  const previousFetch = globalThis.fetch;
  const doc = new Y.Doc(); doc.getText('content').insert(0, '# Preserved source\n');
  const before = Y.encodeStateAsUpdate(doc);
  let requests: Record<string, unknown>[] = [], disconnects = 0, reconnects = 0, resumed = 0, ready = 0, checkpoints = 0;
  let respond = (_body: Record<string, unknown>): Response | Promise<Response> => { throw new Error('Unconfigured response'); };
  const proof = { expectedDocumentId: 'native-doc', expectedLifecycleGeneration: 1,
    documentSequence: 1, stateProof: `sha256:${'a'.repeat(64)}` };
  const collaboration = { doc, registryKey: 'workspace\0source.md', connection: 'live', durability: 'checkpointed_file',
    provider: { disconnect: () => { disconnects++; }, connect: () => { reconnects++; } },
    requestCheckpoint: async () => { checkpoints++; }, getMigrationCheckpoint: async () => proof } as unknown as CollaborationDocument;
  globalThis.fetch = async (_input, init) => { const body = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push(body); return respond(body); };
  const mount = (locale: 'en' | 'de' = 'en') => render(<NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
    <MarkdownRichMigration collaboration={collaboration} filePath="source.md" onReady={() => { ready++; }} onSourceResume={() => { resumed++; }} />
  </NextIntlClientProvider>);
  const blocked = (reason: string) => (body: Record<string, unknown>) => Response.json({ success: true, migration: {
    requestId: (body.migration as { requestId: string }).requestId, documentId: 'native-doc', lifecycleGeneration: 1, status: 'blocked', reason } });
  const reset = () => { cleanup(); requests = []; disconnects = 0; reconnects = 0; resumed = 0; ready = 0; checkpoints = 0; };
  const click = (locale: 'en' | 'de' = 'en') => fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Prepare formatted editing' : 'Formatierte Bearbeitung vorbereiten' }));
  const finished = () => waitFor(() => assert.equal(screen.getByRole('button', { name: 'Prepare formatted editing' }).hasAttribute('disabled'), false), { timeout: 5000 });
  const sourceUnchanged = () => assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  const result = (body: Record<string, unknown>, status: string, reason?: string, overrides: object = {}) => Response.json({ success: true,
    representation: status === 'migrated' ? 'tiptap_blocks' : 'plain_text', richTextSchemaVersion: 3, blockTreeFormatVersion: 1,
    migration: { requestId: (body.migration as { requestId: string }).requestId, documentId: 'native-doc', lifecycleGeneration: 1, status, reason, ...overrides } });
  let cases = 0;
  try {
    for (const [reason, message] of [
      ['room_active', /Other editors/u], ['runtime_unavailable', /temporarily unavailable/iu],
      ['checkpoint_stale', /finish saving/iu], ['state_changed', /changed during preparation/iu],
      ['lifecycle_stale', /changed during preparation/iu], ['unrecognized_secret_reason', /could not be prepared/iu],
    ] as const) {
      reset(); respond = blocked(reason); mount(); click(); await finished();
      assert.match(screen.getByRole('status').textContent!, message);
      if (reason !== 'room_active') assert.doesNotMatch(screen.getByRole('status').textContent!, /Other editors/u);
      assert(!document.body.textContent?.includes('unrecognized_secret_reason'));
      assert.equal(requests.length, 1); assert.equal(disconnects, 1); assert.equal(reconnects, 1); assert.equal(resumed, 1); assert.equal(ready, 0);
      sourceUnchanged(); cases++;
    }
    reset(); respond = blocked('runtime_unavailable'); mount('de'); click('de');
    await waitFor(() => assert.match(screen.getByRole('status').textContent!, /vorübergehend nicht verfügbar/u));
    sourceUnchanged(); cases++;
    reset(); respond = body => result(body, 'unsupported', 'roundtrip_changed'); mount(); click(); await finished();
    assert.match(screen.getByRole('status').textContent!, /stay in source mode/u); assert.equal(resumed, 1); sourceUnchanged(); cases++;
    for (const status of [401, 403, 429]) {
      reset(); respond = () => new Response('private error body must not be shown', { status }); mount(); click(); await finished();
      assert.match(screen.getByRole('status').textContent!, status === 429 ? /Too many preparation requests/u : /access could not be confirmed/u);
      assert(!document.body.textContent?.includes('private error body')); assert.equal(requests.length, 1);
      assert(screen.getByRole('button', { name: 'Cancel' })); assert.equal(reconnects, 0); assert.equal(ready, 0);
      sourceUnchanged(); cases++;
    }
    for (const action of ['retry', 'cancel'] as const) {
      reset(); respond = () => { throw new Error('private network failure'); }; mount(); click(); await finished();
      assert.match(screen.getByRole('status').textContent!, /result could not be confirmed/u);
      assert.equal(requests.length, 1); assert.equal(reconnects, 0);
      const originalRequest = requests[0].migration;
      respond = body => result(body, action === 'retry' ? 'migrated' : 'blocked', action === 'retry' ? undefined : 'cancelled');
      if (action === 'retry') click(); else fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await finished(); assert.equal(requests.length, 2); assert.deepEqual(requests[1].migration, originalRequest);
      assert.equal(checkpoints, 1); assert.equal(disconnects, 1); assert.equal(ready, action === 'retry' ? 1 : 0);
      assert.equal(reconnects, action === 'cancel' ? 1 : 0);
      if (action === 'cancel') { assert.equal(requests[1].migrationAction, 'cancel'); assert.match(screen.getByRole('status').textContent!, /was cancelled/u); }
      else assert.equal(screen.queryByRole('status'), null);
      sourceUnchanged(); cases++;
    }
    for (const overrides of [{ requestId: 'different' }, { documentId: 'different' }, { lifecycleGeneration: 2 }]) {
      reset(); respond = body => result(body, 'blocked', 'runtime_unavailable', overrides); mount(); click(); await finished();
      assert.match(screen.getByRole('status').textContent!, /result could not be confirmed/u);
      assert.equal(requests.length, 3); assert.equal(reconnects, 0); assert.equal(resumed, 0); assert.equal(ready, 0);
      assert(requests.every(request => JSON.stringify(request.migration) === JSON.stringify(requests[0].migration)));
      sourceUnchanged(); cases++;
    }
    for (const accepted of [true, false]) {
      reset(); respond = body => result(body, 'migrated');
      const current = Promise.withResolvers<typeof proof>();
      let checkpointObserved = false;
      collaboration.getMigrationCheckpoint = () => { checkpointObserved = true; return current.promise; };
      mount(); click(); await waitFor(() => assert(checkpointObserved));
      assert(screen.getByRole('button', { name: 'Preparing…' }));
      assert.equal(requests.length, 0); assert.equal(disconnects, 0);
      if (accepted) current.resolve(proof); else current.reject(new Error('Document changed during reconnect.'));
      await finished();
      assert.equal(requests.length, accepted ? 1 : 0);
      assert.equal(disconnects, accepted ? 1 : 0);
      assert.equal(ready, accepted ? 1 : 0);
      assert.equal(resumed, accepted ? 0 : 1);
      sourceUnchanged(); cases++;
    }
    assert.equal(cases, 18);
    console.log(JSON.stringify({ suite: 'markdown-rich-migration-feedback-ui', cases, passed: true,
      nativeSourceUnchanged: true, ambiguousOutcomeKeepsOriginalRequest: true, authorizationOrRateLimitNotRetried: true,
      compiledBrowser: false, actualServerAuthorization: false }));
  } finally { cleanup(); globalThis.fetch = previousFetch; doc.destroy(); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
