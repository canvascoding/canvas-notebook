/**
 * Portions adapted from NousResearch/hermes-agent at
 * f293e7206b4ddd66042329442c6afebc19a8808d.
 * Copyright (c) 2025 Nous Research, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */

export const HERMES_COMPACTION_DEFAULTS = Object.freeze({
  thresholdRatio: 0.5,
  targetRatioOfThreshold: 0.2,
  minimumContextTokens: 64_000,
  smallContextWindowLimitTokens: 512_000,
  smallContextThresholdFloorRatio: 0.75,
  degenerateThresholdRatio: 0.85,
  protectFirstMessages: 3,
  protectLastMessages: 20,
  maximumAttempts: 3,
  maximumAttemptsHardCap: 10,
  materialProgressRatio: 0.05,
});

export type SessionCompactionPolicyConfig = Readonly<{
  thresholdRatio?: number;
  targetRatioOfThreshold?: number;
  minimumContextTokens?: number;
  smallContextWindowLimitTokens?: number;
  smallContextThresholdFloorRatio?: number;
  degenerateThresholdRatio?: number;
  protectFirstMessages?: number;
  protectLastMessages?: number;
  maximumAttempts?: unknown;
  thresholdTokensCap?: unknown;
  modelThresholds?: Readonly<Record<string, number>>;
}>;

export type SessionCompactionBudget = Readonly<{
  contextWindowTokens: number;
  outputReserveTokens: number;
  fixedRequestTokens: number;
  effectiveInputBudgetTokens: number;
  configuredThresholdRatio: number;
  effectiveThresholdRatio: number;
  ratioThresholdTokens: number;
  thresholdTokensCap: number | null;
  triggerTokens: number;
  targetTailTokens: number;
  protectFirstMessages: number;
  protectLastMessages: number;
  maximumAttempts: number;
}>;

export type SessionCompactionPressure = Readonly<{
  cheapGatePassed: boolean;
  needsAuthoritativeEstimate: boolean;
  authoritativeHistoryTokens: number | null;
  authoritativePressureExceeded: boolean;
  hardRequestLimitExceeded: boolean;
  shouldCompact: boolean;
  providerActualInputTokens: number | null;
}>;

function finiteInteger(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function ratio(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return resolved;
}

export function normalizeHermesThresholdTokensCap(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[+-]?\d+$/u.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function resolveHermesMaximumAttempts(value: unknown): number {
  let parsed: number = HERMES_COMPACTION_DEFAULTS.maximumAttempts;
  if (typeof value === 'number' && Number.isInteger(value)) {
    parsed = value;
  } else if (typeof value === 'string' && /^[+-]?\d+$/u.test(value.trim())) {
    parsed = Number(value.trim());
  }
  if (parsed < 1) parsed = HERMES_COMPACTION_DEFAULTS.maximumAttempts;
  return Math.min(parsed, HERMES_COMPACTION_DEFAULTS.maximumAttemptsHardCap);
}

/** Longest matching model-name substring wins, matching Hermes. */
export function resolveHermesModelThresholdRatio(
  modelIdentity: string,
  modelThresholds: Readonly<Record<string, number>> | undefined,
  defaultRatio: number,
): number {
  if (!modelIdentity || !modelThresholds) return defaultRatio;
  let bestKey = '';
  for (const key of Object.keys(modelThresholds)) {
    if (modelIdentity.includes(key) && key.length > bestKey.length) bestKey = key;
  }
  return bestKey ? modelThresholds[bestKey] : defaultRatio;
}

/** Small windows are raised to the Hermes 75% trigger floor. */
export function resolveHermesEffectiveThresholdRatio(input: {
  contextWindowTokens: number;
  configuredThresholdRatio: number;
  smallContextWindowLimitTokens?: number;
  smallContextThresholdFloorRatio?: number;
}): number {
  const contextWindowTokens = finiteInteger(input.contextWindowTokens);
  const configuredThresholdRatio = ratio(
    input.configuredThresholdRatio,
    HERMES_COMPACTION_DEFAULTS.thresholdRatio,
    'configuredThresholdRatio',
  );
  const windowLimit = finiteInteger(
    input.smallContextWindowLimitTokens
      ?? HERMES_COMPACTION_DEFAULTS.smallContextWindowLimitTokens,
  );
  const smallWindowFloor = ratio(
    input.smallContextThresholdFloorRatio,
    HERMES_COMPACTION_DEFAULTS.smallContextThresholdFloorRatio,
    'smallContextThresholdFloorRatio',
  );
  return contextWindowTokens > 0 && contextWindowTokens < windowLimit
    ? Math.max(configuredThresholdRatio, smallWindowFloor)
    : configuredThresholdRatio;
}

/**
 * Computes Hermes' ratio threshold over the usable input budget. The 64K
 * floor falls back to 85% when it would make the trigger unreachable.
 */
export function computeHermesCompactionThresholdTokens(input: {
  effectiveInputBudgetTokens: number;
  thresholdRatio: number;
  minimumContextTokens?: number;
  degenerateThresholdRatio?: number;
}): number {
  const effectiveInputBudgetTokens = Math.max(1, finiteInteger(input.effectiveInputBudgetTokens, 1));
  const thresholdRatio = ratio(
    input.thresholdRatio,
    HERMES_COMPACTION_DEFAULTS.thresholdRatio,
    'thresholdRatio',
  );
  const minimumContextTokens = finiteInteger(
    input.minimumContextTokens ?? HERMES_COMPACTION_DEFAULTS.minimumContextTokens,
  );
  const degenerateThresholdRatio = ratio(
    input.degenerateThresholdRatio,
    HERMES_COMPACTION_DEFAULTS.degenerateThresholdRatio,
    'degenerateThresholdRatio',
  );
  const percentageThreshold = Math.floor(effectiveInputBudgetTokens * thresholdRatio);
  const flooredThreshold = Math.max(percentageThreshold, minimumContextTokens);
  if (flooredThreshold >= effectiveInputBudgetTokens) {
    return Math.max(
      1,
      Math.min(
        Math.floor(effectiveInputBudgetTokens * degenerateThresholdRatio),
        effectiveInputBudgetTokens - 1,
      ),
    );
  }
  return flooredThreshold;
}

export function createSessionCompactionBudget(input: {
  contextWindowTokens: number;
  outputReserveTokens: number;
  fixedRequestTokens: number;
  modelIdentity?: string;
  config?: SessionCompactionPolicyConfig;
}): SessionCompactionBudget {
  const config = input.config ?? {};
  const contextWindowTokens = Math.max(1, finiteInteger(input.contextWindowTokens, 1));
  const outputReserveTokens = finiteInteger(input.outputReserveTokens);
  const fixedRequestTokens = finiteInteger(input.fixedRequestTokens);
  const effectiveInputBudgetTokens = Math.max(
    1,
    contextWindowTokens - outputReserveTokens - fixedRequestTokens,
  );
  const defaultThresholdRatio = ratio(
    config.thresholdRatio,
    HERMES_COMPACTION_DEFAULTS.thresholdRatio,
    'thresholdRatio',
  );
  const configuredThresholdRatio = ratio(
    resolveHermesModelThresholdRatio(
      input.modelIdentity ?? '',
      config.modelThresholds,
      defaultThresholdRatio,
    ),
    defaultThresholdRatio,
    'modelThresholds value',
  );
  const effectiveThresholdRatio = resolveHermesEffectiveThresholdRatio({
    contextWindowTokens,
    configuredThresholdRatio,
    smallContextWindowLimitTokens: config.smallContextWindowLimitTokens,
    smallContextThresholdFloorRatio: config.smallContextThresholdFloorRatio,
  });
  const ratioThresholdTokens = computeHermesCompactionThresholdTokens({
    effectiveInputBudgetTokens,
    thresholdRatio: effectiveThresholdRatio,
    minimumContextTokens: config.minimumContextTokens,
    degenerateThresholdRatio: config.degenerateThresholdRatio,
  });
  const thresholdTokensCap = normalizeHermesThresholdTokensCap(config.thresholdTokensCap);
  const triggerTokens = thresholdTokensCap === null
    ? ratioThresholdTokens
    : Math.min(ratioThresholdTokens, thresholdTokensCap, effectiveInputBudgetTokens);
  const targetRatioOfThreshold = ratio(
    config.targetRatioOfThreshold,
    HERMES_COMPACTION_DEFAULTS.targetRatioOfThreshold,
    'targetRatioOfThreshold',
  );

  return Object.freeze({
    contextWindowTokens,
    outputReserveTokens,
    fixedRequestTokens,
    effectiveInputBudgetTokens,
    configuredThresholdRatio,
    effectiveThresholdRatio,
    ratioThresholdTokens,
    thresholdTokensCap,
    triggerTokens,
    targetTailTokens: Math.max(1, Math.floor(triggerTokens * targetRatioOfThreshold)),
    protectFirstMessages: finiteInteger(
      config.protectFirstMessages ?? HERMES_COMPACTION_DEFAULTS.protectFirstMessages,
    ),
    protectLastMessages: finiteInteger(
      config.protectLastMessages ?? HERMES_COMPACTION_DEFAULTS.protectLastMessages,
    ),
    maximumAttempts: resolveHermesMaximumAttempts(config.maximumAttempts),
  });
}

/** Cheap count OR rough-token gate; it never makes the final pressure decision. */
export function shouldRunSessionCompactionPreflight(input: {
  messageCount: number;
  roughHistoryTokens: number;
  protectFirstMessages: number;
  protectLastMessages: number;
  thresholdTokens: number;
}): boolean {
  return input.messageCount > input.protectFirstMessages + input.protectLastMessages + 1
    || input.roughHistoryTokens >= input.thresholdTokens;
}

/** Provider actuals are returned for calibration only and never replace the next-request estimate. */
export function evaluateSessionCompactionPressure(input: {
  budget: SessionCompactionBudget;
  messageCount: number;
  roughHistoryTokens: number;
  authoritativeNextRequestTokens: number | null;
  providerActualInputTokens?: number | null;
  payloadBudgetExceeded?: boolean;
}): SessionCompactionPressure {
  const cheapGatePassed = shouldRunSessionCompactionPreflight({
    messageCount: input.messageCount,
    roughHistoryTokens: input.roughHistoryTokens,
    protectFirstMessages: input.budget.protectFirstMessages,
    protectLastMessages: input.budget.protectLastMessages,
    thresholdTokens: input.budget.triggerTokens,
  });
  const nextRequestTokens = input.authoritativeNextRequestTokens;
  const authoritativeHistoryTokens = nextRequestTokens === null
    ? null
    : Math.max(
      0,
      finiteInteger(nextRequestTokens)
        - input.budget.outputReserveTokens
        - input.budget.fixedRequestTokens,
    );
  const hardRequestLimitExceeded = Boolean(input.payloadBudgetExceeded)
    || (nextRequestTokens !== null && nextRequestTokens > input.budget.contextWindowTokens);
  const authoritativePressureExceeded = hardRequestLimitExceeded
    || (authoritativeHistoryTokens !== null
      && authoritativeHistoryTokens >= input.budget.triggerTokens);

  return Object.freeze({
    cheapGatePassed,
    needsAuthoritativeEstimate: cheapGatePassed || hardRequestLimitExceeded,
    authoritativeHistoryTokens,
    authoritativePressureExceeded,
    hardRequestLimitExceeded,
    shouldCompact: authoritativePressureExceeded,
    providerActualInputTokens: input.providerActualInputTokens ?? null,
  });
}

export function sessionCompactionMadeProgress(input: {
  originalMessageCount: number;
  newMessageCount: number;
  originalTokens: number;
  newTokens: number;
}): boolean {
  if (input.newMessageCount < input.originalMessageCount) return true;
  return input.originalTokens > 0
    && input.newTokens < input.originalTokens * (1 - HERMES_COMPACTION_DEFAULTS.materialProgressRatio);
}

export function sessionCompactionWarrantsAnotherPass(input: {
  originalTokens: number;
  newTokens: number;
  thresholdTokens: number;
}): boolean {
  return input.newTokens >= input.thresholdTokens
    && input.originalTokens > 0
    && input.newTokens < input.originalTokens * (1 - HERMES_COMPACTION_DEFAULTS.materialProgressRatio);
}
