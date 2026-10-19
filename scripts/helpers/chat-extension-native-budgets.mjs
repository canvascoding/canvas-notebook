import assert from 'node:assert/strict';

export const nativeAcceptanceBudgets = Object.freeze({ testMs: 60 * 60_000, launcherMs: 65 * 60_000 });
export function nativeOuterPhaseTimeoutMs(phase) {
  assert(['chat', 'agent-create', 'agent-edit', 'agent-package-policy', 'my-connection', 'visual'].includes(phase), 'Choose a known native acceptance phase.');
  return (phase === 'chat' ? 17 : 12) * 60_000;
}
