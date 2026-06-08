import 'server-only';

import crypto from 'crypto';

type EmailLogLevel = 'error' | 'info' | 'warn';

type EmailLogPayload = {
  accountId?: string;
  action?: string;
  destination?: string;
  durationMs?: number;
  error?: unknown;
  folder?: string;
  messageId?: string;
  mode?: string;
  operation?: string;
  requestId?: string;
  status?: 'failed' | 'requested' | 'succeeded';
  userId?: string;
};

function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

function sanitizePayload(payload: EmailLogPayload) {
  return {
    accountId: payload.accountId,
    action: payload.action,
    destination: payload.destination,
    durationMs: payload.durationMs,
    error: errorMessage(payload.error),
    folder: payload.folder,
    messageIdHash: hashIdentifier(payload.messageId),
    mode: payload.mode,
    operation: payload.operation,
    requestId: payload.requestId,
    status: payload.status,
    userId: payload.userId,
  };
}

export function logEmailClientEvent(level: EmailLogLevel, event: string, payload: EmailLogPayload) {
  const message = `[EmailClient] ${event}`;
  const sanitized = sanitizePayload(payload);

  if (level === 'error') {
    console.error(message, sanitized);
    return;
  }

  if (level === 'warn') {
    console.warn(message, sanitized);
    return;
  }

  console.info(message, sanitized);
}
