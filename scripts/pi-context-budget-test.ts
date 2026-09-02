import assert from 'node:assert/strict';

import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';

import {
  createPiContextBudgetSnapshot,
  createPiProviderUsageCalibrationEvidence,
  DEFAULT_PI_CONTEXT_BUDGET_POLICY,
  getPiRequestOutputTokenCap,
  validatePiContextBudgetPolicy,
  withPiRequestOutputTokenCap,
} from '../app/lib/pi/context-budget';
import {
  buildPiHistoryUnits,
  composePiHistoryForLlm,
} from '../app/lib/pi/history-budget';

const model = {
  id: 'budget-contract-model',
  name: 'Budget Contract Model',
  api: 'openai-completions',
  provider: 'budget-provider',
  baseUrl: 'http://localhost.invalid/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 5_000,
} satisfies Model<'openai-completions'>;

const tool = {
  name: 'read',
  label: 'Read',
  description: 'Read a workspace file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
} as unknown as AgentTool;

async function main() {
  assert.throws(
    () => validatePiContextBudgetPolicy({
      ...DEFAULT_PI_CONTEXT_BUDGET_POLICY,
      targetRatio: 1.1,
    }),
    /targetRatio must be between 0 and 1/u,
  );
  assert.doesNotThrow(
    () => validatePiContextBudgetPolicy({
      ...DEFAULT_PI_CONTEXT_BUDGET_POLICY,
      targetRatio: 0.2,
      triggerRatio: 0.1,
    }),
    'the Hermes target is a fraction of the threshold, not a competing context-window ratio',
  );

  const outputTokenCap = getPiRequestOutputTokenCap(model);
  assert.equal(outputTokenCap, 2_000, 'the cap must respect model, Canvas policy, and context share');

  let sentMaxTokens: number | undefined;
  const baseStreamFn: StreamFn = async (_requestedModel, _context, options) => {
    sentMaxTokens = options?.maxTokens;
    return {} as AssistantMessageEventStream;
  };
  await withPiRequestOutputTokenCap(baseStreamFn, outputTokenCap)(model, { messages: [] });
  assert.equal(sentMaxTokens, outputTokenCap, 'the reserved cap must be the cap actually sent');

  const imageData = Buffer.alloc(12_000, 7).toString('base64');
  const finalMessages = [{
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'Inspect the attached image.' },
      { type: 'image' as const, data: imageData, mimeType: 'image/png' },
    ],
    timestamp: 1,
  }];
  const snapshot = createPiContextBudgetSnapshot({
    model,
    effectiveInstructions: [
      { role: 'system', content: 'System contract.' },
      { role: 'developer', content: 'Developer contract.' },
    ],
    finalMessages,
    effectiveTools: [tool],
    requestOutputTokenCap: outputTokenCap,
    runtimeProviderOverheadTokens: 80,
  });

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.outputReserveTokens, sentMaxTokens);
  assert.equal(snapshot.runtimeProviderOverheadTokens, 80);
  assert.equal(snapshot.multimodalBytes, 12_000);
  assert.ok(snapshot.multimodalTokens >= DEFAULT_PI_CONTEXT_BUDGET_POLICY.minimumImageTokens);
  assert.ok(snapshot.effectiveInstructionTokens > 0);
  assert.ok(snapshot.toolSchemaTokens > 0);
  assert.ok(snapshot.serializedMessageTokens > 0);
  assert.equal(
    snapshot.estimatedInputTokens,
    snapshot.effectiveInstructionTokens
      + snapshot.toolSchemaTokens
      + snapshot.serializedMessageTokens
      + snapshot.multimodalTokens
      + snapshot.runtimeProviderOverheadTokens,
    'every final request component must be counted exactly once',
  );
  assert.equal(
    snapshot.hardHistoryTokens,
    snapshot.contextWindowTokens
      - snapshot.effectiveInstructionTokens
      - snapshot.toolSchemaTokens
      - snapshot.runtimeProviderOverheadTokens
      - snapshot.outputReserveTokens
      - snapshot.safetyReserveTokens
      - snapshot.multimodalTokens,
  );
  assert.equal(
    snapshot.targetTailTokens,
    Math.floor(snapshot.triggerHistoryTokens * DEFAULT_PI_CONTEXT_BUDGET_POLICY.targetRatio),
    'Hermes target_ratio is a fraction of the effective trigger, not the full window',
  );
  assert.ok(snapshot.targetTailTokens < snapshot.triggerHistoryTokens);

  const changedPrompt = createPiContextBudgetSnapshot({
    model,
    effectiveInstructions: [{ role: 'system', content: 'Changed system contract.' }],
    finalMessages,
    effectiveTools: [tool],
    requestOutputTokenCap: outputTokenCap,
  });
  assert.notEqual(changedPrompt.instructionFingerprint, snapshot.instructionFingerprint);
  assert.notEqual(changedPrompt.contractFingerprint, snapshot.contractFingerprint);

  const changedTool = createPiContextBudgetSnapshot({
    model,
    effectiveInstructions: [{ role: 'system', content: 'System contract.' }],
    finalMessages,
    effectiveTools: [{ ...tool, description: 'Changed schema contract.' }],
    requestOutputTokenCap: outputTokenCap,
  });
  assert.notEqual(changedTool.toolSchemaFingerprint, snapshot.toolSchemaFingerprint);

  const changedModel = createPiContextBudgetSnapshot({
    model: { ...model, contextWindow: 12_000 },
    effectiveInstructions: [{ role: 'system', content: 'System contract.' }],
    finalMessages,
    effectiveTools: [tool],
    requestOutputTokenCap: outputTokenCap,
  });
  assert.notEqual(changedModel.modelFingerprint, snapshot.modelFingerprint);

  const changedPayload = createPiContextBudgetSnapshot({
    model,
    effectiveInstructions: [{ role: 'system', content: 'System contract.' }],
    finalMessages: [{ role: 'user', content: 'Different payload.', timestamp: 2 }],
    effectiveTools: [tool],
    requestOutputTokenCap: outputTokenCap,
  });
  assert.notEqual(changedPayload.payloadFingerprint, snapshot.payloadFingerprint);

  const reportedEvidence = createPiProviderUsageCalibrationEvidence({
    snapshot,
    provider: model.provider,
    model: model.id,
    providerReportedInputTokens: snapshot.estimatedInputTokens + 120,
  });
  assert.equal(reportedEvidence.contractFingerprint, snapshot.contractFingerprint);
  assert.equal(reportedEvidence.confidence, 'provider_reported');
  assert.equal(reportedEvidence.absoluteDeltaTokens, 120);

  const verifiedEvidence = createPiProviderUsageCalibrationEvidence({
    snapshot,
    provider: model.provider,
    model: model.id,
    providerReportedInputTokens: snapshot.estimatedInputTokens,
    verifiedSameContract: true,
  });
  assert.equal(verifiedEvidence.confidence, 'verified_same_contract');

  const toolHistory = [
    { role: 'user', content: 'old context', timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'initial response' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'stop',
      timestamp: 2,
    },
    { role: 'user', content: 'initial constraint', timestamp: 3 },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'a.md' } },
        { type: 'toolCall', id: 'call-b', name: 'read', arguments: { path: 'b.md' } },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 4,
    },
    { role: 'toolResult', toolCallId: 'call-a', toolName: 'read', content: [{ type: 'text', text: 'a'.repeat(3_000) }], timestamp: 5 },
    { role: 'toolResult', toolCallId: 'call-b', toolName: 'read', content: [{ type: 'text', text: 'b'.repeat(3_000) }], timestamp: 6 },
    { role: 'user', content: 'recent request one', timestamp: 7 },
    { role: 'assistant', content: [{ type: 'text', text: 'recent response one' }], api: 'test', provider: 'test', model: 'test', stopReason: 'stop', timestamp: 8 },
    { role: 'user', content: 'recent request two', timestamp: 9 },
    { role: 'assistant', content: [{ type: 'text', text: 'recent response two' }], api: 'test', provider: 'test', model: 'test', stopReason: 'stop', timestamp: 10 },
    { role: 'user', content: 'recent request three', timestamp: 11 },
    { role: 'assistant', content: [{ type: 'text', text: 'recent response three' }], api: 'test', provider: 'test', model: 'test', stopReason: 'stop', timestamp: 12 },
    { role: 'assistant', content: [{ type: 'text', text: 'latest visible response' }], api: 'test', provider: 'test', model: 'test', stopReason: 'stop', timestamp: 13 },
    { role: 'user', content: 'latest request', timestamp: 14 },
  ] as unknown as AgentMessage[];

  const units = buildPiHistoryUnits(toolHistory);
  assert.equal(units.length, 12);
  assert.equal(units[3].kind, 'tool_group');
  assert.equal(units[3].messages.length, 3);
  assert.deepEqual(units[3].toolCallIds, ['call-a', 'call-b']);
  assert.equal(units[3].toolChainComplete, true);

  const composition = composePiHistoryForLlm({
    messages: toolHistory,
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 1_000,
    contextWindow: 4_000,
    modelMaxTokens: 1_000,
    requestOutputTokens: 800,
    toolTokens: 500,
  });
  assert.deepEqual(
    composition.keptMessages,
    [...toolHistory.slice(0, 3), ...toolHistory.slice(6)],
  );
  assert.deepEqual(
    composition.omittedMessages,
    toolHistory.slice(3, 6),
    'a history cut must omit the assistant tool call and all results together',
  );
  assert.equal(composition.outputReserveTokens, 800);
  assert.equal(composition.softThresholdExceeded, true);
  assert.ok(composition.estimatedHistoryTokens <= composition.availableHistoryTokens);

  const authoritativeFullComposition = composePiHistoryForLlm({
    messages: toolHistory,
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 1_000,
    contextWindow: 4_000,
    modelMaxTokens: 1_000,
    requestOutputTokens: 800,
    toolTokens: 500,
    selectionMode: 'full',
  });
  assert.deepEqual(authoritativeFullComposition.llmMessages, toolHistory);
  assert.equal(
    authoritativeFullComposition.contextBudgetExceeded,
    false,
    'the full mode must preserve an exact-preflight-approved request despite a conservative token estimate',
  );

  const openToolUnits = buildPiHistoryUnits([toolHistory[3]]);
  assert.equal(openToolUnits[0].toolChainComplete, false);

  const interleavedToolUnits = buildPiHistoryUnits([
    toolHistory[3],
    { role: 'compact-break', kind: 'manual', timestamp: new Date().toISOString() } as unknown as AgentMessage,
    toolHistory[4],
  ]);
  assert.equal(interleavedToolUnits.length, 1);
  assert.equal(interleavedToolUnits[0].messages.length, 3);
  assert.equal(interleavedToolUnits[0].toolChainComplete, false, 'parallel call-b remains open');

  const completeRawHistory = [
    { role: 'user', content: 'covered but still available', timestamp: 10, sequence: 1 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'recent response' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'stop',
      timestamp: 11,
      sequence: 2,
    },
  ] as unknown as AgentMessage[];
  const rawOnlyComposition = composePiHistoryForLlm({
    messages: completeRawHistory,
    summary: {
      summaryText: 'This must not duplicate the available raw history.',
      summaryUpdatedAt: new Date(),
      summaryThroughTimestamp: 10,
      summaryThroughSequence: 1,
      summaryRevision: 0,
    },
    systemPromptTokens: 100,
    contextWindow: 4_000,
    modelMaxTokens: 1_000,
    requestOutputTokens: 800,
  });
  assert.equal(rawOnlyComposition.softThresholdExceeded, false);
  assert.equal(rawOnlyComposition.includedSummary, false);
  assert.deepEqual(rawOnlyComposition.keptMessages, completeRawHistory);

  const marker = {
    role: 'compact-break',
    kind: 'manual',
    timestamp: '2026-08-26T10:00:00.000Z',
  } as unknown as AgentMessage;
  const authMarker = {
    role: 'composio_auth_required',
    toolkit: 'example',
    timestamp: 11,
  } as unknown as AgentMessage;
  const prunedComposition = composePiHistoryForLlm({
    messages: [completeRawHistory[1], marker, authMarker],
    summary: {
      summaryText: 'The raw prefix is no longer loaded.',
      summaryUpdatedAt: new Date(),
      summaryThroughTimestamp: 10,
      summaryThroughSequence: 1,
      summaryRevision: 0,
    },
    systemPromptTokens: 100,
    contextWindow: 4_000,
    modelMaxTokens: 1_000,
    requestOutputTokens: 800,
  });
  assert.equal(prunedComposition.includedSummary, true);
  assert.equal(prunedComposition.keptMessages.includes(marker), false);
  assert.equal(prunedComposition.omittedMessages.includes(marker), false);
  assert.equal(prunedComposition.llmMessages.includes(marker), false);
  assert.equal(prunedComposition.llmMessages.includes(authMarker), false);
  assert.deepEqual(prunedComposition.keptMessages, [completeRawHistory[1]]);

  const longSequencedHistory = Array.from({ length: 12 }, (_, index) => ({
    role: 'user' as const,
    content: `turn-${index + 1}-${'context '.repeat(120)}`,
    timestamp: 100 + index,
    sequence: index + 1,
  })) as unknown as AgentMessage[];
  const disjointComposition = composePiHistoryForLlm({
    messages: longSequencedHistory,
    summary: {
      summaryText: 'Summary through the fourth persisted history unit.',
      summaryUpdatedAt: new Date(),
      summaryThroughTimestamp: 103,
      summaryThroughSequence: 4,
      summaryRevision: 1,
    },
    systemPromptTokens: 100,
    contextWindow: 4_000,
    modelMaxTokens: 1_000,
    requestOutputTokens: 800,
  });
  assert.equal(disjointComposition.softThresholdExceeded, true);
  assert.equal(disjointComposition.includedSummary, true);
  assert.ok(
    disjointComposition.keptMessages.every(
      (message) => (message as unknown as { sequence: number }).sequence > 4,
    ),
    'raw tail and summary coverage must be disjoint',
  );
  assert.equal(disjointComposition.keptMessages.at(-1), longSequencedHistory.at(-1));
  assert.ok(disjointComposition.estimatedHistoryTokens <= disjointComposition.availableHistoryTokens);

  const currentImageTurn = {
    role: 'user',
    content: [
      { type: 'text', text: 'Use this current image.' },
      { type: 'image', data: Buffer.alloc(1_024, 3).toString('base64'), mimeType: 'image/png' },
    ],
    timestamp: 500,
  } as unknown as AgentMessage;
  const activeToolTail = [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-current', name: 'read', arguments: { path: 'current.md' } }],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 501,
    },
    {
      role: 'toolResult',
      toolCallId: 'call-current',
      toolName: 'read',
      content: [{ type: 'text', text: 'current result' }],
      timestamp: 502,
    },
  ] as unknown as AgentMessage[];
  const protectedTailComposition = composePiHistoryForLlm({
    messages: [
      ...longSequencedHistory,
      currentImageTurn,
      ...activeToolTail,
    ],
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
      summaryRevision: 0,
    },
    systemPromptTokens: 100,
    contextWindow: 5_500,
    modelMaxTokens: 1_000,
    requestOutputTokens: 800,
  });
  assert.deepEqual(
    protectedTailComposition.keptMessages.slice(-3),
    [currentImageTurn, ...activeToolTail],
    'the current multimodal turn and every following tool message must remain protected',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
