import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openedDocumentRetentionLimits, planOpenedDocumentRetention,
  type OpenedDocumentRetentionCandidate } from '../app/lib/collaboration/open-document-retention';

const now = 600_000;
const candidate = (key: string, overrides: Partial<OpenedDocumentRetentionCandidate> = {}): OpenedDocumentRetentionCandidate => ({
  key, active: false, open: true, authCurrent: true, canKeepWarm: true, canKeepLive: true,
  encodedBytes: 64 * 1024, lastActivatedAt: now - 1000, backgroundSince: now - 1000, ...overrides,
});
const plan = (candidates: OpenedDocumentRetentionCandidate[], constrained = false, hiddenSince?: number) =>
  planOpenedDocumentRetention({ candidates, constrained, now, hiddenSince });

test('desktop and constrained policies cap background lives and additional warm documents globally', () => {
  const documents = [candidate('visible', { active: true }), ...Array.from({ length: 20 }, (_, index) =>
    candidate(`workspace-${index % 3}/document-${index}`, { lastActivatedAt: now - index }))];
  for (const constrained of [false, true]) {
    const result = plan(documents, constrained);
    assert.equal(result.activeDocuments, 1);
    assert.equal(result.backgroundLiveDocuments, constrained ? 1 : 4);
    assert.equal(result.warmDocuments, constrained ? 5 : 10);
    assert.equal(result.decisions.filter(item => item.tier === 'release').length, constrained ? 14 : 6);
    assert.equal(result.decisions.find(item => item.key === 'workspace-0/document-0')?.tier, 'live');
    assert.equal(result.decisions.find(item => item.key === 'workspace-1/document-19')?.tier, 'release');
  }
});

test('LRU selection does not depend on input order and reserves a non-text active editor slot', () => {
  const documents = Array.from({ length: 7 }, (_, index) => candidate(String(index), { lastActivatedAt: now - index }));
  const first = plan(documents), second = plan([...documents].reverse());
  assert.deepEqual(new Map(first.decisions.map(item => [item.key, item.tier])), new Map(second.decisions.map(item => [item.key, item.tier])));
  assert.equal(first.backgroundLiveDocuments, 4);
  assert.equal(first.decisions.find(item => item.key === '4')?.tier, 'warm');
});

test('background bytes are shared across workspaces while oversized active documents remain usable', () => {
  const documents = [candidate('large-active', { active: true, encodedBytes: 20 * 1024 * 1024 }),
    ...Array.from({ length: 14 }, (_, index) => candidate(`workspace-${index}/large`, {
      encodedBytes: 1024 * 1024, lastActivatedAt: now - index,
    }))];
  for (const constrained of [false, true]) {
    const result = plan(documents, constrained);
    assert.equal(result.decisions[0].tier, 'active');
    assert.equal(result.backgroundEncodedBytes, (constrained ? 4 : 8) * 1024 * 1024);
    assert.equal(result.warmDocuments, constrained ? 3 : 4);
  }
  assert.equal(plan([candidate('large-background', { encodedBytes: 1024 * 1024 + 1 })]).decisions[0].tier, 'release');
});

test('five-minute inactivity and two-minute hidden boundary remove background networking', () => {
  assert.equal(plan([candidate('recent', { backgroundSince: now - 300_000 + 1 })]).decisions[0].tier, 'live');
  assert.equal(plan([candidate('expired', { backgroundSince: now - 300_000 })]).decisions[0].tier, 'warm');
  assert.equal(plan([candidate('hidden')], false, now - 120_000 + 1).decisions[0].tier, 'live');
  assert.equal(plan([candidate('hidden')], false, now - 120_000).decisions[0].tier, 'warm');
});

test('closed or wrong-auth documents receive no background lease; a disconnected cache cannot create a live lease', () => {
  const result = plan([candidate('closed', { open: false }), candidate('old-session', { authCurrent: false }),
    candidate('no-local-state', { canKeepWarm: false }), candidate('warm-only', { canKeepLive: false })]);
  assert.deepEqual(result.decisions.map(item => item.tier), ['release', 'release', 'release', 'warm']);
  // Retaining the mounted recovery surface does not authorize any networking.
  assert.equal(plan([candidate('active-old-auth', { active: true, authCurrent: false })]).backgroundLiveDocuments, 0);
});

test('invalid resource observations cannot obtain a background lease and ambiguous keys fail explicitly', () => {
  for (const invalid of [candidate('invalid-bytes', { encodedBytes: NaN }), candidate('negative-bytes', { encodedBytes: -1 }),
    candidate('invalid-clock', { lastActivatedAt: NaN }), candidate('future-clock', { backgroundSince: now + 1 })]) {
    assert.equal(plan([invalid]).decisions[0].tier, 'release');
  }
  assert.equal(plan([candidate('future-hidden')], false, now + 1).decisions[0].tier, 'warm');
  assert.throws(() => plan([candidate('duplicate'), candidate('duplicate')]), /unique/u);
  assert(Object.isFrozen(openedDocumentRetentionLimits(false)));
  assert(Object.isFrozen(openedDocumentRetentionLimits(true)));
});
