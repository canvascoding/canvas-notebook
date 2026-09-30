import assert from 'node:assert/strict';

import { composeAutomationPreviousResult, composeAutomationSourceResults } from '../app/lib/automations/context-composer';
import { clipAutomationResultText } from '../app/lib/automations/result-clipping';

const opening = 'OPENING: monitored invoices. 🧭';
const conclusion = 'FINAL: last processed invoice = 4321. ✅';
const resultText = `${opening}\n${'漢字 🧭 details "quoted"\n'.repeat(4_000)}${conclusion}`;
const previous = { sourceRunId: 'previous-run', piSessionId: 'previous-session',
  finishedAt: '2026-09-30T10:00:00.000Z', resultText, reason: null };
const composed = composeAutomationPreviousResult({ previous, maxTokens: 500, maxBytes: 1_800,
  currentSessionId: 'current-session', hasPersistedSession: false });
assert.equal(composed.truncated, true);
assert.ok(composed.block.includes(opening));
assert.ok(composed.block.endsWith(conclusion));
assert.ok(composed.block.includes('> [Previous result truncated]'));
assert.ok(composed.estimatedTokens <= 500);
assert.ok(Buffer.byteLength(composed.block, 'utf8') <= 1_800);
for (const character of composed.block) {
  assert.ok(character.length !== 1 || !/[\uD800-\uDFFF]/u.test(character), 'Unicode pairs must remain intact');
}
const short = clipAutomationResultText({ text: '  short result  ', maxCharacters: 100,
  marker: '\n[truncated]\n', fits: (text) => Buffer.byteLength(text, 'utf8') <= 100 });
assert.deepEqual(short, { text: 'short result', truncated: false });
assert.equal(clipAutomationResultText({ text: resultText, maxCharacters: 10,
  marker: '\n[truncated]\n', fits: (text) => Buffer.byteLength(text, 'utf8') <= 10 }), null);
assert.equal(composeAutomationPreviousResult({ previous, maxTokens: 1, maxBytes: 1,
  currentSessionId: 'current-session', hasPersistedSession: false }).reason, 'budget_exhausted');
const sources = composeAutomationSourceResults({
  sources: ['source-a', 'source-b', 'source-c'].map((sourceJobId) => ({ ...previous, sourceJobId,
    sourceJobName: sourceJobId })),
  maxTokens: 1_024, maxBytes: 4_500, currentSessionId: 'current-session', hasPersistedSession: false,
});
assert.ok(sources.details.every((source) => source.reason === 'included_truncated'));
assert.equal(sources.block.split(opening).length - 1, 3);
assert.equal(sources.block.split(conclusion).length - 1, 3);
assert.ok(sources.estimatedTokens <= 1_024);
assert.ok(Buffer.byteLength(sources.block, 'utf8') <= 4_500);
console.log('automation-result-clipping-test: ok');
