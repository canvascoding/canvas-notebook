import assert from 'node:assert/strict';
import { nativeAcceptanceBudgets, nativeOuterPhaseTimeoutMs } from './helpers/chat-extension-native-budgets.mjs';

assert.equal(nativeOuterPhaseTimeoutMs('chat'), 17 * 60_000);
for (const phase of ['agent-create', 'agent-edit', 'agent-package-policy', 'my-connection', 'visual']) {
  assert.equal(nativeOuterPhaseTimeoutMs(phase), 12 * 60_000);
}
assert.throws(() => nativeOuterPhaseTimeoutMs('unknown'));
assert.equal(nativeAcceptanceBudgets.testMs, 60 * 60_000);
assert.equal(nativeAcceptanceBudgets.launcherMs, 65 * 60_000);
assert(nativeAcceptanceBudgets.launcherMs > nativeAcceptanceBudgets.testMs);
assert.throws(() => { nativeAcceptanceBudgets.testMs = 0; });
console.log('PASS Native outer chat/other phase budgets, total test/launcher bounds and immutable configuration.');
