import assert from 'node:assert/strict';
import { assertNativeTitleSdkProofs, nativeSqlTitleTextFingerprint, type NativeExpectedTitleTurn } from './helpers/chat-extension-native-sdk-proof';

const nonce = '0123456789abcdef0123456789abcdef';
const expected: NativeExpectedTitleTurn[] = [
  { platform: 'ios', toolkit: 'github', clientMessageId: 'original-ios-cid',
    ...nativeSqlTitleTextFingerprint([{ type: 'text', text: `PAGE-NATIVE-${nonce}-ios-github [GitHub](owned) ` }]) },
  { platform: 'android', toolkit: 'slack', clientMessageId: 'original-android-cid',
    ...nativeSqlTitleTextFingerprint(`PAGE-NATIVE-${nonce}-android-slack ${'x'.repeat(1300)}`) },
];
const captures = () => expected.map(({ clientMessageId: _cid, ...row }) => ({ ...row, exactTitlePrompt: true, maxTokens: 32, temperature: 0.2 }));
assert.notEqual(expected[0].sourceTextSha256, expected[0].textSha256, 'Product array trimming affects only the auxiliary title digest.');
assert.equal(expected[1].textUtf16Length, 1200); assert(expected[1].sourceTextUtf16Length > 1200);
assert.deepEqual(assertNativeTitleSdkProofs(captures(), expected).map(row => row.clientMessageId), expected.map(row => row.clientMessageId));
let cases = 1;
const rejects = (label: string, run: () => unknown) => { assert.throws(run, label); cases++; };
const changed = (label: string, mutate: (rows: ReturnType<typeof captures>) => void) => rejects(label, () => {
  const rows = captures(); mutate(rows); assertNativeTitleSdkProofs(rows, expected);
});
rejects('Missing auxiliary request', () => assertNativeTitleSdkProofs(captures().slice(1), expected));
rejects('Unexpected third auxiliary request', () => assertNativeTitleSdkProofs([...captures(), captures()[0]], expected));
changed('Duplicate iOS cannot replace Android', rows => { rows[1] = { ...rows[0] }; });
changed('Duplicate Android cannot replace iOS', rows => { rows[0] = { ...rows[1] }; });
changed('Wrong toolkit', rows => { rows[0].toolkit = 'slack'; });
changed('Foreign source digest', rows => { rows[0].sourceTextSha256 = 'a'.repeat(64); });
changed('Truncated source length', rows => { rows[1].sourceTextUtf16Length = 1200; });
changed('Different normalized title digest', rows => { rows[0].textSha256 = rows[0].sourceTextSha256; });
changed('Different normalized title length', rows => { rows[0].textUtf16Length++; });
changed('Unbounded title', rows => { rows[1].textUtf16Length = 1201; });
changed('Missing exact-prompt proof', rows => { (rows[0] as Record<string, unknown>).exactTitlePrompt = false; });
changed('Unbounded token request', rows => { rows[0].maxTokens = 33; });
changed('Wrong temperature', rows => { rows[0].temperature = 0.3; });
changed('A title cannot double-classify as a chat turn', rows => { (rows[0] as Record<string, unknown>).nativeCurrentTurn = {}; });
changed('Unknown proof fields rejected', rows => { (rows[0] as Record<string, unknown>).arbitrary = true; });
rejects('Duplicate original CID', () => assertNativeTitleSdkProofs(captures(), expected.map(row => ({ ...row, clientMessageId: 'same' }))));
rejects('Duplicate original source', () => assertNativeTitleSdkProofs(captures(), expected.map(row => ({ ...row, sourceTextSha256: expected[0].sourceTextSha256 }))));
rejects('Incorrect expected platform/toolkit pairing', () => assertNativeTitleSdkProofs(captures(), [{ ...expected[0], toolkit: 'slack' }, expected[1]]));
rejects('Null captures', () => assertNativeTitleSdkProofs(null, expected));
rejects('Malformed captures', () => assertNativeTitleSdkProofs([null, null], expected));
console.log(`PASS ${cases} independent auxiliary title-proof cases: exactly two titles bound to original Journey SQL text, product trim/UTF16 cap, unique OS/CID and strict prompt/token/temperature; six original chat-proof gates unchanged.`);
