import assert from 'node:assert/strict';
import Module from 'node:module';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);
const model: Model<'openai-completions'> = {
  id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], contextWindow: 262_144, maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const summary = { summaryText: null, summaryUpdatedAt: null, summaryThroughTimestamp: null,
  summaryThroughSequence: null, summaryRevision: 0 };
const body = '## Active Task\nResearch the current travel question.\n## Completed Work\nEarlier research.\n'
  + '## Decisions and Constraints\nKeep confirmed facts.\n## Files, Commands, and Exact Errors\nNone.\n## Remaining Work\nAnswer the question.';
function assistant(text: string, timestamp: number): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp, api: model.api,
    provider: model.provider, model: model.id, stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function main() {
  const { projectPiHermesHistory, preparePiHermesCompactionCandidate } = await import('../app/lib/pi/compaction/runtime-engine');
  const { recoverAutomationRuntimePayload } = await import('../app/lib/automations/runtime-compaction');
  const { measurePiContextStatus } = await import('../app/lib/pi/context-status-measurement');
  const messages: AgentMessage[] = Array.from({ length: 24 }, (_, i) => i % 2
    ? assistant(`Earlier answer ${i}.`, i + 1)
    : { role: 'user', content: `Earlier question ${i}.`, timestamp: i + 1 });
  messages.push({ role: 'user', content: 'Research travel requirements.', timestamp: 25 });
  messages.push({ ...assistant('', 26), stopReason: 'toolUse', content: Array.from({ length: 3 }, (_, i) => (
    { type: 'toolCall' as const, id: `search-${i}`, name: 'web_search', arguments: { query: 'travel' } }
  )) });
  for (let i = 0; i < 3; i++) messages.push({ role: 'toolResult', toolCallId: `search-${i}`, toolName: 'web_search',
    content: [{ type: 'text', text: `SOURCE-${i} ${'x'.repeat(390_000)}` }], isError: false, timestamp: 27 + i });
  const original = JSON.stringify(messages);
  let calls = 0;
  const streamFn: StreamFn = async () => {
    calls++;
    return { result: async () => assistant(body, 100) } as AssistantMessageEventStream;
  };
  const base = { messages, summary, model, systemPromptTokens: 10_753, toolTokens: 12_615,
    requestOutputTokens: 8_192, sessionId: 'candidate-normalization-test', signal: new AbortController().signal, streamFn };
  for (const selectionMode of ['automatic', 'force'] as const) {
    const projection = projectPiHermesHistory({ ...base, selectionMode, pruningMode: 'candidate' });
    assert.equal(projection.composition.contextBudgetExceeded, false);
    assert.ok(projection.inspection.roughHistoryTokens < 15_000);
    const candidate = await preparePiHermesCompactionCandidate({ ...base, selectionMode });
    assert.equal(candidate.safeToSend, true);
    assert.equal(candidate.composition.contextBudgetExceeded, false);
    assert.ok(candidate.composition.llmMessages.some((m) => m.role === 'user' && m.content === 'Research travel requirements.'));
    for (let i = 0; i < 3; i++) assert.ok(candidate.composition.llmMessages.some((m) => m.role === 'toolResult' && m.toolCallId === `search-${i}`));
  }
  assert.ok(calls > 0, 'manual compaction must reach the summarizer instead of rejecting raw tool size');
  assert.equal(JSON.stringify(messages), original, 'raw transcript must not be mutated');

  const oversized: AgentMessage[] = [{ role: 'user', content: 'x'.repeat(1_200_000), timestamp: 1 }];
  const overflow = projectPiHermesHistory({ ...base, messages: oversized, selectionMode: 'force' }).composition;
  assert.equal(overflow.contextBudgetExceeded, true);
  assert.equal(overflow.llmMessages.length, 0);
  const status = await measurePiContextStatus(overflow, { messages: overflow.llmMessages, model,
    effectiveInstructions: [{ role: 'system', content: 'system' }], effectiveTools: [], requestOutputTokenCap: 8_192 });
  assert.ok(status.contextPressure.percentOfTrigger > 100, 'invalid empty projection must not report 0%');
  assert.equal(status.nextRequestBudgetExceeded, true);
  const callsBeforeRecovery = calls;
  const recovered = await recoverAutomationRuntimePayload({ ...base, messages: oversized,
    tools: [], effectiveSystemPrompt: 'system', requestOutputTokenCap: 8_192 });
  assert.equal(recovered, null, 'automation must never accept an empty failed candidate');
  assert.equal(calls, callsBeforeRecovery, 'a genuinely oversized user request is not silently summarized');
  console.log('pi compaction candidate normalization tests passed');
}
main().finally(() => { internals._load = originalLoad; }).catch((error) => { console.error(error); process.exitCode = 1; });
