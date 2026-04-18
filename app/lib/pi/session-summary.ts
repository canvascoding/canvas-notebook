import 'server-only';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { completeSimple, type AssistantMessage, type Message, type Model, type Api } from '@mariozechner/pi-ai';

import { resolvePiApiKey } from './api-key-resolver';
import {
  composePiHistoryForLlm,
  getMessageTimestamp,
  getUnsummarizedMessages,
  type PiHistoryComposition,
  type PiSessionSummaryState,
} from './history-budget';
import { normalizePiMessagesForLlm } from './message-normalization';

type PreparePiHistoryContextOptions = {
  messages: AgentMessage[];
  summary: PiSessionSummaryState;
  systemPromptTokens: number;
  model: Model<Api>;
  toolCount: number;
  sessionId?: string;
  signal?: AbortSignal;
};

type SummarizeHistoryInput = {
  previousSummaryText: string | null;
  messagesToSummarize: AgentMessage[];
  model: Model<Api>;
  sessionId?: string;
  signal?: AbortSignal;
};

export type PreparePiHistoryContextResult = {
  summary: PiSessionSummaryState;
  composition: PiHistoryComposition;
};

const SUMMARY_SYSTEM_PROMPT = [
  'You maintain a compact internal summary of a coding chat session for context window management.',
  'Summarize only durable information from older turns.',
  'Include facts, decisions, open tasks, important file paths, user preferences, and key tool results when relevant.',
  'Do not quote long passages, do not include verbose chronology, and do not repeat the most recent turns word-for-word.',
  'Return plain Markdown bullet lists only.',
].join(' ');

const SUMMARY_UPDATE_PROMPT = [
  'Update the internal session summary using the prior summary and the older messages above.',
  'Keep it compact and useful for future coding turns.',
  'Use sections only when they add value.',
].join(' ');

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

async function sanitizeMessagesForSummary(messages: AgentMessage[]): Promise<Message[]> {
  const normalized = await normalizePiMessagesForLlm(messages);

  return normalized.flatMap((message): Message[] => {
    if (message.role !== 'assistant') {
      // Strip images from user messages — summaries are text-only
      if (message.role === 'user' && Array.isArray(message.content)) {
        const textOnly = message.content.filter((part) => part.type === 'text');
        if (textOnly.length === 0) return [];
        return [{ ...message, content: textOnly }];
      }
      return [message];
    }

    const content = message.content.filter((part) => part.type !== 'thinking');
    if (content.length === 0) {
      return [];
    }

    return [{ ...message, content }];
  });
}

export async function summarizePiSessionHistory({
  previousSummaryText,
  messagesToSummarize,
  model,
  sessionId,
  signal,
}: SummarizeHistoryInput): Promise<string | null> {
  const apiKey = await resolvePiApiKey(model.provider);
  if (!apiKey) {
    return null;
  }

  const sanitizedMessages = await sanitizeMessagesForSummary(messagesToSummarize);
  if (sanitizedMessages.length === 0) {
    return previousSummaryText?.trim() || null;
  }

  const contextMessages: Message[] = [
    ...(previousSummaryText?.trim()
      ? [
          {
            role: 'user' as const,
            content: `Existing internal session summary:\n\n${previousSummaryText.trim()}`,
            timestamp: 0,
          },
        ]
      : []),
    ...sanitizedMessages,
    {
      role: 'user' as const,
      content: SUMMARY_UPDATE_PROMPT,
      timestamp: Date.now(),
    },
  ];

  const summaryMessage = await completeSimple(
    model,
    {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: contextMessages,
    },
    {
      apiKey,
      temperature: 0,
      maxTokens: Math.max(256, Math.min(model.maxTokens, 1200)),
      sessionId: sessionId ? `${sessionId}:summary` : undefined,
      signal,
    },
  );

  if (summaryMessage.stopReason === 'error' || summaryMessage.stopReason === 'aborted') {
    return null;
  }

  const text = extractAssistantText(summaryMessage);
  return text.length > 0 ? text : null;
}

export async function preparePiHistoryContext({
  messages,
  summary,
  systemPromptTokens,
  model,
  toolCount,
  sessionId,
  signal,
}: PreparePiHistoryContextOptions): Promise<PreparePiHistoryContextResult> {
  let nextSummary = summary;
  let composition = composePiHistoryForLlm({
    messages,
    summary: nextSummary,
    systemPromptTokens,
    contextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    toolCount,
  });

  const unsummarizedMessages = getUnsummarizedMessages(
    composition.omittedMessages,
    nextSummary.summaryThroughTimestamp,
  );

  if (unsummarizedMessages.length === 0) {
    return {
      summary: nextSummary,
      composition,
    };
  }

  try {
    const summaryText = await summarizePiSessionHistory({
      previousSummaryText: nextSummary.summaryText,
      messagesToSummarize: unsummarizedMessages,
      model,
      sessionId,
      signal,
    });

    if (summaryText?.trim()) {
      nextSummary = {
        summaryText: summaryText.trim(),
        summaryUpdatedAt: new Date(),
        summaryThroughTimestamp: unsummarizedMessages.reduce(
          (maxTimestamp, message) => Math.max(maxTimestamp, getMessageTimestamp(message)),
          nextSummary.summaryThroughTimestamp ?? 0,
        ),
      };

      composition = composePiHistoryForLlm({
        messages,
        summary: nextSummary,
        systemPromptTokens,
        contextWindow: model.contextWindow,
        modelMaxTokens: model.maxTokens,
        toolCount,
      });
    }
  } catch (error) {
    console.warn(
      `[PI Summary] Failed to update summary${sessionId ? ` for ${sessionId}` : ''}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  return {
    summary: nextSummary,
    composition,
  };
}
