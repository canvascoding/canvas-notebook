import type { AutomationResultPolicy } from './types';

export const NO_ACTION_TOKEN = 'NO_ACTION';

export type AutomationResultClassification =
  | { kind: 'no_action'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'empty'; text: '' };

export function classifyAutomationResult(text: string, policy: AutomationResultPolicy): AutomationResultClassification {
  const normalizedText = text.trim();
  if (!normalizedText) return { kind: 'empty', text: '' };
  if (policy === 'deliver_relevant_only' && normalizedText === NO_ACTION_TOKEN) {
    return { kind: 'no_action', text: normalizedText };
  }
  return { kind: 'message', text: normalizedText };
}
