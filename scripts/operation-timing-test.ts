import assert from 'node:assert/strict';

import { createOperationTiming } from '../app/lib/observability/operation-timing';

let current = 100;
const timing = createOperationTiming(() => current);

current = 112.345;
assert.equal(timing.mark('load'), 12.35);

current = 120;
assert.equal(timing.mark('load'), 7.66);

current = 125.555;
assert.equal(timing.mark('resolve'), 5.56);
assert.equal(timing.elapsedMs(), 25.56);
assert.deepEqual(timing.snapshot(), {
  totalMs: 25.56,
  phases: {
    load: 20.01,
    resolve: 5.56,
  },
});

console.log('operation-timing-test: ok');
