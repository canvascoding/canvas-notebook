import type { EmailClassificationFeedItem } from '@/app/lib/email/classification/feed-types';
import type { EmailClassificationMessageDetail } from '@/app/lib/email/classification/state-service';

/** The UI maps status/code to its own localized message; response text stays private. */
export class EmailClassificationClientError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super('The email state could not be updated.');
    this.name = 'EmailClassificationClientError';
  }
}

function responseError(status: number): EmailClassificationClientError {
  const code = status === 409 ? 'EMAIL_CLASSIFICATION_VERSION_CONFLICT'
    : status === 401 ? 'EMAIL_CLASSIFICATION_UNAUTHORIZED'
      : status === 403 ? 'EMAIL_CLASSIFICATION_FORBIDDEN'
        : status === 404 ? 'EMAIL_MESSAGE_UNAVAILABLE'
          : 'EMAIL_CLASSIFICATION_UPDATE_UNAVAILABLE';
  return new EmailClassificationClientError(status, code);
}

function validateFocusResponse(value: unknown, item: EmailClassificationFeedItem, done: boolean): EmailClassificationMessageDetail {
  if (!value || typeof value !== 'object') throw new EmailClassificationClientError(502, 'EMAIL_CLASSIFICATION_RESPONSE_INVALID');
  const detail = value as Partial<EmailClassificationMessageDetail>;
  const origin = detail.origin;
  if (!origin || !origin.capabilities || !detail.message || !('assessment' in detail)
    || !('classification' in detail) || typeof origin.capabilities.canRead !== 'boolean'
    || typeof origin.capabilities.canWrite !== 'boolean'
    || !Number.isSafeInteger(detail.personalFocus?.version)
    || (detail.personalFocus?.version ?? -1) <= item.personalFocus.version
    || detail.personalFocus?.done !== done
    || detail.classification !== null && (!detail.classification?.states || !detail.classification?.overrides
      || !Number.isSafeInteger(detail.classification?.version))) {
    throw new EmailClassificationClientError(502, 'EMAIL_CLASSIFICATION_RESPONSE_INVALID');
  }
  if (detail.messageRef !== item.messageRef || detail.selectionKey !== item.selectionKey
    || origin.mailboxRef !== item.origin.mailboxRef || origin.accountSource !== item.origin.accountSource
    || origin.accountOwnerId !== item.origin.accountOwnerId || origin.accountId !== item.origin.accountId
    || origin.accountScope !== item.origin.accountScope || origin.workspaceId !== item.origin.workspaceId
    || origin.mailboxId !== item.origin.mailboxId || origin.folder !== item.origin.folder
    || origin.canonicalId !== item.origin.canonicalId || !origin.capabilities.canRead) {
    throw new EmailClassificationClientError(404, 'EMAIL_MESSAGE_UNAVAILABLE');
  }
  return detail as EmailClassificationMessageDetail;
}

export async function setEmailPersonalFocusDone(item: EmailClassificationFeedItem, done: boolean, signal?: AbortSignal): Promise<EmailClassificationMessageDetail> {
  if (!item.origin.capabilities.canRead) throw responseError(403);
  if (!Number.isSafeInteger(item.personalFocus.version) || item.personalFocus.version < 0 || typeof done !== 'boolean') {
    throw new EmailClassificationClientError(400, 'EMAIL_CLASSIFICATION_REQUEST_INVALID');
  }
  try {
    if (signal?.aborted) throw new EmailClassificationClientError(0, 'EMAIL_CLASSIFICATION_REQUEST_ABORTED');
    const response = await fetch('/api/email/classification/focus', {
      method: 'PATCH', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageRef: item.messageRef, expectedVersion: item.personalFocus.version, done }),
    });
    if (signal?.aborted) throw new EmailClassificationClientError(0, 'EMAIL_CLASSIFICATION_REQUEST_ABORTED');
    if (!response.ok) throw responseError(response.status);
    const payload: unknown = await response.json();
    if (signal?.aborted) throw new EmailClassificationClientError(0, 'EMAIL_CLASSIFICATION_REQUEST_ABORTED');
    if (!payload || typeof payload !== 'object' || !('success' in payload) || payload.success !== true || !('data' in payload)) {
      throw new EmailClassificationClientError(502, 'EMAIL_CLASSIFICATION_RESPONSE_INVALID');
    }
    return validateFocusResponse(payload.data, item, done);
  } catch (error) {
    if (error instanceof EmailClassificationClientError) throw error;
    throw new EmailClassificationClientError(0, 'EMAIL_CLASSIFICATION_UPDATE_UNAVAILABLE');
  }
}
