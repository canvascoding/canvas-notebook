import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { projectAgentEventForExternal, projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';
import { comparableOwnedSandboxToolResult } from '../tests/helpers/owned-sandbox-agent-chat';

type Result = Record<string, unknown>;

const originalResult = () => ({
  role: 'toolResult', toolCallId: 'call_owned_projection', toolName: 'edit_file', isError: false, timestamp: 1,
  content: [{ type: 'text', text: 'Changed docs/owned.md; inspect /private/tmp/owned-sandbox/diagnostic.json' }],
  details: {
    contractVersion: 1, kind: 'file_mutation', operation: 'edit_file', path: 'docs/owned.md',
    outcome: 'applied', category: 'success', changed: true,
    beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64),
    validation: { ok: true, checks: [] },
    document: { documentId: '11111111-1111-4111-8111-111111111111', lifecycleGeneration: 3,
      representation: 'rich_text', schemaVersion: 1 },
    collaboration: { operationId: '22222222-2222-4222-8222-222222222222', operationStatus: 'persisted_yjs',
      durability: 'persisted_yjs', reviewRequired: false, proposedSha256: 'b'.repeat(64) },
    canonicalPath: '/data/workspaces/owned/docs/owned.md',
    diagnostic: 'Inspect /private/tmp/owned-sandbox/diagnostic.json',
    toolOutput: { version: 1, modelChars: 80 },
  },
});

function projectedPair() {
  const original = originalResult();
  const live = projectAgentEventForExternal({ type: 'tool_execution_end', result: original }).result as Result;
  const persisted = projectAgentMessageForPersistence(original as AgentMessage) as unknown as Result;
  // The real persistence hook adds these two budgeting fields after tool end.
  // Model that additive metadata here; neither production projector is copied.
  const details = persisted.details as Result;
  details.toolOutput = { version: 1, modelChars: 79, storedBytes: 128 };
  details.toolOutputView = { version: 1, modelKey: 'owned-model', text: 'bounded display view' };
  return { original, live, persisted };
}

function setField(result: Result, path: readonly string[], value: unknown) {
  let cursor = result;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    assert(next && typeof next === 'object' && !Array.isArray(next));
    cursor = next as Result;
  }
  cursor[path.at(-1)!] = value;
}

test('actual live and persistence projections compare despite their exact privacy and budget metadata differences', () => {
  const { original, live, persisted } = projectedPair();
  assert.notDeepEqual(live.content, persisted.content, 'The fixture must exercise the two real privacy labels.');
  assert.match(JSON.stringify(persisted.content), /absolute server path omitted from persisted chat history/u);
  assert.match(JSON.stringify(live.content), /absolute server path omitted from live event/u);
  assert.equal((live.details as Result).canonicalPath, undefined);
  assert.equal((persisted.details as Result).canonicalPath, '/data/workspaces/owned/docs/owned.md');
  assert.equal((live.details as Result).toolOutputView, undefined);
  assert.ok((persisted.details as Result).toolOutputView);
  const before = structuredClone({ original, live, persisted });
  assert.deepEqual(comparableOwnedSandboxToolResult(persisted), comparableOwnedSandboxToolResult(live));
  assert.deepEqual({ original, live, persisted }, before, 'Comparison must not mutate either retained evidence record.');
});

test('semantic content, checksums, native identity and mutation receipts remain strict after projection', () => {
  const { live, persisted } = projectedPair();
  const expected = comparableOwnedSandboxToolResult(live);
  const mutations: Array<{ path: string[]; value: unknown }> = [
    { path: ['content'], value: [{ type: 'text', text: 'A different tool result.' }] },
    { path: ['details', 'afterSha256'], value: 'c'.repeat(64) },
    { path: ['details', 'document', 'documentId'], value: '33333333-3333-4333-8333-333333333333' },
    { path: ['details', 'document', 'lifecycleGeneration'], value: 4 },
    { path: ['details', 'document', 'representation'], value: 'plain_text' },
    { path: ['details', 'collaboration', 'operationId'], value: '44444444-4444-4444-8444-444444444444' },
    { path: ['details', 'collaboration', 'durability'], value: 'not_applied' },
    { path: ['details', 'collaboration', 'reviewRequired'], value: true },
    { path: ['details', 'validation', 'ok'], value: false },
    { path: ['details', 'changed'], value: false },
  ];
  for (const { path, value } of mutations) {
    const changed = structuredClone(persisted);
    setField(changed, path, value);
    assert.throws(() => assert.deepEqual(comparableOwnedSandboxToolResult(changed), expected),
      { code: 'ERR_ASSERTION' }, `A changed ${path.join('.')} must reject the comparison.`);
  }
});

test('only top-level budget metadata and the exact documented privacy label are normalized', () => {
  const { live, persisted } = projectedPair();
  const nested = { toolOutput: { nativeReceipt: 'retain-a' }, toolOutputView: { nativeReceipt: 'retain-b' } };
  (live.details as Result).nested = structuredClone(nested);
  (persisted.details as Result).nested = structuredClone(nested);
  const expected = comparableOwnedSandboxToolResult(live);
  assert.deepEqual(comparableOwnedSandboxToolResult(persisted), expected);
  const changedNested = structuredClone(persisted);
  setField(changedNested, ['details', 'nested', 'toolOutput', 'nativeReceipt'], 'changed');
  assert.throws(() => assert.deepEqual(comparableOwnedSandboxToolResult(changedNested), expected), { code: 'ERR_ASSERTION' });
  const similarLabel = structuredClone(persisted);
  (similarLabel.details as Result).diagnostic = 'Inspect [absolute server path omitted from persisted chat history ]';
  assert.throws(() => assert.deepEqual(comparableOwnedSandboxToolResult(similarLabel), expected), { code: 'ERR_ASSERTION' });
  const whitespace = structuredClone(persisted);
  (whitespace.details as Result).diagnostic = ` ${(whitespace.details as Result).diagnostic}\n`;
  assert.throws(() => assert.deepEqual(comparableOwnedSandboxToolResult(whitespace), expected), { code: 'ERR_ASSERTION' });
});
