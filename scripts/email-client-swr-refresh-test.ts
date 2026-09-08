import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  claimEmailCacheFollowUp,
  emailCacheFollowUpKey,
  emailMessageDetailScopeKey,
  parseEmailClientCacheMetadata,
  shouldApplyEmailRefresh,
} from '../app/lib/email/reader-refresh';

const staleCache = {
  state: 'stale',
  refreshQueued: true,
  generation: 7,
  fetchedAt: '2026-09-08T10:00:00.000Z',
  staleAt: '2026-09-08T10:01:00.000Z',
};

assert.deepEqual(parseEmailClientCacheMetadata(staleCache), staleCache);
assert.equal(parseEmailClientCacheMetadata(null), null);
assert.equal(parseEmailClientCacheMetadata({ state: 'unknown', refreshQueued: true }), null);
assert.equal(emailCacheFollowUpKey('list-scope', { ...staleCache, state: 'fresh' }), null);
assert.equal(emailCacheFollowUpKey('list-scope', { ...staleCache, refreshQueued: false }), null);

const stableKey = emailCacheFollowUpKey('list-scope', staleCache);
assert.ok(stableKey);
assert.equal(stableKey, emailCacheFollowUpKey('list-scope', { ...staleCache, expiresAt: 'later' }));
assert.notEqual(stableKey, emailCacheFollowUpKey('other-scope', staleCache));
assert.notEqual(stableKey, emailCacheFollowUpKey('list-scope', { ...staleCache, generation: 8 }));
assert.notEqual(stableKey, emailCacheFollowUpKey('list-scope', { ...staleCache, fetchedAt: '2026-09-08T10:02:00.000Z' }));
assert.notEqual(stableKey, emailCacheFollowUpKey('list-scope', { ...staleCache, staleAt: '2026-09-08T10:03:00.000Z' }));

const seen = new Set<string>();
assert.equal(claimEmailCacheFollowUp(seen, stableKey), true);
assert.equal(claimEmailCacheFollowUp(seen, stableKey), false, 'one cache identity may schedule only once');
assert.equal(claimEmailCacheFollowUp(seen, null), false);
for (let index = 0; index < 5; index += 1) {
  claimEmailCacheFollowUp(seen, `key-${index}`, 3);
}
assert.equal(seen.size, 3, 'the identity guard must remain bounded');

assert.equal(shouldApplyEmailRefresh({
  requestEpoch: 3,
  currentEpoch: 3,
  mutationRevision: 4,
  currentMutationRevision: 4,
  mutationInFlight: false,
}), true);
assert.equal(shouldApplyEmailRefresh({
  requestEpoch: 2,
  currentEpoch: 3,
  mutationRevision: 4,
  currentMutationRevision: 4,
  mutationInFlight: false,
}), false, 'superseded requests must not apply');
assert.equal(shouldApplyEmailRefresh({
  requestEpoch: 3,
  currentEpoch: 3,
  mutationRevision: 3,
  currentMutationRevision: 4,
  mutationInFlight: false,
}), false, 'responses predating an optimistic mutation must not apply');
assert.equal(shouldApplyEmailRefresh({
  requestEpoch: 3,
  currentEpoch: 3,
  mutationRevision: 4,
  currentMutationRevision: 4,
  mutationInFlight: true,
}), false, 'responses must not apply while a mutation is running');

assert.equal(emailMessageDetailScopeKey({
  accountId: 'account:1',
  folder: 'Folder/With Spaces',
  messageId: 'imap:v1:opaque/id',
}), '["account:1","Folder/With Spaces","imap:v1:opaque/id"]');

async function sourceContractTests() {
  const source = await readFile(new URL('../app/apps/email/components/EmailClient.tsx', import.meta.url), 'utf8');
  const refreshStart = source.indexOf('const refreshSelectedMessage');
  const listStart = source.indexOf('const loadMessages');
  const markReadStart = source.indexOf('const markMessageReadOnOpen');
  const detailStart = source.indexOf('const loadMessage =');
  const effectsStart = source.indexOf('useEffect(() => {', detailStart);
  const refreshSource = source.slice(refreshStart, listStart);
  const listSource = source.slice(listStart, markReadStart);
  const detailSource = source.slice(detailStart, effectsStart);

  assert.match(listSource, /scheduleListFollowUp\(scopeKey, payload\.data\?\.cache, requestEpoch\)/u);
  assert.match(listSource, /if \(!options\?\.swrFollowUp\) void refreshSelectedMessage\(\)/u,
    'the stale-list follow-up must not cascade into a detail refresh');
  assert.match(listSource, /shouldApplyEmailRefresh/u);
  assert.match(refreshSource, /scheduleDetailFollowUp/u);
  assert.match(refreshSource, /shouldApplyEmailRefresh/u);
  assert.doesNotMatch(refreshSource, /markMessageReadOnOpen/u,
    'detail follow-ups must never repeat mark-read-on-open');
  assert.match(detailSource, /scheduleDetailFollowUp/u);
  assert.match(detailSource, /markMessageReadOnOpen/u,
    'the initial open path must retain its single mark-read behavior');
  assert.match(source, /cancelListFollowUp\(\);\s+listRequestEpochRef\.current \+= 1;\s+listRequestRef\.current\?\.abort\(\);/u,
    'scope changes must invalidate list timers and requests');
  assert.match(source, /cancelDetailFollowUp\(\);\s+detailRequestEpochRef\.current \+= 1;/u,
    'reader changes must invalidate detail timers');
  assert.match(source, /pendingDetailFollowUpRef\.current/u,
    'a follow-up blocked by mark-read must resume after the mutation completes');
}

sourceContractTests().then(() => {
  console.log('email client SWR refresh tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
