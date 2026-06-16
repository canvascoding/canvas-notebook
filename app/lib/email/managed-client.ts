import 'server-only';

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

function managedEmailHeaders(options?: RequestInit): Headers {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && options.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${instanceToken()}`);
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

export async function managedEmailRequest<T>(path: string, options?: RequestInit): Promise<T> {
  if (!isManagedEmailAvailable()) {
    throw new Error('Managed email is not available. Configure local OAuth credentials or enable Canvas Managed Services.');
  }
  const response = await fetch(controlPlaneUrl(path), {
    ...options,
    headers: managedEmailHeaders(options),
  });
  return readJson<T>(response);
}
