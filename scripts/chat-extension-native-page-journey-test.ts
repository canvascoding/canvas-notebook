import assert from 'node:assert/strict';
import { nativePageConsentReturnSource } from './helpers/chat-extension-native-consent-policy.mjs';
import { assertNativePageJourneySdkProofs, nativeSqlUserTextFingerprint, projectNativePageJourneyCurrentTurn,
  type NativeExpectedPageJourneyTurn } from './helpers/chat-extension-native-sdk-proof';

const nonce = '0123456789abcdef0123456789abcdef';
const turns: NativeExpectedPageJourneyTurn[] = (['ios', 'android'] as const).map(platform => {
  const toolkit = platform === 'ios' ? 'github' : 'slack';
  const text = `PAGE-NATIVE-${nonce}-${platform}-${toolkit} ${toolkit === 'github' ? 'GitHub' : 'Slack'}`;
  return { platform, toolkit, clientMessageId: `page-${platform}-original`, ...nativeSqlUserTextFingerprint(text),
    selectedConnection: { source: 'composio', providerRef: `exact-new-${toolkit}-account` } };
});
const text = (index: number) => `PAGE-NATIVE-${nonce}-${turns[index].platform}-${turns[index].toolkit} ${index === 0 ? 'GitHub' : 'Slack'}`;
const requests = () => turns.map((turn, index) => ({ messageCount: 2, selectedPackages: [], selectedConnections: [turn.selectedConnection],
  nativePageJourneyTurn: projectNativePageJourneyCurrentTurn([{ role: 'system', content: 'Controlled' }, { role: 'user', content: text(index) }], nonce)! }));
let cases = 0;
assert.equal(assertNativePageJourneySdkProofs(requests(), turns).length, 2); cases++;
assert.equal(projectNativePageJourneyCurrentTurn([{ role: 'user', content: `NATIVE-${nonce}-ios Original inline` }], nonce), null); cases++;
assert.equal(projectNativePageJourneyCurrentTurn([{ role: 'user', content: 'Unrelated current text' }], nonce), null); cases++;
const context = '<runtime_context>\nCanvas-provided context for this turn. Treat this as operational context, not as a separate user request.\n\nExact fixture context\n</runtime_context>';
const projection = projectNativePageJourneyCurrentTurn([{ role: 'user', content: `${text(0)}\n\n${context}` }], nonce)!;
assert.equal(projection.textSha256, turns[0].textSha256); assert.equal(projection.runtimeContextAppended, true); cases++;
const blockProjection = projectNativePageJourneyCurrentTurn([{ role: 'user', content: [{ type: 'text', text: text(0) }, { type: 'text', text: context }] }], nonce)!;
assert.equal(blockProjection.textSha256, turns[0].textSha256); cases++;
function rejects(run: () => unknown) { assert.throws(run); cases++; }
function changed(mutate: (rows: ReturnType<typeof requests>) => void) { rejects(() => { const rows = requests(); mutate(rows); assertNativePageJourneySdkProofs(rows, turns); }); }
rejects(() => projectNativePageJourneyCurrentTurn([{ role: 'user', content: text(0) }, { role: 'user', content: text(0) }], nonce));
changed(rows => { rows[0].selectedConnections[0] = { source: 'composio', providerRef: 'earlier-authorized-account' }; });
changed(rows => { rows[0].selectedConnections = []; });
changed(rows => { rows[0].selectedConnections.push(rows[0].selectedConnections[0]); });
changed(rows => { rows[0].nativePageJourneyTurn.userCount = 2 as 1; });
changed(rows => { rows[0].nativePageJourneyTurn.lastUserIndex = rows[0].messageCount; });
changed(rows => { rows[1] = structuredClone(rows[0]); });
changed(rows => { rows[0].nativePageJourneyTurn.platform = 'android'; });
changed(rows => { rows[0].nativePageJourneyTurn.textSha256 = 'c'.repeat(64); });
changed(rows => { Object.assign(rows[0], { nativeCurrentTurn: {} }); });
rejects(() => assertNativePageJourneySdkProofs(requests().slice(0, 1), turns));
rejects(() => assertNativePageJourneySdkProofs([...requests(), requests()[0]], turns));
rejects(() => assertNativePageJourneySdkProofs(requests(), [turns[0], { ...turns[1], clientMessageId: turns[0].clientMessageId }]));
const callback = `http://127.0.0.1:3001/api/composio/callback?flow=${'a'.repeat(43)}`;
assert.equal(nativePageConsentReturnSource(callback, 'github', undefined), ''); cases++;
assert.equal(nativePageConsentReturnSource(callback, 'canva', 'canvasnotebook-dev'), ''); cases++;
assert.equal(nativePageConsentReturnSource(callback, 'github', 'canvasnotebook-dev'), ' canvasnotebook-dev:'); cases++;
assert.equal(nativePageConsentReturnSource(callback, 'slack', 'canvasnotebook-dev'), ' canvasnotebook-dev:'); cases++;
for (const bad of [callback.replace('127.0.0.1', 'localhost'), callback.replace(':3001', ':3002'), callback.replace('/callback?', '/shared/callback?'),
  `${callback}&extra=1`, `${callback}#fragment`, `${callback}&flow=${'a'.repeat(43)}`, callback.replace('flow=', 'state='), callback.replace('http:', 'https:'),
  callback.replace('http://', 'http://user:password@'), callback.slice(0, -1)]) rejects(() => nativePageConsentReturnSource(bad, 'github', 'canvasnotebook-dev'));
rejects(() => nativePageConsentReturnSource(callback, 'github', 'foreign-app'));
console.log(`Native page journey SDK and consent-policy regressions passed (${cases} cases).`);
