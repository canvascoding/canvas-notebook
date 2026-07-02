import 'server-only';

import crypto from 'crypto';

import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';

export type EmailPolicy = {
  readFrom: string[];
  sendTo: string[];
};

export type ManagedEmailAttachmentInput = {
  name: string;
  mimeType: string;
  size: number;
  contentBase64: string;
  contentId?: string;
  disposition?: 'attachment' | 'inline';
};

export type EmailDraftInput = {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  is_HTML?: boolean;
  attachments?: ManagedEmailAttachmentInput[];
};

export type ManagedEmailAccount = {
  id: string;
  provider: string;
  authType?: string;
  emailAddress: string;
  displayName: string | null;
  isPrimary?: boolean;
  status: string;
  scope?: string | null;
  expiresAt?: string | null;
  policy: EmailPolicy;
  createdAt?: string;
  updatedAt?: string;
};

export type ManagedEmailRequestScope = {
  userId?: string | null;
};

const MANAGED_EMAIL_USER_ID_PREFIX = 'canvas-notebook-email-';

export function isManagedEmailAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' &&
    Boolean(getManagedControlPlaneBaseUrl()) &&
    Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

function instanceToken(): string {
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!token) throw new Error('Managed email is not configured. Missing CANVAS_INSTANCE_TOKEN.');
  return token;
}

function controlPlaneUrl(path: string): string {
  const baseUrl = getManagedControlPlaneBaseUrl();
  if (!baseUrl) throw new Error('Managed email is not configured. Missing CANVAS_CONTROL_PLANE_URL.');
  return `${baseUrl}${path}`;
}

export function getManagedEmailOAuthRedirectUri(): string | null {
  const baseUrl = getManagedControlPlaneBaseUrl();
  return baseUrl ? `${baseUrl}/v1/managed/email/oauth/callback` : null;
}

export function getManagedEmailUserId(scope?: ManagedEmailRequestScope | null): string | null {
  const userId = scope?.userId?.trim();
  if (!userId) return null;
  const instanceId = process.env.CANVAS_INSTANCE_ID?.trim();
  const hash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  return instanceId
    ? `${MANAGED_EMAIL_USER_ID_PREFIX}${instanceId}-user-${hash}`
    : `${MANAGED_EMAIL_USER_ID_PREFIX}user-${hash}`;
}

function managedEmailHeaders(options?: RequestInit, scope?: ManagedEmailRequestScope | null): Headers {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && options.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${instanceToken()}`);
  const managedUserId = getManagedEmailUserId(scope);
  if (managedUserId) {
    headers.set('X-Canvas-Email-User-Id', managedUserId);
  }
  return headers;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Managed email request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export async function managedEmailRequest<T>(
  path: string,
  options?: RequestInit,
  scope?: ManagedEmailRequestScope | null,
): Promise<T> {
  if (!isManagedEmailAvailable()) {
    throw new Error('Managed email is not available. Configure local OAuth credentials or enable Canvas Managed Services.');
  }
  const response = await fetch(controlPlaneUrl(path), {
    ...options,
    headers: managedEmailHeaders(options, scope),
  });
  return readJson<T>(response);
}
