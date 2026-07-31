import type { ChatEvent } from '@/app/lib/chat/types';
import type { BrowserSessionSnapshot } from '@/app/lib/pi/browser/types';

export type NotebookChatContext = {
  agentId: string;
  sessionId: string;
};

export type NotebookEmailContextIntent = {
  kind: 'email';
  toolCallId: string | null;
  toolName: string;
  status: 'running' | 'complete';
  accountId?: string;
  draftId?: string;
  folder?: string;
  messageId?: string;
  query?: string;
  subject?: string;
};

export type NotebookBrowserContextIntent = {
  kind: 'browser';
  toolCallId: string | null;
  toolName: 'browser';
  status: 'running' | 'complete';
  agentId: string;
  sessionId: string;
  snapshot: BrowserSessionSnapshot;
  action?: string;
  url?: string;
};

export type NotebookContextIntent =
  | NotebookEmailContextIntent
  | NotebookBrowserContextIntent;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function emailIntent(
  event: ChatEvent,
  status: NotebookEmailContextIntent['status'],
): NotebookEmailContextIntent {
  const args = record(event.args);
  const details = record(event.result?.details ?? event.partialResult?.details);
  const account = record(details.account);
  const message = record(details.message);
  const draft = record(details.draft);

  return {
    kind: 'email',
    toolCallId: event.toolCallId || null,
    toolName: event.toolName || 'email',
    status,
    accountId: stringValue(args.accountId, account.id, details.accountId),
    draftId: stringValue(args.draftId, draft.id, details.draftId),
    folder: stringValue(args.folder, message.folder, details.folder),
    messageId: stringValue(args.messageId, message.id, details.messageId),
    query: stringValue(args.query),
    subject: stringValue(args.subject, message.subject, draft.subject),
  };
}

function browserIntent(
  event: ChatEvent,
  status: NotebookBrowserContextIntent['status'],
  chatContext: NotebookChatContext,
  snapshot: BrowserSessionSnapshot,
): NotebookBrowserContextIntent {
  const args = record(event.args);
  return {
    kind: 'browser',
    toolCallId: event.toolCallId || null,
    toolName: 'browser',
    status,
    agentId: chatContext.agentId,
    sessionId: chatContext.sessionId,
    snapshot,
    action: stringValue(args.action),
    url: stringValue(snapshot.activeUrl, args.url),
  };
}

export function notebookContextIntentFromAgentEvent(
  event: ChatEvent,
  chatContext: NotebookChatContext | null,
  browserSnapshot?: BrowserSessionSnapshot | null,
): NotebookContextIntent | null {
  const isStart = event.type === 'tool_execution_start';
  const isEnd = event.type === 'tool_execution_end';
  const isUpdate = event.type === 'tool_execution_update';
  if (!isStart && !isEnd && !isUpdate) return null;

  const status = isEnd ? 'complete' : 'running';
  const toolName = event.toolName?.trim() || '';
  if (toolName.startsWith('email_')) {
    return emailIntent(event, status);
  }

  if (toolName === 'browser' && chatContext && browserSnapshot?.running) {
    const intent = browserIntent(event, status, chatContext, browserSnapshot);
    if (intent.action === 'help' || intent.action === 'status' || intent.action === 'close') {
      return null;
    }
    return intent;
  }

  return null;
}
