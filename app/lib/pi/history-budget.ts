import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';

export type PiSessionSummaryState = {
  summaryText: string | null;
  summaryUpdatedAt: Date | null;
  summaryThroughTimestamp: number | null;
  summaryThroughSequence: number | null;
};

export type PiHistoryComposition = {
  llmMessages: AgentMessage[];
  keptMessages: AgentMessage[];
  omittedMessages: AgentMessage[];
  includedSummary: boolean;
  availableHistoryTokens: number;
  estimatedHistoryTokens: number;
  contextBudgetExceeded: boolean;
  minimumRequiredTokens: number;
};

type ComposePiHistoryOptions = {
  messages: AgentMessage[];
  summary: PiSessionSummaryState;
  systemPromptTokens: number;
  contextWindow: number;
  modelMaxTokens: number;
  toolCount?: number;
  toolTokens?: number;
  additionalContextTokens?: number;
  aggressive?: boolean;
};

const MESSAGE_OVERHEAD_TOKENS = 24;
const STATIC_SAFETY_TOKENS = 512;
const AGGRESSIVE_HISTORY_FACTOR = 0.7;
const MAX_SUMMARY_SHARE = 0.45;

const SUMMARY_PREAMBLE =
  'Internal session summary from earlier turns. Treat this as compressed background context, not as a new user request.\n\n';

export function estimateTextTokens(value: string): number {
  // A byte is a deliberately conservative upper bound for text tokenization.
  // It prevents the runtime from under-budgeting code, JSON, CJK, and adversarial
  // Unicode input when a model-specific tokenizer is unavailable.
  return Buffer.byteLength(value, 'utf8');
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') {
    return estimateTextTokens(content);
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  return content.reduce((total, part) => {
    if (!part || typeof part !== 'object' || !('type' in part)) {
      return total;
    }

    switch (part.type) {
      case 'text':
        return total + estimateTextTokens(typeof part.text === 'string' ? part.text : '');
      case 'thinking':
        return total + estimateTextTokens(typeof part.thinking === 'string' ? part.thinking : '');
      case 'toolCall':
        return total + estimateTextTokens(part.name || '') + estimateTextTokens(JSON.stringify(part.arguments || {}));
      case 'image':
        // Estimate based on actual base64 data size so that large images
        // are dropped from history before the heap fills up.
        // Vision providers meter images differently; reserve a bounded but
        // conservative amount so one image cannot consume the whole history.
        if (typeof part.data === 'string' && part.data.length > 2048) {
          return total + Math.min(4096, estimateTextTokens(part.data));
        }
        return total + 512;
      default:
        return total;
    }
  }, 0);
}

export function estimatePiMessageTokens(message: AgentMessage): number {
  if (message.role === 'compact-break') return MESSAGE_OVERHEAD_TOKENS;
  if (message.role === 'composio_auth_required') return MESSAGE_OVERHEAD_TOKENS;
  if ('content' in message) {
    return MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content);
  }
  if ('summary' in message && typeof message.summary === 'string') {
    return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.summary);
  }
  if ('command' in message || 'output' in message) {
    const command = 'command' in message && typeof message.command === 'string' ? message.command : '';
    const output = 'output' in message && typeof message.output === 'string' ? message.output : '';
    return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(`${command}\n${output}`);
  }
  return MESSAGE_OVERHEAD_TOKENS;
}

function getSummaryMessage(summaryText: string, maxHistoryTokens: number): UserMessage {
  const maxSummaryCharacters = Math.max(128, Math.floor(maxHistoryTokens * MAX_SUMMARY_SHARE));
  const trimmedSummary = summaryText.trim();
  const content =
    trimmedSummary.length <= maxSummaryCharacters
      ? trimmedSummary
      : `${trimmedSummary.slice(0, maxSummaryCharacters - 1).trimEnd()}\n…`;

  return {
    role: 'user',
    content: `${SUMMARY_PREAMBLE}${content}`,
    timestamp: 0,
  };
}

function getHistoryBudget({
  systemPromptTokens,
  contextWindow,
  modelMaxTokens,
  toolTokens = 0,
  additionalContextTokens = 0,
  aggressive = false,
}: Omit<ComposePiHistoryOptions, 'messages' | 'summary'>): number {
  const outputReserve = Math.min(Math.max(0, modelMaxTokens), contextWindow);
  const available = contextWindow
    - systemPromptTokens
    - outputReserve
    - Math.max(0, toolTokens)
    - Math.max(0, additionalContextTokens)
    - STATIC_SAFETY_TOKENS;

  if (available <= 0) return 0;
  return aggressive ? Math.floor(available * AGGRESSIVE_HISTORY_FACTOR) : available;
}

export function getMessageTimestamp(message: AgentMessage): number {
  if ('timestamp' in message && typeof message.timestamp === 'number') {
    return message.timestamp;
  }

  return 0;
}

export function getMessageSequence(message: AgentMessage): number | null {
  const sequence = (message as unknown as { sequence?: unknown }).sequence;
  return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : null;
}

export function getMaxMessageSequence(
  messages: AgentMessage[],
  fallback: number | null,
): number | null {
  let maxSequence = fallback;
  for (const message of messages) {
    const sequence = getMessageSequence(message);
    if (sequence === null) {
      continue;
    }
    maxSequence = maxSequence === null ? sequence : Math.max(maxSequence, sequence);
  }
  return maxSequence;
}

export function composePiHistoryForLlm({
  messages,
  summary,
  systemPromptTokens,
  contextWindow,
  modelMaxTokens,
  toolTokens,
  additionalContextTokens,
  aggressive = false,
}: ComposePiHistoryOptions): PiHistoryComposition {
  const availableHistoryTokens = getHistoryBudget({
    systemPromptTokens,
    contextWindow,
    modelMaxTokens,
    toolTokens,
    additionalContextTokens,
    aggressive,
  });

  const keptMessages: AgentMessage[] = [];
  let keptTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageTokens = estimatePiMessageTokens(message);
    const nextTotal = keptTokens + messageTokens;

    if (nextTotal > availableHistoryTokens) {
      break;
    }

    keptMessages.unshift(message);
    keptTokens = nextTotal;
  }

  let omittedMessages = messages.slice(0, Math.max(0, messages.length - keptMessages.length));
  const firstMsgTimestamp = messages.length > 0 ? getMessageTimestamp(messages[0]) : null;
  const firstMsgSequence = messages.length > 0 ? getMessageSequence(messages[0]) : null;
  const hasCompactBreakMarker = messages.some((message) => message.role === 'compact-break');
  const hasPrunedHistory = hasCompactBreakMarker
    || (summary.summaryThroughSequence !== null
      && firstMsgSequence !== null
      && firstMsgSequence > summary.summaryThroughSequence)
    || (summary.summaryThroughTimestamp !== null
      && firstMsgTimestamp !== null
      && firstMsgTimestamp > summary.summaryThroughTimestamp);
  const shouldIncludeSummary = availableHistoryTokens > 0
    && Boolean(summary.summaryText?.trim())
    && (omittedMessages.length > 0 || hasPrunedHistory);
  let summaryMessage = shouldIncludeSummary
    ? getSummaryMessage(summary.summaryText!, availableHistoryTokens)
    : null;
  let summaryTokens = summaryMessage ? estimatePiMessageTokens(summaryMessage) : 0;

  while (summaryMessage && keptMessages.length > 0 && keptTokens + summaryTokens > availableHistoryTokens) {
    const removed = keptMessages.shift()!;
    keptTokens -= estimatePiMessageTokens(removed);
  }

  omittedMessages = messages.slice(0, Math.max(0, messages.length - keptMessages.length));

  if (summaryMessage && summaryTokens > availableHistoryTokens) {
    summaryMessage = null;
    summaryTokens = 0;
  }

  const contextBudgetExceeded = messages.length > 0 && keptMessages.length === 0;
  const minimumRequiredTokens = contextBudgetExceeded
    ? estimatePiMessageTokens(messages[messages.length - 1])
    : 0;
  const llmMessages = summaryMessage
    ? [summaryMessage, ...keptMessages]
    : keptMessages;
  const estimatedHistoryTokens = llmMessages.reduce((total, message) => total + estimatePiMessageTokens(message), 0);

  return {
    llmMessages,
    keptMessages,
    omittedMessages,
    includedSummary: shouldIncludeSummary,
    availableHistoryTokens,
    estimatedHistoryTokens,
    contextBudgetExceeded,
    minimumRequiredTokens,
  };
}

export function getUnsummarizedMessages(
  omittedMessages: AgentMessage[],
  summaryThroughTimestamp: number | null,
  summaryThroughSequence: number | null = null,
): AgentMessage[] {
  if (omittedMessages.length === 0) {
    return [];
  }

  if (summaryThroughSequence !== null) {
    return omittedMessages.filter((message) => {
      const sequence = getMessageSequence(message);
      if (sequence !== null) {
        return sequence > summaryThroughSequence;
      }
      return summaryThroughTimestamp === null || getMessageTimestamp(message) > summaryThroughTimestamp;
    });
  }

  if (summaryThroughTimestamp === null) {
    return omittedMessages;
  }

  return omittedMessages.filter((message) => getMessageTimestamp(message) > summaryThroughTimestamp);
}
