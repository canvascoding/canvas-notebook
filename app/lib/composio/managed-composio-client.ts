import 'server-only';

import { classifyComposioFailure, ComposioProviderError } from './composio-provider-error';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';
import type { ResolvedComposioContext } from './composio-context';

export type ManagedRequestOptions = { method?: string; body?: Record<string, unknown>; query?: URLSearchParams };
type Operation = 'read' | 'mutation' | 'execute';

function operationFor(path: string, method: string): Operation {
  if (path === '/execute') return 'execute';
  if (method !== 'GET' && !(path === '/tools/search' || path === '/tools/schemas')) return 'mutation';
  return 'read';
}

function timeoutFor(operation: Operation): number {
  return operation === 'execute' ? 120_000 : operation === 'mutation' ? 30_000 : 15_000;
}

function controlPlaneBaseUrl(): string {
  const baseUrl = getManagedControlPlaneBaseUrl();
  if (!baseUrl) throw new Error('CANVAS_CONTROL_PLANE_URL is required for managed Composio.');
  return baseUrl;
}

function instanceToken(): string {
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!token) throw new Error('CANVAS_INSTANCE_TOKEN is required for managed Composio.');
  return token;
}

function parsePayload(text: string): Record<string, unknown> {
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; } catch {
    throw new ComposioProviderError('Managed Composio returned an invalid response.', { code: 'COMPOSIO_BAD_RESPONSE', retryable: false });
  }
}

function canRetry(error: ComposioProviderError): boolean {
  return error.code === 'COMPOSIO_UNAVAILABLE' || (error.code === 'COMPOSIO_RATE_LIMITED' && (error.retryAfterMs ?? Infinity) <= 3000);
}

export async function requestManagedComposio<T>(path: string, options: ManagedRequestOptions = {}, context: ResolvedComposioContext): Promise<T> {
  const method = options.method || 'GET';
  const operation = operationFor(path, method);
  const url = new URL(`${controlPlaneBaseUrl()}/v1/managed/composio${path}`);
  options.query?.forEach((value, key) => url.searchParams.set(key, value));
  const body = options.body ? JSON.stringify({ ...options.body, composioUserId: context.composioUserId }) : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${instanceToken()}`,
    'X-Canvas-Composio-User-Id': context.composioUserId,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  for (let attempt = 0; attempt < (operation === 'read' ? 2 : 1); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutFor(operation));
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      const payload = parsePayload(await response.text());
      if (response.ok || payload.auth_required === true) return payload as T;
      const error = classifyComposioFailure({ status: response.status, headers: response.headers, payload, mutation: operation !== 'read' });
      if (attempt === 0 && operation === 'read' && canRetry(error)) {
        if (error.retryAfterMs) await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
        continue;
      }
      throw error;
    } catch (error) {
      const classified = error instanceof Error && error.name === 'ComposioProviderError'
        ? error as ComposioProviderError
        : classifyComposioFailure({ error, mutation: operation !== 'read', timeout: controller.signal.aborted });
      if (attempt === 0 && operation === 'read' && canRetry(classified)) {
        if (classified.retryAfterMs) await new Promise((resolve) => setTimeout(resolve, classified.retryAfterMs));
        continue;
      }
      throw classified;
    } finally {
      clearTimeout(timer);
    }
  }
  throw classifyComposioFailure({ payload: { error: 'Managed Composio request failed.' } });
}
