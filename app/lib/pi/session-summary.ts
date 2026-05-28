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
  summaryAttempted: boolean;
  summaryUpdated: boolean;
  summaryFailed: boolean;
  unsummarizedMessageCount: number;
};

const SUMMARY_SYSTEM_PROMPT = [
  'You maintain a compact internal summary of a coding chat session for context window management.',
  'The summary is reference-only background for a future assistant turn, not active user instructions.',
  'Preserve durable information from older turns: current task state, decisions, constraints, important file paths, commands, tool results, user preferences, blockers, and remaining work.',
  'Do not quote long passages, do not include verbose chronology, do not preserve stale requests as new tasks, and do not repeat the most recent turns word-for-word.',
  'Return concise Markdown with stable sections when applicable: Active Task, Decisions, Files And Commands, Tool Results, Open Questions, User Preferences, Remaining Work.',
].join(' ');

const SUMMARY_UPDATE_PROMPT = [
  'Update the internal session summary using the prior summary and the older messages above.',
  'Merge related facts, remove obsolete details, and keep it compact but specific enough to resume the work safely.',
  'Clearly distinguish completed work from remaining work. Preserve exact file paths, command names, error messages, and user constraints when they matter.',
].join(' ');

const SUMMARY_MESSAGE_TEXT_LIMIT = 6000;
const SUMMARY_TOOL_TEXT_LIMIT = 3000;
const SUMMARY_TOOL_ARGUMENT_LIMIT = 1200;

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function truncateForSummary(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}\n…`;
}

function stringifyForSummary(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextForSummary(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringifyForSummary(content);
  }

  const parts = content.map((part) => {
    if (!part || typeof part !== 'object' || !('type' in part)) {
      return stringifyForSummary(part);
    }

    const typedPart = part as Record<string, unknown>;
    if (typedPart.type === 'text' && typeof typedPart.text === 'string') {
      return typedPart.text;
    }

    if (typedPart.type === 'image') {
      return '[Image omitted from summary input]';
    }

    if (typedPart.type === 'toolCall') {
      const name = typeof typedPart.name === 'string' ? typedPart.name : 'unknown_tool';
      const args = truncateForSummary(stringifyForSummary(typedPart.arguments ?? {}), SUMMARY_TOOL_ARGUMENT_LIMIT);
      return `[Tool call: ${name} ${args}]`;
    }

    return stringifyForSummary(typedPart);
  });

  return parts.filter(Boolean).join('\n');
}

function compactToolResultForSummary(message: AgentMessage): Message {
  const rawMessage = message as unknown as Record<string, unknown>;
  const toolName = typeof rawMessage.toolName === 'string'
    ? rawMessage.toolName
    : 'unknown_tool';
  const text = truncateForSummary(extractTextForSummary(rawMessage.content), SUMMARY_TOOL_TEXT_LIMIT);

  return {
    ...rawMessage,
    content: [{ type: 'text', text: `Tool result from ${toolName}:\n${text}` }],
  } as unknown as Message;
}

async function sanitizeMessagesForSummary(messages: AgentMessage[]): Promise<Message[]> {
  const normalized = await normalizePiMessagesForLlm(messages);

  return normalized.flatMap((message): Message[] => {
    if ((message as unknown as AgentMessage).role === 'toolResult') {
      return [compactToolResultForSummary(message as unknown as AgentMessage)];
    }

    if (message.role !== 'assistant') {
      // Strip images from user messages — summaries are text-only
      if (message.role === 'user' && Array.isArray(message.content)) {
        const textOnly = message.content.filter((part) => part.type === 'text');
        if (textOnly.length === 0) {
          return [{ ...message, content: [{ type: 'text', text: '[User attached image omitted from summary input]' }] }];
        }
        return [{
          ...message,
          content: textOnly.map((part) => ({
            ...part,
            text: truncateForSummary(part.text, SUMMARY_MESSAGE_TEXT_LIMIT),
          })),
        }];
      }
      return [message];
    }

    const content = message.content
      .filter((part) => part.type !== 'thinking')
      .map((part) => {
        if (part.type === 'text') {
          return {
            ...part,
            text: truncateForSummary(part.text, SUMMARY_MESSAGE_TEXT_LIMIT),
          };
        }

        if (part.type === 'toolCall') {
          return {
            type: 'text' as const,
            text: `[Tool call: ${part.name} ${truncateForSummary(stringifyForSummary(part.arguments ?? {}), SUMMARY_TOOL_ARGUMENT_LIMIT)}]`,
          };
        }

        return part;
      });
    if (content.length === 0) {
      return [];
    }

    return [{ ...message, content } as Message];
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
  let summaryAttempted = false;
  let summaryUpdated = false;
  let summaryFailed = false;
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
      summaryAttempted,
      summaryUpdated,
      summaryFailed,
      unsummarizedMessageCount: 0,
    };
  }

  try {
    summaryAttempted = true;
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
      summaryUpdated = true;

      composition = composePiHistoryForLlm({
        messages,
        summary: nextSummary,
        systemPromptTokens,
        contextWindow: model.contextWindow,
        modelMaxTokens: model.maxTokens,
        toolCount,
      });
    } else {
      summaryFailed = true;
    }
  } catch (error) {
    summaryAttempted = true;
    summaryFailed = true;
    console.warn(
      `[PI Summary] Failed to update summary${sessionId ? ` for ${sessionId}` : ''}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  return {
    summary: nextSummary,
    composition,
    summaryAttempted,
    summaryUpdated,
    summaryFailed,
    unsummarizedMessageCount: unsummarizedMessages.length,
  };
}
