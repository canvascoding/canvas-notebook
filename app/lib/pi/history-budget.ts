import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { UserMessage } from '@mariozechner/pi-ai';

export type PiSessionSummaryState = {
  summaryText: string | null;
  summaryUpdatedAt: Date | null;
  summaryThroughTimestamp: number | null;
};

export type PiHistoryComposition = {
  llmMessages: AgentMessage[];
  keptMessages: AgentMessage[];
  omittedMessages: AgentMessage[];
  includedSummary: boolean;
  availableHistoryTokens: number;
  estimatedHistoryTokens: number;
};

type ComposePiHistoryOptions = {
  messages: AgentMessage[];
  summary: PiSessionSummaryState;
  systemPromptTokens: number;
  contextWindow: number;
  modelMaxTokens: number;
  toolCount: number;
  aggressive?: boolean;
};

const TOKENS_PER_CHARACTER = 0.25;
const MESSAGE_OVERHEAD_TOKENS = 24;
const TOOL_TOKENS_PER_TOOL = 900;
const MIN_HISTORY_TOKENS = 512;
const STATIC_SAFETY_TOKENS = 512;
const AGGRESSIVE_HISTORY_FACTOR = 0.7;
const MAX_SUMMARY_SHARE = 0.45;

const SUMMARY_PREAMBLE =
  'Internal session summary from earlier turns. Treat this as compressed background context, not as a new user request.\n\n';

export function estimateTextTokens(value: string): number {
  return Math.ceil(value.length * TOKENS_PER_CHARACTER);
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
        // A 5 MB base64 string ≈ 1.25M "tokens" at 0.25 chars/token,
        // but we cap per-image cost at 4096 to avoid starving the context.
        if (typeof part.data === 'string' && part.data.length > 2048) {
          return total + Math.min(4096, Math.ceil(part.data.length * TOKENS_PER_CHARACTER));
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
  return MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content);
}

function getSummaryMessage(summaryText: string, maxHistoryTokens: number): UserMessage {
  const maxSummaryCharacters = Math.max(400, Math.floor(maxHistoryTokens * MAX_SUMMARY_SHARE / TOKENS_PER_CHARACTER));
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
  toolCount,
  aggressive = false,
}: Omit<ComposePiHistoryOptions, 'messages' | 'summary'>): number {
  const outputReserve = Math.min(
    Math.max(512, Math.floor(contextWindow * 0.2)),
    Math.max(1024, Math.min(modelMaxTokens, 8192)),
  );
  const toolReserve = toolCount * TOOL_TOKENS_PER_TOOL;
  const available = Math.max(
    MIN_HISTORY_TOKENS,
    contextWindow - systemPromptTokens - outputReserve - toolReserve - STATIC_SAFETY_TOKENS,
  );

  return aggressive ? Math.max(MIN_HISTORY_TOKENS, Math.floor(available * AGGRESSIVE_HISTORY_FACTOR)) : available;
}

export function getMessageTimestamp(message: AgentMessage): number {
  if ('timestamp' in message && typeof message.timestamp === 'number') {
    return message.timestamp;
  }

  return 0;
}

export function composePiHistoryForLlm({
  messages,
  summary,
  systemPromptTokens,
  contextWindow,
  modelMaxTokens,
  toolCount,
  aggressive = false,
}: ComposePiHistoryOptions): PiHistoryComposition {
  const availableHistoryTokens = getHistoryBudget({
    systemPromptTokens,
    contextWindow,
    modelMaxTokens,
    toolCount,
    aggressive,
  });

  const keptMessages: AgentMessage[] = [];
  let keptTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageTokens = estimatePiMessageTokens(message);
    const nextTotal = keptTokens + messageTokens;

    if (keptMessages.length > 0 && nextTotal > availableHistoryTokens) {
      break;
    }

    keptMessages.unshift(message);
    keptTokens = nextTotal;
  }

  const omittedMessages = messages.slice(0, Math.max(0, messages.length - keptMessages.length));
  const firstMsgTimestamp = messages.length > 0 ? getMessageTimestamp(messages[0]) : null;
  const hasPrunedHistory = summary.summaryThroughTimestamp !== null
    && firstMsgTimestamp !== null
    && firstMsgTimestamp > summary.summaryThroughTimestamp;
  const shouldIncludeSummary = Boolean(summary.summaryText?.trim())
    && (omittedMessages.length > 0 || hasPrunedHistory);
  const llmMessages = shouldIncludeSummary
    ? [getSummaryMessage(summary.summaryText!, availableHistoryTokens), ...keptMessages]
    : keptMessages;
  const estimatedHistoryTokens = llmMessages.reduce((total, message) => total + estimatePiMessageTokens(message), 0);

  return {
    llmMessages,
    keptMessages,
    omittedMessages,
    includedSummary: shouldIncludeSummary,
    availableHistoryTokens,
    estimatedHistoryTokens,
  };
}

export function getUnsummarizedMessages(
  omittedMessages: AgentMessage[],
  summaryThroughTimestamp: number | null,
): AgentMessage[] {
  if (omittedMessages.length === 0) {
    return [];
  }

  if (summaryThroughTimestamp === null) {
    return omittedMessages;
  }

  return omittedMessages.filter((message) => getMessageTimestamp(message) > summaryThroughTimestamp);
}
