import assert from 'node:assert/strict';

import {
  DEFAULT_PI_CONFIG,
  normalizePiRuntimeConfig,
  validatePiConfig,
  type PiRuntimeConfig,
} from '../app/lib/pi/config';
import {
  PI_COMPACTION_SUMMARY_MODEL_ENV,
  PI_COMPACTION_TAIL_MODE_ENV,
  resolvePiEffectiveCompactionPolicy,
} from '../app/lib/pi/compaction/runtime-policy';

function runtimeConfig(compaction: PiRuntimeConfig['compaction']): PiRuntimeConfig {
  return {
    ...structuredClone(DEFAULT_PI_CONFIG),
    compaction,
  };
}

const persisted = resolvePiEffectiveCompactionPolicy({
  runtimeConfig: runtimeConfig({
    tailMode: 'lean',
    summaryModel: 'fast-provider/summary-v1',
  }),
  environment: {},
});
assert.equal(persisted.contextBudgetPolicy.tailMode, 'lean');
assert.equal(persisted.summaryModel, 'fast-provider/summary-v1');
assert.deepEqual(persisted.sources, { tailMode: 'persisted', summaryModel: 'persisted' });

const overridden = resolvePiEffectiveCompactionPolicy({
  runtimeConfig: runtimeConfig({
    tailMode: 'lean',
    summaryModel: 'fast-provider/summary-v1',
  }),
  environment: {
    [PI_COMPACTION_TAIL_MODE_ENV]: 'legacy',
    [PI_COMPACTION_SUMMARY_MODEL_ENV]: 'emergency-provider/summary-v2',
  },
});
assert.equal(overridden.contextBudgetPolicy.tailMode, 'legacy');
assert.equal(overridden.summaryModel, 'emergency-provider/summary-v2');
assert.deepEqual(overridden.sources, { tailMode: 'environment', summaryModel: 'environment' });

const invalidOverride = resolvePiEffectiveCompactionPolicy({
  runtimeConfig: runtimeConfig({
    tailMode: 'lean',
    summaryModel: 'fast-provider/summary-v1',
  }),
  environment: {
    [PI_COMPACTION_TAIL_MODE_ENV]: 'unexpected',
    [PI_COMPACTION_SUMMARY_MODEL_ENV]: 'not\u0000a-model',
  },
});
assert.equal(invalidOverride.contextBudgetPolicy.tailMode, 'lean');
assert.equal(invalidOverride.summaryModel, 'fast-provider/summary-v1');
assert.deepEqual(invalidOverride.sources, { tailMode: 'persisted', summaryModel: 'persisted' });

const defaults = resolvePiEffectiveCompactionPolicy({ environment: {} });
assert.equal(defaults.contextBudgetPolicy.tailMode, 'legacy');
assert.equal(defaults.summaryModel, null);
assert.deepEqual(defaults.sources, { tailMode: 'default', summaryModel: 'default' });

assert.equal(validatePiConfig(runtimeConfig({ tailMode: 'lean', summaryModel: 'provider/model' })), null);
assert.match(
  validatePiConfig(runtimeConfig({ tailMode: 'invalid' as never })) || '',
  /compaction\.tailMode/,
);
assert.match(
  validatePiConfig(runtimeConfig({ summaryModel: 'bad\u0000identity' })) || '',
  /compaction\.summaryModel/,
);

const normalized = normalizePiRuntimeConfig({
  ...runtimeConfig({
    tailMode: 'lean',
    summaryModel: '  provider/model  ',
  }),
});
assert.deepEqual(normalized.compaction, { tailMode: 'lean', summaryModel: 'provider/model' });

console.log('pi-compaction-runtime-policy-test: ok');
