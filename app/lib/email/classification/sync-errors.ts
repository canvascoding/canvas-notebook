/** Public ingestion diagnostics contain no provider text, credentials or mail content. */
export const EMAIL_MAILBOX_SYNC_ERROR_CODES = [
  'auth_required', 'rate_limited', 'timeout', 'provider_unavailable', 'content_invalid', 'sync_failed',
] as const;
export type EmailMailboxSyncErrorCode = typeof EMAIL_MAILBOX_SYNC_ERROR_CODES[number];

export function isEmailMailboxSyncErrorCode(value: unknown): value is EmailMailboxSyncErrorCode {
  return typeof value === 'string' && (EMAIL_MAILBOX_SYNC_ERROR_CODES as readonly string[]).includes(value);
}

export class EmailMailboxSyncError extends Error {
  constructor(readonly code: EmailMailboxSyncErrorCode) {
    super('Email mailbox ingestion failed.');
    this.name = 'EmailMailboxSyncError';
  }
}

/** Read structured fields only. Unknown and plain OAuth errors remain generic. */
export function emailMailboxSyncErrorCode(error: unknown, stage: 'provider' | 'content' | 'storage'): EmailMailboxSyncErrorCode {
  if (error instanceof EmailMailboxSyncError) return error.code;
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 3 && current && typeof current === 'object' && !visited.has(current); depth++) {
    visited.add(current);
    const structured = current as { code?: unknown; status?: unknown; statusCode?: unknown; authenticationFailed?: unknown; cause?: unknown };
    const code = typeof structured.code === 'string' ? structured.code : '';
    if (stage === 'content' && ['22P02', '22021', '2200U'].includes(code)) return 'content_invalid';
    if (stage === 'provider') {
      const status = typeof structured.status === 'number' ? structured.status : structured.statusCode;
      if (structured.authenticationFailed === true || status === 401 || status === 403) return 'auth_required';
      if (status === 429 || code === 'ETHROTTLE') return 'rate_limited';
      if (status === 408 || status === 504 || ['ETIMEOUT', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout';
      if (typeof status === 'number' && status >= 500 && status <= 599
        || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EConnectionClosed', 'UND_ERR_SOCKET'].includes(code)) return 'provider_unavailable';
    }
    current = structured.cause;
  }
  return 'sync_failed';
}
