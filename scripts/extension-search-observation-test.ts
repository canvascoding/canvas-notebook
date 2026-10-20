import assert from 'node:assert/strict';
import { observeExtensionStage, withExtensionObservation } from '../app/lib/plugins/extension-search-observation';

async function main() {
  const [local, remote] = await Promise.all([
    withExtensionObservation(() => observeExtensionStage('packages', async () => {
      await observeExtensionStage('catalog', async () => ['one', 'two'], values => values.length);
      await assert.rejects(observeExtensionStage('preview', async () => { throw new Error('PRIVATE_PROVIDER_SECRET'); }));
      return 7;
    })),
    withExtensionObservation(() => observeExtensionStage('store', async () => 9)),
  ]);
  assert.equal(local.result, 7); assert.equal(remote.result, 9);
  assert.match(local.serverTiming, /catalog;dur=[0-9.]+;desc="1 calls, 2 items"/u);
  assert.match(local.serverTiming, /preview;dur=/u, 'failed stages still have a duration');
  assert(!local.serverTiming.includes('store;') && !remote.serverTiming.includes('catalog;'), 'concurrent requests are isolated');
  assert(!local.serverTiming.includes('PRIVATE_PROVIDER_SECRET'), 'diagnostics contain no error messages');
  assert.equal(await observeExtensionStage('packages', async () => 11), 11, 'non-HTTP consumers work without an observation scope');
  const fresh = await withExtensionObservation(async () => 0);
  assert(!fresh.serverTiming.includes('packages;'), 'completed observations are never reused');
  console.log('PASS request-local extension timings, bounded static labels, error cleanup and concurrency isolation.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
