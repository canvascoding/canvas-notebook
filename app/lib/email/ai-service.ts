import 'server-only';

import OpenAI from 'openai';

import { getOpenAIApiKeyFromIntegrations, readScopedEnvState } from '@/app/lib/integrations/env-config';

type AiEmailMessage = Record<string, unknown>;

const EMAIL_AI_INPUT_MAX_CHARS = 18_000;

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function emailBodyForAi(message: AiEmailMessage): string {
  return compactText(message.body || message.snippet).slice(0, EMAIL_AI_INPUT_MAX_CHARS);
}

async function emailAiModel(): Promise<string> {
  const state = await readScopedEnvState('integrations').catch(() => null);
  const values = new Map((state?.entries || []).map((entry) => [entry.key, entry.value]));
  return values.get('EMAIL_AI_MODEL')?.trim()
    || process.env.EMAIL_AI_MODEL?.trim()
    || process.env.OPENAI_MODEL?.trim()
    || 'gpt-4o-mini';
}

async function openAiClient(): Promise<{ client: OpenAI; model: string }> {
  const apiKey = await getOpenAIApiKeyFromIntegrations();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing. Configure it in Settings > Integrations.');
  }

  return {
    client: new OpenAI({ apiKey }),
    model: await emailAiModel(),
  };
}

export async function summarizeEmailWithAi(message: AiEmailMessage): Promise<string> {
  const { client, model } = await openAiClient();
  const body = emailBodyForAi(message);
  if (!body) throw new Error('Email has no readable body for AI summary.');

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 350,
    messages: [
      {
        role: 'system',
        content: 'Summarize the email for a busy operator. Keep it factual, concise, and action-oriented. Do not invent details.',
      },
      {
        role: 'user',
        content: [
          `From: ${compactText(message.from)}`,
          `To: ${compactText(message.to)}`,
          `Cc: ${compactText(message.cc)}`,
          `Date: ${compactText(message.date)}`,
          `Subject: ${compactText(message.subject)}`,
          '',
          body,
        ].join('\n'),
      },
    ],
  });

  const summary = completion.choices[0]?.message?.content?.trim();
  if (!summary) throw new Error('AI summary returned no content.');
  return summary;
}

export async function draftEmailReplyWithAi(message: AiEmailMessage): Promise<string> {
  const { client, model } = await openAiClient();
  const body = emailBodyForAi(message);
  if (!body) throw new Error('Email has no readable body for AI reply.');

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: [
          'Draft a plain-text email reply.',
          'Be concise, professional, and directly responsive.',
          'Do not include a subject line or markdown.',
          'Do not claim actions were completed unless the original email proves it.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `From: ${compactText(message.from)}`,
          `To: ${compactText(message.to)}`,
          `Cc: ${compactText(message.cc)}`,
          `Date: ${compactText(message.date)}`,
          `Subject: ${compactText(message.subject)}`,
          '',
          body,
        ].join('\n'),
      },
    ],
  });

  const reply = completion.choices[0]?.message?.content?.trim();
  if (!reply) throw new Error('AI reply returned no content.');
  return reply;
}
