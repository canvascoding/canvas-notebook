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
      targetRatio: 0.9,
      triggerRatio: 0.8,
    }),
    /targetRatio must be lower/u,
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
    snapshot.hardHistoryTokens,
    snapshot.contextWindowTokens
      - snapshot.effectiveInstructionTokens
      - snapshot.toolSchemaTokens
      - snapshot.runtimeProviderOverheadTokens
      - snapshot.outputReserveTokens
      - snapshot.safetyReserveTokens,
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
      content: [
        { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'a.md' } },
        { type: 'toolCall', id: 'call-b', name: 'read', arguments: { path: 'b.md' } },
      ],
      api: 'test',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 2,
    },
    { role: 'toolResult', toolCallId: 'call-a', toolName: 'read', content: [{ type: 'text', text: 'a'.repeat(3_000) }], timestamp: 3 },
    { role: 'toolResult', toolCallId: 'call-b', toolName: 'read', content: [{ type: 'text', text: 'b'.repeat(3_000) }], timestamp: 4 },
    { role: 'user', content: 'latest request', timestamp: 5 },
  ] as unknown as AgentMessage[];

  const units = buildPiHistoryUnits(toolHistory);
  assert.equal(units.length, 3);
  assert.equal(units[1].kind, 'tool_group');
  assert.equal(units[1].messages.length, 3);
  assert.deepEqual(units[1].toolCallIds, ['call-a', 'call-b']);
  assert.equal(units[1].toolChainComplete, true);

  const composition = composePiHistoryForLlm({
    messages: toolHistory,
    summary: {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
      summaryThroughSequence: null,
    },
    systemPromptTokens: 1_000,
    contextWindow: 4_000,
    modelMaxTokens: 1_000,
    requestOutputTokens: 800,
    toolTokens: 500,
  });
  assert.deepEqual(composition.keptMessages, [toolHistory[4]]);
  assert.deepEqual(
    composition.omittedMessages.slice(-3),
    toolHistory.slice(1, 4),
    'a history cut must omit the assistant tool call and all results together',
  );
  assert.equal(composition.outputReserveTokens, 800);

  const openToolUnits = buildPiHistoryUnits(toolHistory.slice(0, 2));
  assert.equal(openToolUnits[1].toolChainComplete, false);

  const interleavedToolUnits = buildPiHistoryUnits([
    toolHistory[1],
    { role: 'compact-break', kind: 'manual', timestamp: new Date().toISOString() } as unknown as AgentMessage,
    toolHistory[2],
  ]);
  assert.equal(interleavedToolUnits.length, 1);
  assert.equal(interleavedToolUnits[0].messages.length, 3);
  assert.equal(interleavedToolUnits[0].toolChainComplete, false, 'parallel call-b remains open');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
