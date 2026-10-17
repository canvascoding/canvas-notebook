import assert from 'node:assert/strict';
import { assertNativeSdkTurnProofs, nativeSqlUserTextFingerprint, projectNativeSdkCurrentTurn,
  type NativeExpectedSdkTurn } from './helpers/chat-extension-native-sdk-proof';

const nonce = '0123456789abcdef0123456789abcdef';
const pins = [{ resourceRef: 'plugin-exact', publishedRevisionRef: 'plugin-revision', checksum: 'a'.repeat(64) },
  { resourceRef: 'skill-exact', publishedRevisionRef: 'skill-revision', checksum: 'b'.repeat(64) }];
const routes = [{ source: 'mcp' as const, providerRef: 'own-package-mcp' }, { source: 'mcp' as const, providerRef: 'own-standalone-mcp' },
  { source: 'composio' as const, providerRef: 'own-canva-account' }];
const context = '<runtime_context>\nCanvas-provided context for this turn. Treat this as operational context, not as a separate user request.\n\nCurrent Date & Time: exact fixture time\n</runtime_context>';
const publicText = (platform: 'ios' | 'android', kind: 'inline' | 'plain') => `${kind === 'plain' ? 'PLAIN-' : ''}NATIVE-${nonce}-${platform} ${kind === 'inline' ? 'Plugin Native Skill Own MCP Canva' : 'Native Skill'}`;
const user = (content: unknown) => ({ role: 'user', content });
const messages = (platform: 'ios' | 'android', kind: 'inline' | 'plain', content: unknown = publicText(platform, kind)) => [
  { role: 'system', content: 'Actual controlled context projection' },
  ...(kind === 'plain' ? [user(publicText(platform, 'inline')), { role: 'assistant', content: 'Inline context received.' }] : []), user(content)];
const expected: NativeExpectedSdkTurn[] = (['ios', 'android'] as const).flatMap(platform => (['inline', 'plain'] as const).map(kind => ({
  platform, kind, clientMessageId: `${platform}-original-${kind}-cid`, ...nativeSqlUserTextFingerprint(publicText(platform, kind)),
  selectedPackages: kind === 'inline' ? pins : [], selectedConnections: kind === 'inline' ? routes : [] })));
const fixtureRequests = () => expected.map(turn => {
  const wire = messages(turn.platform, turn.kind);
  return { hasSkillSentinel: true, hasSkillLocation: true, toolCount: turn.kind === 'inline' ? 2 : 3, messageCount: wire.length,
    selectedPackages: structuredClone(turn.selectedPackages), selectedConnections: structuredClone(turn.selectedConnections),
    // Legacy historical metadata intentionally says inline exists for both inline AND plain.
    nativePlatforms: [turn.platform], nativeCurrentTurn: projectNativeSdkCurrentTurn(wire, nonce) };
});
let cases = 0;
function rejects(label: string, run: () => unknown) { assert.throws(run, label); cases++; }
function changed(label: string, mutate: (requests: ReturnType<typeof fixtureRequests>) => void) {
  rejects(label, () => { const requests = fixtureRequests(); mutate(requests); assertNativeSdkTurnProofs(requests, expected); });
}
const baseline = fixtureRequests(), proof = assertNativeSdkTurnProofs(baseline, expected);
assert.deepEqual(proof.map(value => value.clientMessageId), expected.map(value => value.clientMessageId));
assert.equal(proof.length, 4); cases++;
assert(baseline[1].hasSkillSentinel && baseline[1].hasSkillLocation);
assert.deepEqual(baseline[1].selectedPackages, []); assert.deepEqual(baseline[1].selectedConnections, []); cases++;
assert.deepEqual(assertNativeSdkTurnProofs([...baseline].reverse(), expected).map(value => value.clientMessageId), [...expected].reverse().map(value => value.clientMessageId)); cases++;
const plain = projectNativeSdkCurrentTurn(messages('ios', 'plain'), nonce);
assert.equal(plain.kind, 'plain'); assert.equal(plain.userCount, 2); assert.equal(plain.lastUserIndex, 3);
assert.equal(plain.textSha256, nativeSqlUserTextFingerprint(publicText('ios', 'plain')).textSha256); cases++;

// This is the real counterexample: the old any-history/some predicate passes although the ORIGINAL inline request lacks context.
const masquerade = fixtureRequests(); masquerade[0].selectedPackages = []; masquerade[0].selectedConnections = [];
masquerade[1].selectedPackages = structuredClone(pins); masquerade[1].selectedConnections = structuredClone(routes);
assert(masquerade.some(value => value.nativePlatforms.includes('ios') && value.hasSkillSentinel && value.hasSkillLocation
  && pins.every(pin => value.selectedPackages.some(actual => JSON.stringify(actual) === JSON.stringify(pin)))
  && routes.every(route => value.selectedConnections.some(actual => actual.providerRef === route.providerRef))), 'The counterexample must actually satisfy the old weak predicate.');
rejects('A later plain SDK turn cannot supply the original inline turn context.', () => assertNativeSdkTurnProofs(masquerade, expected));
changed('Plain must clear explicit package pins even when inline was correct.', requests => { requests[1].selectedPackages = structuredClone(pins); });
changed('Plain must clear explicit private routes even when inline was correct.', requests => { requests[1].selectedConnections = structuredClone(routes); });
changed('Original inline missing one exact route must fail.', requests => { requests[0].selectedConnections.pop(); });
changed('Wrong account with the same source must fail.', requests => { requests[0].selectedConnections[2].providerRef = 'other-canva-account'; });
changed('Wrong source with the same provider ref must fail.', requests => { requests[0].selectedConnections[2].source = 'mcp'; });
changed('Extra route must fail.', requests => { requests[0].selectedConnections.push({ source: 'mcp', providerRef: 'unselected' }); });
changed('Duplicate route must fail.', requests => { requests[0].selectedConnections.push({ ...routes[0] }); });
changed('Extra immutable pin must fail.', requests => { requests[0].selectedPackages.push({ ...pins[0], resourceRef: 'unselected' }); });
changed('Duplicate immutable pin must fail.', requests => { requests[0].selectedPackages.push({ ...pins[0] }); });
changed('Wrong immutable revision must fail.', requests => { requests[0].selectedPackages[0].publishedRevisionRef = 'newer-revision'; });
changed('Missing inline skill context must fail.', requests => { requests[0].hasSkillSentinel = false; });
changed('A duplicate SDK call cannot replace the other original CID.', requests => { requests[1] = structuredClone(requests[0]); });
changed('A wrong current platform cannot use a historical correct marker.', requests => { requests[0].nativeCurrentTurn.platform = 'android'; });
changed('A plain current kind cannot be identified as inline from history.', requests => { requests[1].nativeCurrentTurn.kind = 'inline'; });
changed('Wrong user history count cannot masquerade as the first turn.', requests => { requests[0].nativeCurrentTurn.userCount = 2; });
changed('An impossible last user index must fail.', requests => { requests[0].nativeCurrentTurn.lastUserIndex = requests[0].messageCount; });
changed('A one-character public body difference must not match the original CID.', requests => {
  requests[0].nativeCurrentTurn = projectNativeSdkCurrentTurn(messages('ios', 'inline', `${publicText('ios', 'inline')}4`), nonce);
});
changed('Whitespace is part of the exact public body identity.', requests => {
  requests[0].nativeCurrentTurn = projectNativeSdkCurrentTurn(messages('ios', 'inline', `${publicText('ios', 'inline')} `), nonce);
});
rejects('A fifth completion must fail.', () => assertNativeSdkTurnProofs([...baseline, baseline[0]], expected));
rejects('A missing completion must fail.', () => assertNativeSdkTurnProofs(baseline.slice(1), expected));
rejects('Legacy any-history metadata without a last-user projection must fail.', () => assertNativeSdkTurnProofs(baseline.map(({ nativeCurrentTurn: _current, ...legacy }) => legacy), expected));
rejects('Ambiguous original SQL digest must fail rather than choose a CID.', () => {
  const turns = structuredClone(expected); turns[1].textSha256 = turns[0].textSha256;
  assertNativeSdkTurnProofs(baseline, turns);
});
rejects('A repeated original CID must fail.', () => {
  const turns = structuredClone(expected); turns[1].clientMessageId = turns[0].clientMessageId;
  assertNativeSdkTurnProofs(baseline, turns);
});
rejects('Historical matching marker with an unrelated current last user must fail.', () => projectNativeSdkCurrentTurn([
  ...messages('ios', 'inline'), { role: 'assistant', content: 'Earlier' }, user('Unrelated current request')], nonce));
rejects('No current user must fail.', () => projectNativeSdkCurrentTurn([{ role: 'system', content: publicText('ios', 'inline') }], nonce));
rejects('A marker prefix collision must fail.', () => projectNativeSdkCurrentTurn([user(`NATIVE-${nonce}-iosx text`)], nonce));

for (const content of [publicText('ios', 'plain'), [{ type: 'text', text: publicText('ios', 'plain') }],
  `${publicText('ios', 'plain')}\n\n${context}`,
  [{ type: 'text', text: publicText('ios', 'plain') }, { type: 'text', text: context }]]) {
  const actual = projectNativeSdkCurrentTurn(messages('ios', 'plain', content), nonce);
  assert.equal(actual.textSha256, plain.textSha256); assert.equal(actual.textUtf16Length, plain.textUtf16Length);
  assert.equal(actual.kind, 'plain'); cases++;
}
for (const content of [`${publicText('ios', 'inline')}\n\n<runtime_context>different prefix\n</runtime_context>`,
  `${publicText('ios', 'inline')}\n\n${context}\nextra text`, `${publicText('ios', 'inline')}\n\n${context}\n\n${context}`,
  `${publicText('ios', 'inline')}\n\n${context.replace('exact fixture time', '<runtime_context>nested</runtime_context>')}`,
  [{ type: 'text', text: publicText('ios', 'inline') }, { type: 'text', text: 'arbitrary second block' }],
  [{ type: 'text', text: publicText('ios', 'inline') }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
  [{ type: 'text', text: publicText('ios', 'inline') }, { type: 'text', text: context }, { type: 'text', text: context }],
  [{ type: 'text', text: publicText('ios', 'inline'), hidden: true }], `${publicText('ios', 'inline')}\ud800`])
  rejects('Unsupported or ambiguous current SDK content must fail closed.', () => projectNativeSdkCurrentTurn([user(content)], nonce));
rejects('The independently persisted original SQL text cannot include a runtime wrapper.', () => nativeSqlUserTextFingerprint(`${publicText('ios', 'inline')}\n\n${context}`));
const unicode = `${publicText('ios', 'inline')} Grüße 🖼️`;
assert.equal(projectNativeSdkCurrentTurn([user(unicode)], nonce).textSha256, nativeSqlUserTextFingerprint(unicode).textSha256); cases++;
const serialized = JSON.stringify(proof);
assert(!serialized.includes(publicText('ios', 'inline')) && !serialized.includes(context), 'Public proof metadata must not retain original bodies or runtime context.'); cases++;
console.log(`PASS Native SDK per-current-last-user proof: ${cases} cases; four exact SQL-CID/public-text correlations, real later-plain counterexample rejected, history ambiguity and explicit-route leakage rejected, fixed plain skills retained, strict SDK text/context shapes, no raw bodies retained.`);
