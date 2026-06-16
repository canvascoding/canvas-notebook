import 'server-only';

import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core';

import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { readEmailMessage } from '@/app/lib/email/service';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { buildEmailComposeAgentSystemPrompt, buildEmailComposeAgentUserPrompt } from '@/app/lib/email/compose-agent/prompt';
import { createEmailWorkspaceTools } from '@/app/lib/email/compose-agent/workspace-tools';
import type {
  EmailComposeAgentEventSink,
  EmailComposeAgentInput,
  EmailComposeAgentResult,
  EmailComposeAgentUsedContext,
} from '@/app/lib/email/compose-agent/types';

const AGENT_TIMEOUT_MS = 90_000;
const MAX_TOOL_CALLS = 5;

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function multilineText(value: unknown): string {
  return String(value || '').replace(/\r\n?/gu, '\n').trim();
}

function emailBodyForAgent(message: Record<string, unknown>): string {
  return multilineText(message.body || message.snippet).slice(0, 18_000);
}

function emailMessageContext(message: Record<string, unknown>): string {
  return [
    `From: ${compactText(message.from)}`,
    `To: ${compactText(message.to)}`,
    `Cc: ${compactText(message.cc)}`,
    `Date: ${compactText(message.date)}`,
    `Subject: ${compactText(message.subject)}`,
    '',
    emailBodyForAgent(message),
  ].join('\n');
}

function assistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== 'assistant') return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function lastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') return message;
  }
  return undefined;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

function normalizeUsedContext(value: unknown): EmailComposeAgentUsedContext[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: EmailComposeAgentUsedContext[] = [];
  for (const entry of value) {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const path = String(record?.path || '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const reason = String(record?.reason || '').trim();
    output.push(reason ? { path, reason } : { path });
  }
  return output;
}

function parseFinalResult(text: string): EmailComposeAgentResult {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return {
      body: text.trim(),
      usedContext: [],
    };
  }

  const body = String(parsed.body || '').trim();
  if (!body) throw new Error('Workspace Agent returned no email body.');
  const subjectSuggestion = String(parsed.subjectSuggestion || '').trim();
  return {
    body,
    ...(subjectSuggestion ? { subjectSuggestion } : {}),
    usedContext: normalizeUsedContext(parsed.usedContext),
  };
}

async function originalMessageContext(userId: string, input: EmailComposeAgentInput): Promise<string | null> {
  if (!input.messageId) return null;
  const result = await readEmailMessage(userId, input.accountId, input.messageId, input.folder, { enforceReadPolicy: false });
  const message = result.message && typeof result.message === 'object'
    ? result.message as Record<string, unknown>
    : null;
  return message ? emailMessageContext(message) : null;
}

function previewToolResult(result: unknown): { preview: string; contextPath?: string } {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const content = Array.isArray(record.content)
    ? record.content
      .filter((part): part is { type: string; text?: unknown } => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
      .map((part) => String(part.text || ''))
      .join('\n')
    : '';
  const details = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  const contextPath = typeof details.path === 'string'
    ? details.path
    : undefined;
  const preview = content.trim().replace(/\s+/gu, ' ').slice(0, 240);
  return {
    preview: preview || 'Completed.',
    contextPath,
  };
}

export async function runEmailWorkspaceComposeAgent(
  userId: string,
  input: EmailComposeAgentInput,
  emit: EmailComposeAgentEventSink,
  requestSignal?: AbortSignal,
): Promise<EmailComposeAgentResult> {
  const instruction = input.instruction?.trim();
  if (!instruction) throw new Error('A writing instruction is required.');
  if (!input.accountId) throw new Error('accountId is required.');

  await emit({ type: 'status', label: 'Workspace Agent wird vorbereitet' });

  const effectiveConfig = await resolveAgentRuntimeConfig(DEFAULT_MANAGED_AGENT_ID);
  const apiKey = await resolvePiApiKey(effectiveConfig.model.provider);
  if (!apiKey) {
    throw new Error(`API key not configured for ${effectiveConfig.model.provider}. Configure it in Settings > Integrations.`);
  }

  const originalContext = await originalMessageContext(userId, input);
  let agent: Agent | null = null;
  const abortAgent = () => {
    agent?.abort();
  };
  const timeout = setTimeout(abortAgent, AGENT_TIMEOUT_MS);
  requestSignal?.addEventListener('abort', abortAgent, { once: true });
  let toolCallCount = 0;

  try {
    agent = new Agent({
      initialState: {
        model: effectiveConfig.model,
        systemPrompt: buildEmailComposeAgentSystemPrompt(input),
        tools: createEmailWorkspaceTools(),
      },
      getApiKey: () => apiKey,
      sessionId: `email-compose-agent:${Date.now()}`,
      toolExecution: 'sequential',
      beforeToolCall: async () => {
        toolCallCount += 1;
        if (toolCallCount > MAX_TOOL_CALLS) {
          return {
            block: true,
            reason: `Tool call limit reached (${MAX_TOOL_CALLS}). Finish the draft with the context already available.`,
          };
        }
        return undefined;
      },
    });

    agent.subscribe(async (event: AgentEvent) => {
      if (event.type === 'agent_start') {
        await emit({ type: 'status', label: 'Workspace Agent arbeitet' });
      }
      if (event.type === 'tool_execution_start') {
        await emit({ type: 'tool_start', id: event.toolCallId, toolName: event.toolName, args: event.args });
      }
      if (event.type === 'tool_execution_end') {
        const preview = previewToolResult(event.result);
        await emit({
          type: 'tool_end',
          id: event.toolCallId,
          toolName: event.toolName,
          resultPreview: preview.preview,
          contextPath: preview.contextPath,
        });
      }
    });

    const prompt = buildEmailComposeAgentUserPrompt(input, originalContext);
    await agent.prompt(prompt);

    const finalText = assistantText(lastAssistant(agent.state.messages));
    if (!finalText) throw new Error('Workspace Agent returned no content.');
    const result = parseFinalResult(finalText);
    await emit({ type: 'final', result });
    return result;
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener('abort', abortAgent);
  }
}
