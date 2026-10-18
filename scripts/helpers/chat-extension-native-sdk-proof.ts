import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().min(1).max(512), sha = z.string().regex(/^[a-f0-9]{64}$/u);
const platform = z.enum(['ios', 'android']), kind = z.enum(['inline', 'plain']);
const packagePin = z.object({ resourceRef: identifier, publishedRevisionRef: identifier, checksum: sha }).strict();
const connection = z.object({ source: z.enum(['mcp', 'composio']), providerRef: identifier }).strict();
const fingerprint = z.object({ textSha256: sha, textUtf16Length: z.number().int().positive().max(1_048_576) });
const currentTurn = fingerprint.extend({ platform, kind, lastUserIndex: z.number().int().nonnegative(),
  userCount: z.number().int().positive(), runtimeContextAppended: z.boolean() }).strict();
const expectedTurn = fingerprint.extend({ platform, kind, clientMessageId: identifier,
  selectedPackages: z.array(packagePin), selectedConnections: z.array(connection) }).strict();
const completion = z.object({ hasSkillSentinel: z.boolean(), hasSkillLocation: z.boolean(), messageCount: z.number().int().positive(),
  selectedPackages: z.array(packagePin), selectedConnections: z.array(connection), nativeCurrentTurn: currentTurn }).passthrough();
export type NativeSdkCurrentTurn = z.infer<typeof currentTurn>;
export type NativeExpectedSdkTurn = z.infer<typeof expectedTurn>;
const pageTurn = fingerprint.extend({ platform, toolkit: z.enum(['github', 'slack']), lastUserIndex: z.number().int().nonnegative(),
  userCount: z.literal(1), runtimeContextAppended: z.boolean() }).strict();
export type NativePageJourneyTurn = z.infer<typeof pageTurn>;
const expectedPageTurn = fingerprint.extend({ platform, toolkit: z.enum(['github', 'slack']), clientMessageId: identifier,
  selectedConnection: connection }).strict();
export type NativeExpectedPageJourneyTurn = z.infer<typeof expectedPageTurn>;

const runtimePrefix = '<runtime_context>\nCanvas-provided context for this turn. Treat this as operational context, not as a separate user request.\n\n';
const runtimeEnd = '\n</runtime_context>';
const hasRuntimeTag = (text: string) => text.includes('<runtime_context') || text.includes('</runtime_context');
function assertRuntimeSuffix(text: string): void {
  assert(text.startsWith(runtimePrefix) && text.endsWith(runtimeEnd) && text.length > runtimePrefix.length + runtimeEnd.length,
    'The native fixture accepts only the exact appended Canvas runtime-context envelope.');
  const contents = text.slice(runtimePrefix.length, -runtimeEnd.length);
  assert(!hasRuntimeTag(contents), 'Nested or repeated runtime-context tags are ambiguous.');
}
function textBlock(value: unknown): string {
  const block = z.object({ type: z.literal('text'), text: z.string() }).strict().parse(value);
  return block.text;
}
function originalText(content: unknown): string {
  const text = typeof content === 'string' ? content : (() => {
    assert(Array.isArray(content) && content.length === 1, 'The native acceptance turn must contain exactly one original text block.');
    return textBlock(content[0]);
  })();
  assert(text.length > 0 && text.length <= 1_048_576 && !hasRuntimeTag(text), 'The original native fixture text must be bounded and unambiguous.');
  assert(Buffer.from(text, 'utf8').toString('utf8') === text, 'Invalid Unicode must not acquire a normalized text identity.');
  return text;
}
function textFingerprint(text: string): z.infer<typeof fingerprint> {
  return { textSha256: createHash('sha256').update(text, 'utf8').digest('hex'), textUtf16Length: text.length };
}
/** Correlates public text with an independently read original SQL CID; the SDK does not transmit that CID. */
export function nativeSqlUserTextFingerprint(content: unknown): z.infer<typeof fingerprint> {
  return textFingerprint(originalText(content));
}
/** Read only the actual last user message. Earlier historical markers never establish the current turn. */
export function projectNativeSdkCurrentTurn(messages: ReadonlyArray<{ role: string; content?: unknown }>, nonce: string): NativeSdkCurrentTurn {
  assert.match(nonce, /^[a-f0-9]{32}$/u);
  const users = messages.flatMap((message, index) => message.role === 'user' ? [{ content: message.content, index }] : []);
  const last = users.at(-1); assert(last, 'The native SDK request must contain a current user turn.');
  let content: unknown = last.content, runtimeContextAppended = false;
  if (typeof content === 'string' && hasRuntimeTag(content)) {
    const start = content.indexOf(`\n\n${runtimePrefix}`);
    assert(start > 0, 'Only the exact appended runtime context may be excluded from the public-text digest.');
    assertRuntimeSuffix(content.slice(start + 2)); content = content.slice(0, start); runtimeContextAppended = true;
  } else if (Array.isArray(content) && content.length === 2) {
    assertRuntimeSuffix(textBlock(content[1])); content = [content[0]]; runtimeContextAppended = true;
  }
  const text = originalText(content);
  const matches = (['ios', 'android'] as const).flatMap(platform => (['inline', 'plain'] as const).flatMap(kind => {
    const marker = `${kind === 'plain' ? 'PLAIN-' : ''}NATIVE-${nonce}-${platform}`;
    return text === marker || text.startsWith(`${marker} `) ? [{ platform, kind }] : [];
  }));
  assert.equal(matches.length, 1, 'The current last user turn must have one exact native fixture marker.');
  return { ...textFingerprint(text), ...matches[0], lastUserIndex: last.index, userCount: users.length, runtimeContextAppended };
}
function exactSet<T>(actual: T[], expected: T[], label: string): void {
  const actualKeys = actual.map(value => JSON.stringify(value)).sort(), expectedKeys = expected.map(value => JSON.stringify(value)).sort();
  assert.equal(new Set(actualKeys).size, actualKeys.length, `${label} must not contain duplicates.`);
  assert.equal(new Set(expectedKeys).size, expectedKeys.length, `Expected ${label} must be unique.`);
  assert.deepEqual(actualKeys, expectedKeys, `${label} must match the current original SQL turn exactly.`);
}
/** Fail closed on missing/extra/duplicate SDK calls or context delivered to a later, unrelated user turn. */
export function assertNativeSdkTurnProofs(actual: unknown, originalSqlTurns: readonly NativeExpectedSdkTurn[]) {
  const expected = z.array(expectedTurn).length(4).parse(originalSqlTurns), requests = z.array(completion).length(4).parse(actual);
  assert.equal(new Set(expected.map(turn => turn.clientMessageId)).size, 4, 'Each original SQL CID must be distinct.');
  assert.equal(new Set(expected.map(turn => turn.textSha256)).size, 4, 'Ambiguous public-text digests cannot establish original CID identity.');
  assert.deepEqual(expected.map(turn => `${turn.platform}:${turn.kind}`).sort(), ['android:inline', 'android:plain', 'ios:inline', 'ios:plain']);
  const matched = new Set<string>();
  return requests.map(request => {
    const current = request.nativeCurrentTurn, matches = expected.filter(turn => turn.textSha256 === current.textSha256
      && turn.textUtf16Length === current.textUtf16Length);
    assert.equal(matches.length, 1, 'The actual last-user text must identify exactly one independently validated original SQL CID.');
    const turn = matches[0]; assert(!matched.has(turn.clientMessageId), 'A repeated SDK request cannot replace a missing original turn.');
    matched.add(turn.clientMessageId);
    assert.equal(current.platform, turn.platform); assert.equal(current.kind, turn.kind);
    assert.equal(current.userCount, turn.kind === 'inline' ? 1 : 2, 'History cannot masquerade as the current native turn.');
    assert(current.lastUserIndex < request.messageCount, 'The current user index must belong to this actual SDK request.');
    assert.equal(turn.selectedPackages.length, turn.kind === 'inline' ? 2 : 0);
    assert.equal(turn.selectedConnections.length, turn.kind === 'inline' ? 3 : 0);
    exactSet(request.selectedPackages, turn.selectedPackages, 'Immutable package pins');
    exactSet(request.selectedConnections, turn.selectedConnections, 'Exact personal provider routes');
    if (turn.kind === 'inline') assert(request.hasSkillSentinel && request.hasSkillLocation, 'The original inline SDK turn must receive its skill context.');
    // Fixed relevantSkills legitimately remain available on the plain turn; only explicit turn packages/routes must clear.
    return { platform: turn.platform, kind: turn.kind, clientMessageId: turn.clientMessageId, textSha256: current.textSha256,
      lastUserIndex: current.lastUserIndex, userCount: current.userCount };
  });
}

/** Separate current-user identity for the two additional, UI-connected page journeys. */
export function projectNativePageJourneyCurrentTurn(messages: ReadonlyArray<{ role: string; content?: unknown }>, nonce: string): NativePageJourneyTurn | null {
  assert.match(nonce, /^[a-f0-9]{32}$/u);
  const users = messages.flatMap((message, index) => message.role === 'user' ? [{ content: message.content, index }] : []);
  const last = users.at(-1); assert(last);
  let content: unknown = last.content, runtimeContextAppended = false;
  if (typeof content === 'string' && hasRuntimeTag(content)) {
    const start = content.indexOf(`\n\n${runtimePrefix}`); assert(start > 0); assertRuntimeSuffix(content.slice(start + 2));
    content = content.slice(0, start); runtimeContextAppended = true;
  } else if (Array.isArray(content) && content.length === 2) {
    assertRuntimeSuffix(textBlock(content[1])); content = [content[0]]; runtimeContextAppended = true;
  }
  const text = originalText(content);
  const matches = (['ios', 'android'] as const).flatMap(platform => {
    const toolkit = platform === 'ios' ? 'github' as const : 'slack' as const;
    const marker = `PAGE-NATIVE-${nonce}-${platform}-${toolkit}`;
    return text === marker || text.startsWith(`${marker} `) ? [{ platform, toolkit }] : [];
  });
  if (!matches.length) return null;
  assert.equal(users.length, 1, 'The page handoff must create a separate fresh conversation.');
  return pageTurn.parse({ ...textFingerprint(text), ...matches[0], lastUserIndex: last.index, userCount: users.length, runtimeContextAppended });
}

/** Exactly two new captures supplement, and never substitute for, the original four-turn proof. */
export function assertNativePageJourneySdkProofs(actual: unknown, originalSqlTurns: readonly NativeExpectedPageJourneyTurn[]) {
  const expected = z.array(expectedPageTurn).length(2).parse(originalSqlTurns);
  const requests = z.array(z.object({ messageCount: z.number().int().positive(), selectedPackages: z.array(packagePin).length(0),
    selectedConnections: z.array(connection).length(1), nativePageJourneyTurn: pageTurn }).passthrough()).length(2).parse(actual);
  assert.equal(new Set(expected.map(turn => turn.clientMessageId)).size, 2);
  assert.equal(new Set(expected.map(turn => turn.textSha256)).size, 2);
  assert.deepEqual(expected.map(turn => `${turn.platform}:${turn.toolkit}`).sort(), ['android:slack', 'ios:github']);
  const matched = new Set<string>();
  return requests.map(request => {
    assert(!('nativeCurrentTurn' in request), 'A journey capture cannot also count as an original inline/plain capture.');
    const current = request.nativePageJourneyTurn;
    const turns = expected.filter(turn => turn.textSha256 === current.textSha256 && turn.textUtf16Length === current.textUtf16Length);
    assert.equal(turns.length, 1); const turn = turns[0]; assert(!matched.has(turn.clientMessageId)); matched.add(turn.clientMessageId);
    assert.equal(current.platform, turn.platform); assert.equal(current.toolkit, turn.toolkit);
    assert(current.lastUserIndex < request.messageCount); assert.equal(turn.selectedConnection.source, 'composio');
    exactSet(request.selectedConnections, [turn.selectedConnection], 'Newly UI-authorized exact provider route');
    return { platform: turn.platform, toolkit: turn.toolkit, clientMessageId: turn.clientMessageId, textSha256: current.textSha256,
      lastUserIndex: current.lastUserIndex, userCount: current.userCount };
  });
}
