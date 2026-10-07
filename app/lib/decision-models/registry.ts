import { DecisionModelError } from './errors';
import { openAIDecisionsProvider } from './providers/openai-decisions';
import { systemOneDecisionProvider } from './providers/systemone';
import { typesafeDecisionProvider } from './providers/typesafe';
import type { DecisionProvider, DecisionProviderRegistry } from './types';

/** Each registry is independent; adding a provider never mutates a process-global default. */
export function createDecisionProviderRegistry(providers: readonly DecisionProvider[] = [typesafeDecisionProvider, systemOneDecisionProvider, openAIDecisionsProvider]): DecisionProviderRegistry {
  const entries = new Map<string, DecisionProvider>();
  for (const provider of providers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(provider.id) || entries.has(provider.id)) {
      throw new DecisionModelError('invalid_request');
    }
    entries.set(provider.id, Object.freeze({
      ...provider,
      capabilities: Object.freeze({
        ...provider.capabilities,
        questionTypes: Object.freeze([...provider.capabilities.questionTypes]),
        ...(provider.capabilities.contextLimits ? { contextLimits: Object.freeze({ ...provider.capabilities.contextLimits }) } : {}),
      }),
    }));
  }
  return Object.freeze({ get: (providerId: string) => entries.get(providerId) });
}

export const decisionProviderRegistry = createDecisionProviderRegistry();
