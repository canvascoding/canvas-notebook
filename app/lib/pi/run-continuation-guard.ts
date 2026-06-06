import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import type { RuntimeContinuationReason } from '@/app/lib/pi/custom-messages';

export const TOOL_TAIL_CONTINUATION_PROMPT =
  '[System: The previous turn ended after tool results were produced but before the assistant processed them. Process the pending tool results first, summarize what was accomplished, and then continue the user\'s task.]';

export const INTERMEDIATE_ACK_CONTINUATION_PROMPT =
  '[System: Continue now. Execute the required tool calls and only send your final answer after completing the requested work or explaining a concrete blocker.]';

export const MAX_SYNTHETIC_CONTINUATIONS_PER_PROMPT = 2;

export type RuntimeContinuationDecision = {
  reason: RuntimeContinuationReason;
  prompt: string;
  assistantPreview?: string;
};

type IntermediateAckInput = {
  userMessage: string;
  assistantMessage: AssistantMessage;
  toolsAvailable: boolean;
  syntheticContinuationCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeText(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractAgentMessageText(message: AgentMessage | null | undefined): string {
  if (!message || !('content' in message)) {
    return '';
  }

  if (typeof message.content === 'string') {
    return normalizeText(message.content);
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return normalizeText(
    message.content
      .map((part) => (
        isRecord(part) && part.type === 'text' && typeof part.text === 'string'
          ? part.text
          : ''
      ))
      .filter(Boolean)
      .join('\n'),
  );
}

export function getLastLlmRelevantMessage(messages: AgentMessage[]): AgentMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === 'user'
      || message.role === 'assistant'
      || message.role === 'toolResult'
    ) {
      return message;
    }
  }
  return null;
}

export function historyEndsWithToolTail(messages: AgentMessage[]): boolean {
  return getLastLlmRelevantMessage(messages)?.role === 'toolResult';
}

export function assistantHasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((part) => isRecord(part) && part.type === 'toolCall');
}

function looksLikeClarification(text: string): boolean {
  return /(?:\?|soll ich|möchtest du|moechtest du|welche variante|welchen weg|which option|would you like|do you want|should i)\b/i.test(text);
}

function looksLikeFinalAnswer(text: string): boolean {
  return /\b(?:fertig|erledigt|alles ist fertig|abgeschlossen|done|completed|finished|here is|here are|hier ist|hier sind|deliverables|summary|zusammenfassung|ergebnis|result)\b/i.test(text);
}

function userPromptLooksExecutable(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized) return false;

  const planningOnly = /\b(?:plan|planung|fragen|formel|erklärung|erklaerung|explain|explanation|question|questions|formula)\b/i.test(normalized);
  const executionMarkers = /\b(?:erst|dann|danach|am ende|baue|bau|erstelle|erstellen|speichere|speichern|teste|testen|implementiere|umsetzen|setze|mach|führe|fuehre|lies|lese|recherchiere|extrahier|durchgehen|build|create|save|test|implement|run|read|research|extract|write|update|fix|then|afterwards|at the end)\b/i.test(normalized);
  const multiStepMarkers = /\b(?:erst|dann|danach|am ende|zum schluss|then|afterwards|at the end|finally)\b/i.test(normalized);

  if (planningOnly && !executionMarkers) {
    return false;
  }

  return executionMarkers || multiStepMarkers;
}

function assistantLooksLikeWorkAck(text: string): boolean {
  const hasFutureMarker = /(?:\bich\s+(?:prüfe|pruefe|schaue|lese|baue|erstelle|mache|recherchiere|teste|werde|gehe|extrahiere)\b|\blass mich\b|\bjetzt\s+(?:baue|erstelle|prüfe|pruefe|lese|mache|recherchiere|teste)\b|\bi['’]?ll\b|\bi will\b|\blet me\b|\bi(?:'|’)m going to\b)/i.test(text);
  const hasWorkMarker = /\b(?:prüfen|pruefen|schauen|lesen|bauen|erstellen|machen|recherchieren|testen|ausführen|ausfuehren|extrahieren|datei|script|excel|präsentation|praesentation|repo|code|command|file|spreadsheet|presentation|build|create|inspect|read|run|test|research|execute|extract)\b/i.test(text);
  return hasFutureMarker && hasWorkMarker;
}

export function shouldContinueAfterIntermediateAck({
  userMessage,
  assistantMessage,
  toolsAvailable,
  syntheticContinuationCount,
}: IntermediateAckInput): RuntimeContinuationDecision | null {
  if (!toolsAvailable) return null;
  if (syntheticContinuationCount >= MAX_SYNTHETIC_CONTINUATIONS_PER_PROMPT) return null;
  if (assistantMessage.stopReason === 'error' || assistantMessage.stopReason === 'aborted') return null;
  if (assistantHasToolCalls(assistantMessage)) return null;

  const assistantText = extractAgentMessageText(assistantMessage);
  if (!assistantText || assistantText.length > 1200) return null;
  if (looksLikeClarification(assistantText)) return null;
  if (looksLikeFinalAnswer(assistantText)) return null;
  if (!userPromptLooksExecutable(userMessage)) return null;
  if (!assistantLooksLikeWorkAck(assistantText)) return null;

  return {
    reason: 'intermediate_ack',
    prompt: INTERMEDIATE_ACK_CONTINUATION_PROMPT,
    assistantPreview: assistantText.slice(0, 200),
  };
}

export function createToolTailContinuationDecision(messages: AgentMessage[]): RuntimeContinuationDecision | null {
  if (!historyEndsWithToolTail(messages)) {
    return null;
  }

  return {
    reason: 'tool_tail',
    prompt: TOOL_TAIL_CONTINUATION_PROMPT,
  };
}
