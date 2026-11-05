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
test('source timing separates completed and failed reads from native work', async () => {
  const records: WorkspaceSourceScanMeasurement[] = [];
  const failure = new Error('private database diagnostic');
  await withWorkspaceSourceScanObserver(value => records.push(value), async () => {
    const scan = beginWorkspaceSourceScan();
    assert.equal(await scan.read('native', async () => 42), 42);
    await assert.rejects(scan.read('native', async () => { throw failure; }), error => error === failure);
    scan.checkpoint('native'); scan.finish(false, 0, 1);
  });
  const value = records[0];
  assert(Number.isFinite(value.readWaitMs.native) && value.readWaitMs.native! >= 0);
  assert(Number.isFinite(value.workMs.native) && value.workMs.native! >= 0);
  assert(Object.isFrozen(value.readWaitMs) && Object.isFrozen(value.workMs));
  assert(!JSON.stringify(value).includes('private'));
});
