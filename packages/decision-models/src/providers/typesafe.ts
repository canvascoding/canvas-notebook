import type { DecisionProvider } from '../types.js';
import { evaluateSystemOne, systemOneDecisionProvider } from './systemone.js';

/** Official HTTP contract: https://docs.typesafe.ai/api (verified 2026-10-06). */
export const typesafeDecisionProvider: DecisionProvider = {
  id: 'typesafe',
  adapterVersion: 'typesafe-systemone.v1',
  capabilities: {
    ...systemOneDecisionProvider.capabilities,
    choiceProbabilities: 'required',
    ordinalProbabilities: 'required',
    contextLimits: { maxInputTokens: 64_000, maxStateAndQuestionTokens: 32_000 },
    probabilitySemantics: 'model_probability',
    calibrationReference: 'https://docs.typesafe.ai/confidence',
  },
  evaluate: (input, context) => evaluateSystemOne(input, context, true),
};
