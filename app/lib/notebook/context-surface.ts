import type { ChatEvent } from '@/app/lib/chat/types';
import type {
  EmailAgentUiScope,
  EmailAgentUiView,
} from '@/app/lib/email/agent-ui-intent';
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
  view?: EmailAgentUiView;
  mailboxId?: string;
  accountId?: string;
  emailAddress?: string;
  scope?: EmailAgentUiScope;
  workspaceId?: string;
  draftId?: string;
  folder?: string;
  messageId?: string;
  threadId?: string;
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

function emailView(value: unknown): EmailAgentUiView | undefined {
  return typeof value === 'string' && [
    'mailboxes',
    'message-list',
    'message',
    'thread',
    'cases',
    'case',
    'review-draft',
    'review-center',
  ].includes(value)
    ? value as EmailAgentUiView
    : undefined;
}

function emailScope(value: unknown): EmailAgentUiScope | undefined {
  return value === 'personal' || value === 'workspace' ? value : undefined;
}

function emailIntent(
  event: ChatEvent,
  status: NotebookEmailContextIntent['status'],
): NotebookEmailContextIntent {
  const args = record(event.args);
  const details = record(event.result?.details ?? event.partialResult?.details);
  const uiIntent = record(details.uiIntent);
  const account = record(details.account);
  const message = record(details.message);
  const draft = record(details.draft);

  return {
    kind: 'email',
    toolCallId: event.toolCallId || null,
    toolName: event.toolName || 'email',
    status,
    view: emailView(uiIntent.view),
    mailboxId: stringValue(uiIntent.mailboxId, args.mailboxId, details.mailboxId),
    accountId: stringValue(uiIntent.accountId, args.accountId, account.id, details.accountId),
    emailAddress: stringValue(uiIntent.emailAddress, account.emailAddress, details.emailAddress),
    scope: emailScope(uiIntent.scope),
    workspaceId: stringValue(uiIntent.workspaceId, details.workspaceId),
    draftId: stringValue(uiIntent.draftId, args.draftId, draft.id, details.draftId, details.id),
    folder: stringValue(uiIntent.folder, args.folder, message.folder, details.folder),
    messageId: stringValue(uiIntent.messageId, args.messageId, message.id, details.messageId),
    threadId: stringValue(uiIntent.threadId, args.threadId, args.providerThreadId, message.threadId, details.threadId),
    query: stringValue(uiIntent.query, args.query),
    subject: stringValue(uiIntent.subject, args.subject, message.subject, draft.subject, details.subject),
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
