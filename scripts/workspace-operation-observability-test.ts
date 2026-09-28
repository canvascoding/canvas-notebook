import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setFileVersionCenterMetricAdapter } from '../app/lib/file-version-center/observability';
import { observeWorkspaceOperation, type WorkspaceOperationObservation } from '../app/lib/files/workspace-operation-observability';

test('workspace operation metrics use fixed labels and bounded counts without path data', () => {
  const metrics: Array<{ name: string; value?: number; labels: Readonly<Record<string, string>> }> = [];
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (line: string) => { logs.push(line); };
  setFileVersionCenterMetricAdapter({
    increment: (name, labels) => { metrics.push({ name, labels }); },
    observe: (name, value, labels) => { metrics.push({ name, value, labels }); },
  });
  try {
    observeWorkspaceOperation({ scope: 'review', kind: 'move', phase: 'preview', outcome: 'incomplete_link_plan',
      omittedSourceCount: 2.6, unresolvedLinkCount: -4,
      path: '/private/workspace/doc.md' } as WorkspaceOperationObservation);
    assert.deepEqual(metrics, [
      { name: 'workspace_file_operation_events_total', labels: {
        scope: 'review', kind: 'move', phase: 'preview', outcome: 'incomplete_link_plan' } },
      { name: 'workspace_file_operation_omitted_sources', value: 3, labels: {
        scope: 'review', kind: 'move', phase: 'preview', outcome: 'incomplete_link_plan' } },
      { name: 'workspace_file_operation_unresolved_links', value: 0, labels: {
        scope: 'review', kind: 'move', phase: 'preview', outcome: 'incomplete_link_plan' } },
    ]);
    assert.deepEqual(JSON.parse(logs[0]), { component: 'workspace_file_operation', version: 1,
      scope: 'review', kind: 'move', phase: 'preview', outcome: 'incomplete_link_plan',
      omittedSourceCount: 3, unresolvedLinkCount: 0 });
    observeWorkspaceOperation({ scope: 'review', kind: 'secret' as WorkspaceOperationObservation['kind'],
      phase: 'preview', outcome: 'conflict' });
    assert.equal(metrics.length, 3);
    assert.equal(logs.length, 1);
  } finally {
    setFileVersionCenterMetricAdapter(undefined);
    console.info = originalInfo;
  }
});

test('broken metric and log adapters cannot change an operation result', () => {
  const originalInfo = console.info;
  console.info = () => { throw new Error('logger offline'); };
  setFileVersionCenterMetricAdapter({
    increment: () => { throw new Error('metrics offline'); },
    observe: () => { throw new Error('metrics offline'); },
  });
  try {
    assert.doesNotThrow(() => observeWorkspaceOperation({
      scope: 'executor', kind: 'copy', phase: 'apply', outcome: 'needs_recovery',
    }));
  } finally {
    setFileVersionCenterMetricAdapter(undefined);
    console.info = originalInfo;
  }
});
