import 'server-only';

import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core';

import { assertEmailAiComposeInput } from '@/app/lib/email/ai-input-limits';
import { resolveScopedEmailAiRuntime } from '@/app/lib/email/ai-runtime';
import { htmlToPlainText, plainTextToEmailHtml } from '@/app/lib/email/html-conversion';
import { isLikelyHtmlEmailContent, normalizeEmailHtmlContent } from '@/app/lib/email/html-content';
import { readEmailMessage } from '@/app/lib/email/service';
import { buildEmailComposeAgentSystemPrompt, buildEmailComposeAgentUserPrompt } from '@/app/lib/email/compose-agent/prompt';
import { createEmailWorkspaceTools } from '@/app/lib/email/compose-agent/workspace-tools';
import type {
  EmailComposeAgentEventSink,
  EmailComposeAgentInput,
  EmailComposeAgentResult,
  EmailComposeAgentUsedContext,
} from '@/app/lib/email/compose-agent/types';
import {
  appendWorkspaceBrandPromptBlock,
  getWorkspaceBrandPromptBlock,
} from '@/app/lib/agents/workspace-brand-context';

const AGENT_TIMEOUT_MS = 90_000;
const MAX_TOOL_CALLS = 5;
const EMAIL_HEADER_MAX_CHARS = 2_000;

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, EMAIL_HEADER_MAX_CHARS);
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
    const rawBody = text.trim();
    const bodyHtml = isLikelyHtmlEmailContent(rawBody)
      ? normalizeEmailHtmlContent(rawBody)
      : plainTextToEmailHtml(rawBody);
    return {
      body: htmlToPlainText(bodyHtml) || rawBody,
      bodyHtml,
      usedContext: [],
    };
  }

  const rawBodyHtml = String(parsed.bodyHtml || '').trim();
  const bodyHtml = rawBodyHtml
    ? normalizeEmailHtmlContent(rawBodyHtml)
    : plainTextToEmailHtml(String(parsed.body || '').trim());
  const body = String(parsed.body || '').trim() || htmlToPlainText(bodyHtml);
  if (!body && !bodyHtml) throw new Error('Workspace Agent returned no email body.');
  const subjectSuggestion = String(parsed.subjectSuggestion || '').trim();
  return {
    body,
    bodyHtml,
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
  assertEmailAiComposeInput(input);
  const instruction = input.instruction?.trim();
  if (!instruction) throw new Error('A writing instruction is required.');
  if (!input.accountId) throw new Error('accountId is required.');

  await emit({ type: 'status', label: 'Workspace Agent wird vorbereitet' });

  if (requestSignal?.aborted) throw new Error('Email Workspace Agent request was aborted.');
  const runtime = await resolveScopedEmailAiRuntime({ userId, workspaceId: input.workspaceId });
  const brandContext = await getWorkspaceBrandPromptBlock(runtime.workspace.workspaceId);

  const originalContext = await originalMessageContext(userId, input);
  if (requestSignal?.aborted) throw new Error('Email Workspace Agent request was aborted.');
  let agent: Agent | null = null;
  let terminationReason: 'request' | 'timeout' | null = null;
  const abortAgent = (reason: 'request' | 'timeout') => {
    terminationReason ??= reason;
    agent?.abort();
  };
  const abortForTimeout = () => abortAgent('timeout');
  const abortForRequest = () => abortAgent('request');
  const timeout = setTimeout(abortForTimeout, AGENT_TIMEOUT_MS);
  requestSignal?.addEventListener('abort', abortForRequest, { once: true });
  let toolCallCount = 0;

  try {
    agent = new Agent({
      initialState: {
        model: runtime.model,
        thinkingLevel: runtime.thinkingLevel,
        systemPrompt: appendWorkspaceBrandPromptBlock(
          buildEmailComposeAgentSystemPrompt(input),
          brandContext,
        ),
        tools: createEmailWorkspaceTools({ userId, workspace: runtime.workspace }),
      },
      streamFn: runtime.streamFn,
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
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && event.assistantMessageEvent.delta) {
        await emit({ type: 'draft_delta', delta: event.assistantMessageEvent.delta });
      }
    });

    const prompt = buildEmailComposeAgentUserPrompt(input, originalContext);
    if (requestSignal?.aborted) throw new Error('Email Workspace Agent request was aborted.');
    await agent.prompt(prompt);
    if (terminationReason === 'timeout') {
      throw new Error('Email Workspace Agent timed out before producing a final draft.');
    }
    if (terminationReason === 'request' || requestSignal?.aborted) {
      throw new Error('Email Workspace Agent request was aborted.');
    }

    const finalText = assistantText(lastAssistant(agent.state.messages));
    if (!finalText) throw new Error('Workspace Agent returned no content.');
    const result = parseFinalResult(finalText);
    await emit({ type: 'final', result });
    return result;
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener('abort', abortForRequest);
  }
}
