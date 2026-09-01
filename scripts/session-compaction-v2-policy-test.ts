/**
 * Behavioral tests adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createSessionCompactionBudget,
  evaluateSessionCompactionPressure,
  normalizeHermesThresholdTokensCap,
  resolveHermesMaximumAttempts,
  resolveHermesModelThresholdRatio,
  sessionCompactionMadeProgress,
  sessionCompactionWarrantsAnotherPass,
  shouldRunSessionCompactionPreflight,
} from '../app/lib/pi/compaction/policy';

const parity = JSON.parse(fs.readFileSync(
  'scripts/fixtures/session-compaction-v2/hermes-policy-parity.json',
  'utf8',
)) as {
  hermesCommit: string;
  cases: Array<{
    id: string;
    input: {
      contextWindowTokens: number;
      outputReserveTokens: number;
      fixedRequestTokens: number;
    };
    expected: {
      effectiveInputBudgetTokens: number;
      effectiveThresholdRatio: number;
      triggerTokens: number;
      targetTailTokens: number;
    };
  }>;
};
assert.equal(parity.hermesCommit, 'f293e7206b4ddd66042329442c6afebc19a8808d');

for (const fixture of parity.cases) {
  const budget = createSessionCompactionBudget(fixture.input);
  assert.deepEqual({
    effectiveInputBudgetTokens: budget.effectiveInputBudgetTokens,
    effectiveThresholdRatio: budget.effectiveThresholdRatio,
    triggerTokens: budget.triggerTokens,
    targetTailTokens: budget.targetTailTokens,
  }, fixture.expected, `${fixture.id} must match the pinned Hermes policy`);
  if (budget.effectiveInputBudgetTokens > 1) {
    assert(
      budget.triggerTokens < budget.effectiveInputBudgetTokens,
      `${fixture.id} must retain a reachable trigger below the usable input budget`,
    );
  }
}

assert.equal(resolveHermesModelThresholdRatio('glm-5.2', undefined, 0.5), 0.5);
assert.equal(resolveHermesModelThresholdRatio(
  'provider:glm-5.2-1M',
  { 'glm-5.2': 0.4, 'glm-5.2-1M': 0.25 },
  0.5,
), 0.25, 'the longest model substring must win');
assert.deepEqual(createSessionCompactionBudget({
  contextWindowTokens: 1_000_000,
  outputReserveTokens: 0,
  fixedRequestTokens: 0,
  modelIdentity: 'provider:glm-5.2-1M',
  config: { modelThresholds: { 'glm-5.2': 0.4, 'glm-5.2-1M': 0.25 } },
}), {
  contextWindowTokens: 1_000_000,
  outputReserveTokens: 0,
  fixedRequestTokens: 0,
  effectiveInputBudgetTokens: 1_000_000,
  configuredThresholdRatio: 0.25,
  effectiveThresholdRatio: 0.25,
  ratioThresholdTokens: 250_000,
  thresholdTokensCap: null,
  triggerTokens: 250_000,
  targetTailTokens: 50_000,
  protectFirstMessages: 3,
  protectLastMessages: 20,
  maximumAttempts: 3,
});
const capped = createSessionCompactionBudget({
  contextWindowTokens: 1_000_000,
  outputReserveTokens: 0,
  fixedRequestTokens: 0,
  config: { thresholdTokensCap: 200_000 },
});
assert.equal(capped.triggerTokens, 200_000);
assert.equal(capped.targetTailTokens, 40_000);
assert.equal(normalizeHermesThresholdTokensCap('200000'), 200_000);
assert.equal(normalizeHermesThresholdTokensCap(0), null);
assert.equal(normalizeHermesThresholdTokensCap('invalid'), null);

assert.equal(resolveHermesMaximumAttempts(undefined), 3);
assert.equal(resolveHermesMaximumAttempts(true), 3);
assert.equal(resolveHermesMaximumAttempts(4.7), 3);
assert.equal(resolveHermesMaximumAttempts('6'), 6);
assert.equal(resolveHermesMaximumAttempts(99), 10);
assert.equal(resolveHermesMaximumAttempts(0), 3);

const protectedMessageLimit = 3 + 20 + 1;
assert.equal(shouldRunSessionCompactionPreflight({
  messageCount: 8,
  roughHistoryTokens: 70_000,
  protectFirstMessages: 3,
  protectLastMessages: 20,
  thresholdTokens: 64_000,
}), true, 'a few very large messages must pass the cheap gate');
assert.equal(shouldRunSessionCompactionPreflight({
  messageCount: 1,
  roughHistoryTokens: 63_000,
  protectFirstMessages: 3,
  protectLastMessages: 20,
  thresholdTokens: 64_000,
}), false);
assert.equal(shouldRunSessionCompactionPreflight({
  messageCount: protectedMessageLimit + 1,
  roughHistoryTokens: 1,
  protectFirstMessages: 3,
  protectLastMessages: 20,
  thresholdTokens: 64_000,
}), true, 'message count remains an OR hint, never a safety verdict');

const pressureBudget = createSessionCompactionBudget({
  contextWindowTokens: 262_000,
  outputReserveTokens: 8_192,
  fixedRequestTokens: 20_000,
});
const pressureAtThreshold = evaluateSessionCompactionPressure({
  budget: pressureBudget,
  messageCount: 8,
  roughHistoryTokens: pressureBudget.triggerTokens,
  authoritativeNextRequestTokens:
    pressureBudget.outputReserveTokens
    + pressureBudget.fixedRequestTokens
    + pressureBudget.triggerTokens,
  providerActualInputTokens: 100_000,
});
assert.equal(pressureAtThreshold.shouldCompact, true);
assert.equal(pressureAtThreshold.providerActualInputTokens, 100_000);
assert.equal(
  pressureAtThreshold.authoritativeHistoryTokens,
  pressureBudget.triggerTokens,
  'provider actual must not replace the authoritative next-request estimate',
);
assert.equal(evaluateSessionCompactionPressure({
  budget: pressureBudget,
  messageCount: 1,
  roughHistoryTokens: 1,
  authoritativeNextRequestTokens: null,
  providerActualInputTokens: 250_000,
}).shouldCompact, false, 'a previous provider actual cannot trigger a decision without the next request');
assert.equal(evaluateSessionCompactionPressure({
  budget: pressureBudget,
  messageCount: 1,
  roughHistoryTokens: 1,
  authoritativeNextRequestTokens: pressureBudget.contextWindowTokens + 1,
}).hardRequestLimitExceeded, true);

assert.equal(sessionCompactionMadeProgress({
  originalMessageCount: 10, newMessageCount: 5, originalTokens: 1_000, newTokens: 1_000,
}), true);
assert.equal(sessionCompactionMadeProgress({
  originalMessageCount: 10, newMessageCount: 10, originalTokens: 1_000, newTokens: 970,
}), false);
assert.equal(sessionCompactionMadeProgress({
  originalMessageCount: 10, newMessageCount: 10, originalTokens: 1_000, newTokens: 950,
}), false, 'exactly five percent is not greater than five percent');
assert.equal(sessionCompactionMadeProgress({
  originalMessageCount: 10, newMessageCount: 10, originalTokens: 1_000, newTokens: 940,
}), true);
assert.equal(sessionCompactionWarrantsAnotherPass({
  originalTokens: 400_000, newTokens: 350_000, thresholdTokens: 272_000,
}), true);
assert.equal(sessionCompactionWarrantsAnotherPass({
  originalTokens: 350_000, newTokens: 345_000, thresholdTokens: 272_000,
}), false);
assert.equal(sessionCompactionWarrantsAnotherPass({
  originalTokens: 400_000, newTokens: 250_000, thresholdTokens: 272_000,
}), false, 'a request already below threshold does not need another pass');

console.log('session-compaction-v2-policy-test: ok');
