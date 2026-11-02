import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginWorkspaceSourceScan, withWorkspaceSourceScanObserver, type WorkspaceSourceScanMeasurement } from '../app/lib/observability/workspace-source-scan';

test('source diagnostics identify transient failures without exposing paths or arbitrary exception text', async () => {
  const records: WorkspaceSourceScanMeasurement[] = [];
  await withWorkspaceSourceScanObserver(record => records.push(record), async () => {
    const scan = beginWorkspaceSourceScan();
    scan.checkpoint('revalidation');
    scan.finish(false, 0, 4, ['native-source-changed', '/private/secret.md', 'credential-value', 'native-source-changed']);
  });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].gapCodes, ['native-source-changed', 'other']);
  assert.equal(records[0].gaps, 4);
  assert(!JSON.stringify(records).includes('secret'));
  assert(!JSON.stringify(records).includes('credential'));
  assert(Object.isFrozen(records[0].gapCodes));
});
test('diagnostic observer failures never change collector control flow', async () => {
  const result = await withWorkspaceSourceScanObserver(() => { throw new Error('observer failed'); }, async () => {
    beginWorkspaceSourceScan().finish(true, 1, 0);
    return 'source-result';
  });
  assert.equal(result, 'source-result');
});
