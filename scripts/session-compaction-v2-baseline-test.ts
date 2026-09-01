import assert from 'node:assert/strict';
import fs from 'node:fs';

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Message, Model } from '@earendil-works/pi-ai';

import { getContextStatusDisplay } from '../app/components/canvas-agent-chat/contextStatusDisplay';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';
import {
  createPiContextBudgetSnapshot,
  getPiRequestOutputTokenCap,
} from '../app/lib/pi/context-budget';
import { composePiHistoryForLlm } from '../app/lib/pi/history-budget';

const HERMES_DEFAULTS_PATH = 'scripts/fixtures/session-compaction-v2/hermes-f293e720-defaults.json';
const CANVAS_OVERFLOW_STATUS_PATH = 'scripts/fixtures/session-compaction-v2/canvas-overflow-status-baseline.json';
const CANVAS_COMPACTION_PATH = 'scripts/fixtures/session-compaction-v2/canvas-compaction-baseline.json';
const TODO_PATH = 'docs/architecture/canvas-notebook/session-compaction-v2/todo.json';

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

type BudgetRecipe = {
  contextWindow: number;
  maxTokens: number;
  instructionCharacters: number;
  messageCharacters: number;
  toolDescriptionCharacters: number;
  imageBytes: number;
};

type BudgetMeasurement = {
  effectiveInstructionTokens: number;
  serializedMessageTokens: number;
  toolSchemaTokens: number;
  runtimeProviderOverheadTokens: number;
  multimodalTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
  hardHistoryTokens: number;
  triggerHistoryTokens: number;
  targetTailTokens: number;
  serializedMessageBytes: number;
  multimodalBytes: number;
  contextBudgetExceeded: boolean;
  payloadBudgetExceeded: boolean;
};

function measureBudget(recipe: BudgetRecipe): BudgetMeasurement {
  const model = {
    id: 'sanitized-baseline',
    name: 'Sanitized Baseline',
    api: 'openai-completions',
    provider: 'baseline-provider',
    baseUrl: 'http://localhost.invalid/v1',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: recipe.contextWindow,
    maxTokens: recipe.maxTokens,
  } satisfies Model<'openai-completions'>;
  const content = recipe.imageBytes > 0
    ? [
      { type: 'text' as const, text: 'M'.repeat(recipe.messageCharacters) },
      {
        type: 'image' as const,
        data: Buffer.alloc(recipe.imageBytes, 7).toString('base64'),
        mimeType: 'image/png',
      },
    ]
    : 'M'.repeat(recipe.messageCharacters);
  const tool = {
    name: 'baseline_tool',
    label: 'Baseline',
    description: 'T'.repeat(recipe.toolDescriptionCharacters),
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
  } as unknown as AgentTool;
  const snapshot = createPiContextBudgetSnapshot({
    model,
    effectiveInstructions: [{ role: 'system', content: 'I'.repeat(recipe.instructionCharacters) }],
    finalMessages: [{ role: 'user', content, timestamp: 1 }] as Message[],
    effectiveTools: [tool],
    requestOutputTokenCap: getPiRequestOutputTokenCap(model),
  });

  return {
    effectiveInstructionTokens: snapshot.effectiveInstructionTokens,
    serializedMessageTokens: snapshot.serializedMessageTokens,
    toolSchemaTokens: snapshot.toolSchemaTokens,
    runtimeProviderOverheadTokens: snapshot.runtimeProviderOverheadTokens,
    multimodalTokens: snapshot.multimodalTokens,
    outputReserveTokens: snapshot.outputReserveTokens,
    safetyReserveTokens: snapshot.safetyReserveTokens,
    estimatedInputTokens: snapshot.estimatedInputTokens,
    estimatedTotalTokens: snapshot.estimatedTotalTokens,
    hardHistoryTokens: snapshot.hardHistoryTokens,
    triggerHistoryTokens: snapshot.triggerHistoryTokens,
    targetTailTokens: snapshot.targetTailTokens,
    serializedMessageBytes: snapshot.serializedMessageBytes,
    multimodalBytes: snapshot.multimodalBytes,
    contextBudgetExceeded: snapshot.contextBudgetExceeded,
    payloadBudgetExceeded: snapshot.payloadBudgetExceeded,
  };
}

const hermes = readJson<{
  commit: string;
  license: string;
  licenseTextPath: string;
  compressionDefaults: Record<string, unknown>;
}>(HERMES_DEFAULTS_PATH);
assert.equal(hermes.commit, 'f293e7206b4ddd66042329442c6afebc19a8808d');
assert.equal(hermes.license, 'MIT');
assert.equal(hermes.licenseTextPath, 'docs/compliance/license-texts/hermes-agent-f293e720-MIT.txt');
assert.deepEqual(hermes.compressionDefaults, {
  enabled: true,
  thresholdRatio: 0.5,
  smallContextWindowLimitTokens: 512_000,
  smallContextThresholdFloorRatio: 0.75,
  targetRatioOfThreshold: 0.2,
  tailMode: 'legacy',
  protectFirstMessages: 3,
  protectLastMessages: 20,
  minimumTailUserMessages: 1,
  maxAttempts: 3,
  maxAttemptsHardCap: 10,
  abortOnSummaryFailure: false,
});
assert.match(
  fs.readFileSync(hermes.licenseTextPath, 'utf8'),
  /^MIT License\n\nCopyright \(c\) 2025 Nous Research\n/u,
);

const overflowStatus = readJson<{
  budgetCases: Array<{ id: string; recipe: BudgetRecipe; measurement: BudgetMeasurement }>;
  statusBase: RuntimeStatus;
  statusCases: Array<{
    id: string;
    input: Partial<RuntimeStatus>;
    expectedDisplay: ReturnType<typeof getContextStatusDisplay>;
  }>;
}>(CANVAS_OVERFLOW_STATUS_PATH);
for (const fixture of overflowStatus.budgetCases) {
  assert.deepEqual(measureBudget(fixture.recipe), fixture.measurement, `${fixture.id} budget baseline drifted`);
}
for (const fixture of overflowStatus.statusCases) {
  assert.deepEqual(
    getContextStatusDisplay({ ...overflowStatus.statusBase, ...fixture.input }),
    fixture.expectedDisplay,
    `${fixture.id} status baseline drifted`,
  );
}

const compaction = readJson<{
  cases: Array<{
    id: string;
    recipe: {
      messageCount: number;
      messageRepeatedText: string;
      messageRepeatCount: number;
      summaryText: string;
      summaryThroughTimestamp: number;
      summaryThroughSequence: number;
      summaryRevision: number;
      systemPromptTokens: number;
      contextWindow: number;
      modelMaxTokens: number;
      requestOutputTokens: number;
    };
    measurement: Record<string, unknown>;
  }>;
}>(CANVAS_COMPACTION_PATH);
for (const fixture of compaction.cases) {
  const { recipe } = fixture;
  const messages = Array.from({ length: recipe.messageCount }, (_, index) => ({
    role: 'user' as const,
    content: `turn-${index + 1}-${recipe.messageRepeatedText.repeat(recipe.messageRepeatCount)}`,
    timestamp: 100 + index,
    sequence: index + 1,
  })) as unknown as AgentMessage[];
  const composition = composePiHistoryForLlm({
    messages,
    summary: {
      summaryText: recipe.summaryText,
      summaryUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
      summaryThroughTimestamp: recipe.summaryThroughTimestamp,
      summaryThroughSequence: recipe.summaryThroughSequence,
      summaryRevision: recipe.summaryRevision,
    },
    systemPromptTokens: recipe.systemPromptTokens,
    contextWindow: recipe.contextWindow,
    modelMaxTokens: recipe.modelMaxTokens,
    requestOutputTokens: recipe.requestOutputTokens,
  });
  const measurement = {
    keptSequences: composition.keptMessages.map((message) => (
      message as unknown as { sequence: number }
    ).sequence),
    omittedSequences: composition.omittedMessages.map((message) => (
      message as unknown as { sequence: number }
    ).sequence),
    estimatedHistoryTokens: composition.estimatedHistoryTokens,
    availableHistoryTokens: composition.availableHistoryTokens,
    triggerHistoryTokens: composition.triggerHistoryTokens,
    targetHistoryTokens: composition.targetHistoryTokens,
    softThresholdExceeded: composition.softThresholdExceeded,
    contextBudgetExceeded: composition.contextBudgetExceeded,
    includedSummary: composition.includedSummary,
  };
  assert.deepEqual(measurement, fixture.measurement, `${fixture.id} compaction baseline drifted`);
}

const todo = readJson<{
  packages: Array<{ id: string; hermesReferences: string[]; portingMode: string }>;
}>(TODO_PATH);
for (const workPackage of todo.packages) {
  assert(workPackage.hermesReferences.length > 0, `${workPackage.id} needs a pinned Hermes reference`);
  assert(
    ['DIRECT_PORT', 'ADAPTED_PORT', 'INVARIANT_ONLY', 'DO_NOT_PORT'].includes(workPackage.portingMode),
    `${workPackage.id} needs a valid porting mode`,
  );
}

console.log('session-compaction-v2-baseline-test: ok');
