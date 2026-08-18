import 'server-only';

import crypto from 'crypto';

import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';

const AVAILABILITY_CACHE_TTL_MS = 60_000;

export type ManagedSystemEmailAvailability = {
  available: boolean;
  fromAddress: string | null;
  fromName: string | null;
};

export type ManagedSystemEmailInput = {
  purpose: 'todo_created' | 'todo_assigned' | 'invite' | 'auth_reset' | 'email_verification' | 'automation_alert';
  to: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  idempotencyKey: string;
};

type AvailabilityCache = {
  expiresAt: number;
  value: ManagedSystemEmailAvailability;
};

let availabilityCache: AvailabilityCache | null = null;

export function isManagedSystemEmailAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true'
    && Boolean(getManagedControlPlaneBaseUrl())
    && Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

function instanceToken(): string {
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!token) throw new Error('Managed system email is not configured. Missing CANVAS_INSTANCE_TOKEN.');
  return token;
}

function managedSystemEmailUrl(path: string): string {
  const baseUrl = getManagedControlPlaneBaseUrl();
  if (!baseUrl) throw new Error('Managed system email is not configured. Missing CANVAS_CONTROL_PLANE_URL.');
  return `${baseUrl}${path}`;
}

async function readResponse<T>(response: Response): Promise<T> {
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
    const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Managed system email request failed (${response.status}).`;
    throw new Error(error);
  }
  return payload as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${instanceToken()}`);
  if (init?.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(managedSystemEmailUrl(path), { ...init, headers });
  return readResponse<T>(response);
}

export async function getManagedSystemEmailAvailability(): Promise<ManagedSystemEmailAvailability> {
  if (!isManagedSystemEmailAvailable()) return { available: false, fromAddress: null, fromName: null };
  if (availabilityCache && availabilityCache.expiresAt > Date.now()) return availabilityCache.value;
  const payload = await request<{ systemEmail?: Partial<ManagedSystemEmailAvailability> }>('/v1/managed/system-email/status');
  const value = {
    available: payload.systemEmail?.available === true,
    fromAddress: typeof payload.systemEmail?.fromAddress === 'string' ? payload.systemEmail.fromAddress : null,
    fromName: typeof payload.systemEmail?.fromName === 'string' ? payload.systemEmail.fromName : null,
  };
  availabilityCache = { value, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS };
  return value;
}

export async function sendManagedSystemEmail(input: ManagedSystemEmailInput): Promise<{ messageId: string | null }> {
  if (!isManagedSystemEmailAvailable()) throw new Error('Managed system email is not available.');
  const payload = await request<{ messageId?: unknown }>('/v1/managed/system-email/send', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const messageId = payload.messageId;
  return { messageId: typeof messageId === 'string' && messageId.trim() ? messageId : null };
}

export function systemEmailIdempotencyKey(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
