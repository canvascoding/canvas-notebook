import 'server-only';

import { completeSimple, streamSimple, type AssistantMessage, type AssistantMessageEvent, type Message } from '@earendil-works/pi-ai';

import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';

type AiEmailMessage = Record<string, unknown>;

export type AiEmailComposeInput = {
  cc?: unknown;
  currentBody?: string;
  instruction?: string;
  message?: AiEmailMessage | null;
  mode?: 'compose' | 'forward' | 'reply' | 'reply-all';
  subject?: string;
  to?: unknown;
};

const EMAIL_AI_INPUT_MAX_CHARS = 18_000;

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function multilineText(value: unknown): string {
  return String(value || '').replace(/\r\n?/gu, '\n').trim();
}

function emailBodyForAi(message: AiEmailMessage): string {
  return multilineText(message.body || message.snippet).slice(0, EMAIL_AI_INPUT_MAX_CHARS);
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function messageContext(message: AiEmailMessage): string {
  const body = emailBodyForAi(message);
  return [
    `From: ${compactText(message.from)}`,
    `To: ${compactText(message.to)}`,
    `Cc: ${compactText(message.cc)}`,
    `Date: ${compactText(message.date)}`,
    `Subject: ${compactText(message.subject)}`,
    '',
    body,
  ].join('\n');
}

async function completeEmailAi(params: {
  maxTokens: number;
  messages: Message[];
  sessionId: string;
  systemPrompt: string;
  temperature: number;
}): Promise<string> {
  const effectiveConfig = await resolveAgentRuntimeConfig(DEFAULT_MANAGED_AGENT_ID);
  const apiKey = await resolvePiApiKey(effectiveConfig.model.provider);
  if (!apiKey) {
    throw new Error(`API key not configured for ${effectiveConfig.model.provider}. Configure it in Settings > Integrations.`);
  }

  const completion = await completeSimple(
    effectiveConfig.model,
    {
      systemPrompt: params.systemPrompt,
      messages: params.messages,
    },
    {
      apiKey,
      temperature: params.temperature,
      maxTokens: Math.max(256, Math.min(effectiveConfig.model.maxTokens, params.maxTokens)),
      sessionId: params.sessionId,
    },
  );

  if (completion.stopReason === 'error' || completion.stopReason === 'aborted') {
    throw new Error(completion.errorMessage || 'Email AI request failed.');
  }

  const text = extractAssistantText(completion);
  if (!text) throw new Error('Email AI returned no content.');
  return text;
}

async function streamEmailAi(params: {
  maxTokens: number;
  messages: Message[];
  sessionId: string;
  signal?: AbortSignal;
  systemPrompt: string;
  temperature: number;
}): Promise<AsyncIterable<AssistantMessageEvent>> {
  const effectiveConfig = await resolveAgentRuntimeConfig(DEFAULT_MANAGED_AGENT_ID);
  const apiKey = await resolvePiApiKey(effectiveConfig.model.provider);
  if (!apiKey) {
    throw new Error(`API key not configured for ${effectiveConfig.model.provider}. Configure it in Settings > Integrations.`);
  }

  return streamSimple(
    effectiveConfig.model,
    {
      systemPrompt: params.systemPrompt,
      messages: params.messages,
    },
    {
      apiKey,
      temperature: params.temperature,
      maxTokens: Math.max(256, Math.min(effectiveConfig.model.maxTokens, params.maxTokens)),
      sessionId: params.sessionId,
      signal: params.signal,
    },
  );
}

export async function summarizeEmailWithAi(message: AiEmailMessage): Promise<string> {
  const body = emailBodyForAi(message);
  if (!body) throw new Error('Email has no readable body for AI summary.');

  return completeEmailAi({
    temperature: 0.2,
    maxTokens: 350,
    sessionId: `email-summary:${Date.now()}`,
    systemPrompt: 'Summarize the email for a busy operator. Keep it factual, concise, and action-oriented. Do not invent details.',
    messages: [
      {
        role: 'user',
        content: messageContext(message),
        timestamp: Date.now(),
      },
    ],
  });
}

export async function summarizeEmailWithAiStream(
  message: AiEmailMessage,
  options: { signal?: AbortSignal } = {},
): Promise<AsyncIterable<AssistantMessageEvent>> {
  const body = emailBodyForAi(message);
  if (!body) throw new Error('Email has no readable body for AI summary.');

  return streamEmailAi({
    temperature: 0.2,
    maxTokens: 350,
    sessionId: `email-summary:${Date.now()}`,
    signal: options.signal,
    systemPrompt: 'Summarize the email for a busy operator. Keep it factual, concise, and action-oriented. Do not invent details.',
    messages: [
      {
        role: 'user',
        content: messageContext(message),
        timestamp: Date.now(),
      },
    ],
  });
}

export async function draftEmailReplyWithAi(message: AiEmailMessage, instruction?: string): Promise<string> {
  const body = emailBodyForAi(message);
  if (!body) throw new Error('Email has no readable body for AI reply.');

  return completeEmailAi({
    temperature: 0.4,
    maxTokens: 700,
    sessionId: `email-reply:${Date.now()}`,
    systemPrompt: [
      'Draft a plain-text email reply body.',
      'Be concise, professional, and directly responsive.',
      'Do not include a subject line, markdown, greetings that do not fit the thread, or quoted original text.',
      'Do not claim actions were completed unless the original email proves it.',
      instruction ? 'Follow the user instruction exactly where it does not conflict with safety or factuality.' : '',
    ].filter(Boolean).join(' '),
    messages: [
      {
        role: 'user',
        content: [
          instruction ? `User instruction:\n${instruction.trim()}` : 'User instruction: Draft a suitable reply.',
          '',
          'Original email:',
          messageContext(message),
        ].join('\n'),
        timestamp: Date.now(),
      },
    ],
  });
}

export async function draftEmailComposeWithAi(input: AiEmailComposeInput): Promise<string> {
  const instruction = input.instruction?.trim();
  if (!instruction) throw new Error('A writing instruction is required.');

  const hasOriginalMessage = Boolean(input.message);
  return completeEmailAi({
    temperature: 0.45,
    maxTokens: 800,
    sessionId: `email-compose:${Date.now()}`,
    systemPrompt: [
      'Write a plain-text email body for the user.',
      'Return only the body text. Do not include a subject line or markdown.',
      'Use the provided recipients, subject, current draft, and original email context only as context.',
      'Satisfy the user instruction clearly and avoid inventing facts.',
      hasOriginalMessage ? 'For replies or forwards, write only the new text that should appear above the quoted original message.' : '',
    ].filter(Boolean).join(' '),
    messages: [
      {
        role: 'user',
        content: [
          `Mode: ${input.mode || 'compose'}`,
          `To: ${compactText(input.to)}`,
          `Cc: ${compactText(input.cc)}`,
          `Subject: ${compactText(input.subject)}`,
          '',
          `User instruction:\n${instruction}`,
          '',
          input.currentBody?.trim() ? `Current draft body:\n${input.currentBody.trim()}` : '',
          '',
          input.message ? `Original email:\n${messageContext(input.message)}` : '',
        ].filter((part) => part.trim()).join('\n'),
        timestamp: Date.now(),
      },
    ],
  });
}
