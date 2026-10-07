import { DecisionModelError } from './errors.js';
import { decisionProviderRegistry } from './registry.js';
import type { DecisionAnswer, DecisionInput, DecisionProviderRegistry, DecisionResult } from './types.js';
import { isDecisionRecord, validateDecisionInput, validateDecisionResult } from './validation.js';

/** Evaluate exactly one explicit provider. Retry/fallback and product decisions belong to the caller. */
export async function evaluateDecision(input: DecisionInput, dependencies: {
  registry?: DecisionProviderRegistry;
  fetch?: typeof fetch;
} = {}): Promise<DecisionResult> {
  if (!isDecisionRecord(input) || !isDecisionRecord(input.configuration)
    || typeof input.configuration.providerId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(input.configuration.providerId)) {
    throw new DecisionModelError('invalid_request');
  }
  const provider = (dependencies.registry ?? decisionProviderRegistry).get(input.configuration.providerId);
  if (!provider) throw new DecisionModelError('missing_configuration', { providerId: input.configuration.providerId });
  validateDecisionInput(input, provider);
  if (input.signal?.aborted) throw new DecisionModelError('aborted', { providerId: provider.id });
  // Caller-side mutation while the request is in flight must not change the validated contract.
  const snapshot: DecisionInput = {
    ...input,
    state: JSON.parse(JSON.stringify(input.state)),
    questions: JSON.parse(JSON.stringify(input.questions)),
    configuration: { ...input.configuration },
    ...(input.credential ? { credential: { ...input.credential } } : {}),
  };
  const startedAt = performance.now();
  const timeoutMs = input.timeoutMs ?? 30_000;
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let removeAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onCombinedAbort = () => reject(new DecisionModelError(timedOut ? 'timeout' : 'aborted', { providerId: provider.id, retryable: timedOut }));
    controller.signal.addEventListener('abort', onCombinedAbort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', onCombinedAbort);
  });
  try {
    const result = await Promise.race([provider.evaluate(snapshot, { signal: controller.signal, timeoutMs, fetch: dependencies.fetch }), aborted]);
    if (controller.signal.aborted) throw new DecisionModelError(timedOut ? 'timeout' : 'aborted', { providerId: provider.id, retryable: timedOut });
    validateDecisionResult(result, snapshot, provider);
    const answers: Record<string, DecisionAnswer> = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
      if (answer.type === 'binary') return [id, { type: 'binary', probability: answer.probability }];
      const common = {
        ...(answer.probabilities === undefined ? {} : { probabilities: { ...answer.probabilities } }),
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      };
      return [id, answer.type === 'choice'
        ? { type: 'choice', choice: answer.choice, ...common }
        : { type: 'ordinal', score: answer.score, ...common }];
    }));
    return {
      answers,
      model: result.model,
      ...(result.usage === undefined ? {} : { usage: {
        requests: result.usage.requests,
        ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
      } }),
      providerId: provider.id,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      adapterVersion: provider.adapterVersion,
      probabilitySemantics: provider.capabilities.probabilitySemantics,
      ...(provider.capabilities.calibrationReference ? { calibrationReference: provider.capabilities.calibrationReference } : {}),
    };
  } catch (error) {
    if (error instanceof DecisionModelError) throw error;
    if (controller.signal.aborted) throw new DecisionModelError(timedOut ? 'timeout' : 'aborted', { providerId: provider.id, retryable: timedOut });
    throw new DecisionModelError('provider_error', { providerId: provider.id, retryable: true });
  } finally {
    clearTimeout(timer);
    removeAbort?.();
    input.signal?.removeEventListener('abort', onAbort);
  }
}
