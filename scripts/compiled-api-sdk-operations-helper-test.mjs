import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { compiledOperationCases, compiledOperationStatusRequests, validateCompiledOperationJournal }
  from './helpers/compiled-operation-journal.mjs';

function fixture() {
  const context = { nonce: randomUUID(), workspaces: ['ws_' + randomUUID(), 'ws_' + randomUUID()] };
  const [a, b] = context.workspaces, plan = 'a'.repeat(64);
  const rows = compiledOperationCases.map(({ mode, kind }) => {
    const operation = `compiled-${kind}-${mode}-${context.nonce}`;
    const sdk = { operation_id: operation, plan_id: plan,
      ...(kind === 'copy' ? { source_workspace_id: a, destination_workspace_id: b,
        selections: [{ source_path: 'source-ü😀.md', destination_path: mode + '-copied.md' }] }
        : kind === 'move' ? { workspace_id: b, selections: [{ source_path: mode + '-move-source.md', destination_path: mode + '-moved.md' }] }
          : { workspace_id: b, path: mode + '-delete-source.md' }),
    };
    const rest = { apiVersion: 1, action: 'apply', operationId: operation, planId: plan,
      ...(kind === 'copy' ? { sourceWorkspaceId: a, destinationWorkspaceId: b,
        selections: [{ sourcePath: 'source-ü😀.md', destinationPath: mode + '-copied.md' }] }
        : kind === 'move' ? { workspaceId: b, selections: [{ sourcePath: mode + '-move-source.md', destinationPath: mode + '-moved.md' }] }
          : { workspaceId: b, path: mode + '-delete-source.md' }),
    };
    return { mode, kind, sdk, rest };
  });
  return { context, rows };
}

test('all six actual transport requests retain their exact owned scope and status selectors', () => {
  const { context, rows } = fixture();
  assert.equal(validateCompiledOperationJournal(rows, context, true), rows);
  const requests = compiledOperationStatusRequests(context);
  assert.equal(requests.length, 6);
  assert(requests.every(item => item.body.action === 'status' && !Object.hasOwn(item.body, 'planId')
    && !Object.hasOwn(item.body, 'selections') && !Object.hasOwn(item.body, 'path')));
  assert.deepEqual(new Set(requests.map(item => item.body.operationId)), new Set(rows.map(item => item.sdk.operation_id)));
});

test('partial progress is retained but cannot count as completed acceptance; duplicates also fail', () => {
  const { context, rows } = fixture(), partial = rows.slice(0, 5);
  assert.equal(validateCompiledOperationJournal(partial, context), partial);
  assert.throws(() => validateCompiledOperationJournal(partial, context, true));
  assert.throws(() => validateCompiledOperationJournal([...rows.slice(0, 5), rows[0]], context, true));
});

test('foreign workspace, operation, path or extra credential fields fail before reconciliation', () => {
  const { context, rows } = fixture();
  for (const mutate of [
    row => { row.rest.destinationWorkspaceId = 'ws_' + randomUUID(); },
    row => { row.sdk.operation_id = 'compiled-copy-rest-' + randomUUID(); },
    row => { row.sdk.selections[0].destination_path = '../outside.md'; },
    row => { row.rest.apiKey = 'not-a-reportable-field'; },
  ]) {
    const changed = structuredClone(rows); mutate(changed[0]);
    assert.throws(() => validateCompiledOperationJournal(changed, context, true));
  }
});
