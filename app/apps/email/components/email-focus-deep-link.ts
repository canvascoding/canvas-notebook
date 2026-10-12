import type { NotebookEmailContextIntent } from '@/app/lib/notebook/context-surface';
import type { EmailClassificationFeedItem, EmailFeedMode, EmailFeedView } from '@/app/lib/email/classification/feed-types';
import { emailOriginSelectionKey } from '@/app/lib/email/classification/mailbox-types';

const views: readonly string[] = ['focus', 'all', 'important', 'reply', 'review', 'pending', 'other', 'spam', 'done'];
type SearchParams = Record<string, string | string[] | undefined>;

/** Home links carry references and presentation choices, never reconstructed sources. */
export function emailFocusIntentFromSearchParams(params: SearchParams): NotebookEmailContextIntent | null {
  const single = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;
  const messageRef = params.messageRef === undefined ? undefined : single(params.messageRef) ?? '';
  const mode = single(params.mode);
  const scope = single(params.scope);
  const view = single(params.view);
  const experienceMode = mode === 'focus' || mode === 'classic' ? mode as EmailFeedMode : undefined;
  const feedScope = scope === 'all' || scope === 'personal' || scope === 'work' ? scope : undefined;
  const feedView = view && views.includes(view) ? view as EmailFeedView : undefined;
  if (messageRef === undefined && !experienceMode && !feedScope && !feedView) return null;
  return { kind: 'email', toolCallId: null, toolName: 'email_focus_link', status: 'complete',
    view: messageRef === undefined ? 'message-list' : 'message',
    ...(messageRef !== undefined ? { messageRef: messageRef.slice(0, 1000) } : {}),
    experienceMode: experienceMode ?? 'focus', feedScope: feedScope ?? 'all', feedView: feedView ?? 'focus' };
}

export function emailFocusIntentKey(intent: NotebookEmailContextIntent | null): string | null {
  if (!intent || intent.messageRef === undefined && intent.experienceMode === undefined
    && intent.feedScope === undefined && intent.feedView === undefined) return null;
  return JSON.stringify([intent.toolCallId || intent.toolName, intent.messageRef ?? null,
    intent.experienceMode ?? 'focus', intent.feedScope ?? 'all', intent.feedView ?? 'focus']);
}

/** Reject mismatched or incomplete responses before any provider read can begin. */
export function resolvedEmailFocusMessage(value: unknown, messageRef: string): EmailClassificationFeedItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<EmailClassificationFeedItem>;
  const origin = item.origin;
  if (item.messageRef !== messageRef || !/^emm:[a-f0-9]{64}$/u.test(messageRef) || !origin
    || !/^emb:[a-f0-9]{64}$/u.test(origin.mailboxRef) || !['local', 'managed'].includes(origin.accountSource)
    || typeof origin.accountId !== 'string' || !origin.accountId || typeof origin.accountOwnerId !== 'string' || !origin.accountOwnerId
    || typeof origin.folder !== 'string' || !origin.folder || typeof origin.canonicalId !== 'string' || !origin.canonicalId
    || origin.workspaceId !== null && typeof origin.workspaceId !== 'string' || origin.capabilities?.canRead !== true
    || item.selectionKey !== emailOriginSelectionKey(origin) || !item.message || typeof item.message.subject !== 'string'
    || typeof item.message.from !== 'string' || typeof item.message.date !== 'string' || typeof item.message.snippet !== 'string'
    || typeof item.personalFocus?.done !== 'boolean' || !Number.isSafeInteger(item.personalFocus.version) || item.personalFocus.version < 0) return null;
  return item as EmailClassificationFeedItem;
}
