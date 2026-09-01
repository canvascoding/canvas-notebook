import { createHash } from 'node:crypto';

import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';

import {
  MAX_LLM_HISTORY_BYTES,
  MAX_LLM_TOTAL_IMAGE_BYTES,
} from './llm-payload-limits';

export type PiBudgetEstimateConfidence =
  | 'heuristic'
  | 'provider_reported'
  | 'verified_same_contract';

export type PiContextBudgetPolicy = Readonly<{
  triggerRatio: number;
  targetRatio: number;
  outputContextRatio: number;
  maximumOutputTokens: number;
  safetyFloorTokens: number;
  safetyRatio: number;
  runtimeProviderOverheadTokens: number;
  minimumImageTokens: number;
  maximumImageTokens: number;
  imageBytesPerToken: number;
}>;

export const DEFAULT_PI_CONTEXT_BUDGET_POLICY: PiContextBudgetPolicy = Object.freeze({
  triggerRatio: 0.8,
  targetRatio: 0.6,
  outputContextRatio: 0.2,
  maximumOutputTokens: 8_192,
  safetyFloorTokens: 512,
  safetyRatio: 0.05,
  runtimeProviderOverheadTokens: 64,
  minimumImageTokens: 512,
  maximumImageTokens: 4_096,
  imageBytesPerToken: 256,
});

export type PiEffectiveInstruction = Readonly<{
  role: 'system' | 'developer';
  content: string;
}>;

export type PiContextBudgetSnapshot = Readonly<{
  snapshotVersion: 1;
  contractFingerprint: string;
  modelFingerprint: string;
  instructionFingerprint: string;
  toolSchemaFingerprint: string;
  runtimeFingerprint: string;
  payloadFingerprint: string;
  modelIdentity: string;
  contextWindowTokens: number;
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
  hardHistoryBytes: number;
  totalImageBytesLimit: number;
  contextBudgetExceeded: boolean;
  payloadBudgetExceeded: boolean;
  estimateConfidence: PiBudgetEstimateConfidence;
}>;

export type PiProviderUsageCalibrationEvidence = Readonly<{
  contractFingerprint: string;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  providerReportedInputTokens: number;
  absoluteDeltaTokens: number;
  relativeDelta: number | null;
  confidence: Exclude<PiBudgetEstimateConfidence, 'heuristic'>;
}>;

const TOKENS_PER_CHARACTER = 0.25;

function finiteInteger(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function validateRatio(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return value;
}

export function validatePiContextBudgetPolicy(
  policy: PiContextBudgetPolicy = DEFAULT_PI_CONTEXT_BUDGET_POLICY,
): PiContextBudgetPolicy {
  const triggerRatio = validateRatio(policy.triggerRatio, 'triggerRatio');
  const targetRatio = validateRatio(policy.targetRatio, 'targetRatio');
  if (targetRatio >= triggerRatio) {
    throw new Error('targetRatio must be lower than triggerRatio.');
  }
  const outputContextRatio = validateRatio(policy.outputContextRatio, 'outputContextRatio');
  const safetyRatio = validateRatio(policy.safetyRatio, 'safetyRatio');
  const minimumImageTokens = finiteInteger(policy.minimumImageTokens);
  const maximumImageTokens = finiteInteger(policy.maximumImageTokens);
  if (maximumImageTokens < minimumImageTokens) {
    throw new Error('maximumImageTokens must be greater than or equal to minimumImageTokens.');
  }

  return Object.freeze({
    triggerRatio,
    targetRatio,
    outputContextRatio,
    maximumOutputTokens: finiteInteger(policy.maximumOutputTokens),
    safetyFloorTokens: finiteInteger(policy.safetyFloorTokens),
    safetyRatio,
    runtimeProviderOverheadTokens: finiteInteger(policy.runtimeProviderOverheadTokens),
    minimumImageTokens,
    maximumImageTokens,
    imageBytesPerToken: Math.max(1, finiteInteger(policy.imageBytesPerToken, 1)),
  });
}

export function estimatePiTextTokens(value: string): number {
  return Math.ceil(value.length * TOKENS_PER_CHARACTER);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      return entry.map(normalize);
    }
    if (!entry || typeof entry !== 'object') {
      return entry;
    }
    if (seen.has(entry)) {
      return '[Circular]';
    }
    seen.add(entry);
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };

  return JSON.stringify(normalize(value)) ?? 'null';
}

export function serializePiEffectiveToolSchemas(tools: readonly AgentTool[]): string {
  return stableSerialize(tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
  })));
}

export function estimatePiToolSchemaTokens(tools: readonly AgentTool[]): number {
  return estimatePiTextTokens(serializePiEffectiveToolSchemas(tools));
}

export function getPiRequestOutputTokenCap(
  model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>,
  policy: PiContextBudgetPolicy = DEFAULT_PI_CONTEXT_BUDGET_POLICY,
): number {
  const validatedPolicy = validatePiContextBudgetPolicy(policy);
  const contextWindow = Math.max(1, finiteInteger(model.contextWindow, 1));
  const modelMaximum = Math.max(1, finiteInteger(model.maxTokens, 1));
  const contextShare = Math.max(1, Math.floor(contextWindow * validatedPolicy.outputContextRatio));
  return Math.max(1, Math.min(modelMaximum, validatedPolicy.maximumOutputTokens, contextShare));
}

export function withPiRequestOutputTokenCap(streamFn: StreamFn, outputTokenCap: number): StreamFn {
  const finalCap = Math.max(1, finiteInteger(outputTokenCap, 1));
  return (model, context, options) => streamFn(model, context, {
    ...options,
    maxTokens: finalCap,
  });
}

function estimateBase64Bytes(value: string): number {
  const clean = value.replace(/\s+/gu, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

function isImagePart(value: unknown): value is { type: 'image'; data: string; mimeType?: string } {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'image'
    && typeof (value as { data?: unknown }).data === 'string',
  );
}

function collectMultimodalEvidence(
  messages: readonly Message[],
  policy: PiContextBudgetPolicy,
): { bytes: number; tokens: number; serializationShape: unknown[] } {
  let bytes = 0;
  let tokens = 0;

  const serializationShape = messages.map((message) => {
    if (!('content' in message) || !Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part) => {
        if (!isImagePart(part)) return part;
        const imageBytes = estimateBase64Bytes(part.data);
        bytes += imageBytes;
        tokens += Math.min(
          policy.maximumImageTokens,
          Math.max(policy.minimumImageTokens, Math.ceil(imageBytes / policy.imageBytesPerToken)),
        );
        return {
          ...part,
          data: `[final-image:${imageBytes}-bytes]`,
        };
      }),
    };
  });

  return { bytes, tokens, serializationShape };
}

export function createPiContextBudgetSnapshot(input: {
  model: Model<Api>;
  effectiveInstructions: readonly PiEffectiveInstruction[];
  finalMessages: readonly Message[];
  effectiveTools: readonly AgentTool[];
  requestOutputTokenCap: number;
  runtimeProviderOverheadTokens?: number;
  runtimeContractRevision?: string;
  estimateConfidence?: PiBudgetEstimateConfidence;
  policy?: PiContextBudgetPolicy;
}): PiContextBudgetSnapshot {
  const policy = validatePiContextBudgetPolicy(input.policy);
  const contextWindowTokens = Math.max(1, finiteInteger(input.model.contextWindow, 1));
  const outputReserveTokens = Math.max(1, finiteInteger(input.requestOutputTokenCap, 1));
  if (outputReserveTokens > Math.max(1, finiteInteger(input.model.maxTokens, 1))) {
    throw new Error('requestOutputTokenCap exceeds the effective model maxTokens.');
  }

  const serializedInstructions = stableSerialize(input.effectiveInstructions);
  const serializedTools = serializePiEffectiveToolSchemas(input.effectiveTools);
  const multimodal = collectMultimodalEvidence(input.finalMessages, policy);
  const serializedMessageShape = stableSerialize(multimodal.serializationShape);
  const finalSerializedMessages = JSON.stringify(input.finalMessages);
  const effectiveInstructionTokens = estimatePiTextTokens(serializedInstructions);
  const toolSchemaTokens = estimatePiTextTokens(serializedTools);
  const serializedMessageTokens = estimatePiTextTokens(serializedMessageShape);
  const runtimeProviderOverheadTokens = finiteInteger(
    input.runtimeProviderOverheadTokens ?? policy.runtimeProviderOverheadTokens,
  );
  const estimatedInputBeforeSafety = effectiveInstructionTokens
    + toolSchemaTokens
    + serializedMessageTokens
    + multimodal.tokens
    + runtimeProviderOverheadTokens;
  const safetyReserveTokens = Math.max(
    policy.safetyFloorTokens,
    Math.ceil(estimatedInputBeforeSafety * policy.safetyRatio),
  );
  const hardHistoryTokens = Math.max(
    0,
    contextWindowTokens
      - effectiveInstructionTokens
      - toolSchemaTokens
      - runtimeProviderOverheadTokens
      - outputReserveTokens
      - safetyReserveTokens,
  );
  const estimatedInputTokens = estimatedInputBeforeSafety;
  const estimatedTotalTokens = estimatedInputTokens + outputReserveTokens + safetyReserveTokens;
  const serializedMessageBytes = Buffer.byteLength(finalSerializedMessages, 'utf8');
  const modelIdentity = `${input.model.provider}:${input.model.api}:${input.model.id}`;
  const modelFingerprint = sha256(stableSerialize({
    identity: modelIdentity,
    contextWindow: input.model.contextWindow,
    maxTokens: input.model.maxTokens,
  }));
  const instructionFingerprint = sha256(serializedInstructions);
  const toolSchemaFingerprint = sha256(serializedTools);
  const runtimeFingerprint = sha256(stableSerialize({
    provider: input.model.provider,
    api: input.model.api,
    outputReserveTokens,
    runtimeContractRevision: input.runtimeContractRevision ?? 'pi-final-payload-v1',
    policy,
  }));
  const payloadFingerprint = sha256(finalSerializedMessages);
  const contractFingerprint = sha256([
    modelFingerprint,
    instructionFingerprint,
    toolSchemaFingerprint,
    runtimeFingerprint,
    payloadFingerprint,
  ].join(':'));

  return Object.freeze({
    snapshotVersion: 1,
    contractFingerprint,
    modelFingerprint,
    instructionFingerprint,
    toolSchemaFingerprint,
    runtimeFingerprint,
    payloadFingerprint,
    modelIdentity,
    contextWindowTokens,
    effectiveInstructionTokens,
    serializedMessageTokens,
    toolSchemaTokens,
    runtimeProviderOverheadTokens,
    multimodalTokens: multimodal.tokens,
    outputReserveTokens,
    safetyReserveTokens,
    estimatedInputTokens,
    estimatedTotalTokens,
    hardHistoryTokens,
    triggerHistoryTokens: Math.floor(hardHistoryTokens * policy.triggerRatio),
    targetTailTokens: Math.floor(hardHistoryTokens * policy.targetRatio),
    serializedMessageBytes,
    multimodalBytes: multimodal.bytes,
    hardHistoryBytes: MAX_LLM_HISTORY_BYTES,
    totalImageBytesLimit: MAX_LLM_TOTAL_IMAGE_BYTES,
    contextBudgetExceeded: estimatedTotalTokens > contextWindowTokens,
    payloadBudgetExceeded:
      serializedMessageBytes > MAX_LLM_HISTORY_BYTES
      || multimodal.bytes > MAX_LLM_TOTAL_IMAGE_BYTES,
    estimateConfidence: input.estimateConfidence ?? 'heuristic',
  });
}

export function createPiProviderUsageCalibrationEvidence(input: {
  snapshot: PiContextBudgetSnapshot;
  provider: string;
  model: string;
  providerReportedInputTokens: number;
  verifiedSameContract?: boolean;
}): PiProviderUsageCalibrationEvidence {
  const providerReportedInputTokens = finiteInteger(input.providerReportedInputTokens);
  const absoluteDeltaTokens = providerReportedInputTokens - input.snapshot.estimatedInputTokens;
  return Object.freeze({
    contractFingerprint: input.snapshot.contractFingerprint,
    provider: input.provider,
    model: input.model,
    estimatedInputTokens: input.snapshot.estimatedInputTokens,
    providerReportedInputTokens,
    absoluteDeltaTokens,
    relativeDelta: input.snapshot.estimatedInputTokens > 0
      ? absoluteDeltaTokens / input.snapshot.estimatedInputTokens
      : null,
    confidence: input.verifiedSameContract ? 'verified_same_contract' : 'provider_reported',
  });
}
