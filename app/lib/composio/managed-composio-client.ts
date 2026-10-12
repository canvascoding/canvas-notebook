import 'server-only';

import { classifyComposioFailure, ComposioProviderError } from './composio-provider-error';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';
import type { ResolvedComposioContext } from './composio-context';
import { managedComposioConnectionContext } from './composio-managed-connection-context';

export type ManagedRequestOptions = { method?: string; body?: Record<string, unknown>; query?: URLSearchParams;
  signal?: AbortSignal; bindingProtocolErrors?: boolean };
type Operation = 'read' | 'mutation' | 'execute';

type BindingProtocolCode = 'binding_changed' | 'schema_changed' | 'provider_denied' | 'tool_not_found';
export class ManagedComposioProtocolError extends Error {
  constructor(readonly code: BindingProtocolCode, readonly status: number) {
    super(code === 'binding_changed' ? 'The Composio connection changed. Reload the tool schema.'
      : code === 'schema_changed' ? 'The Composio tool schema changed. Reload it.'
        : code === 'provider_denied' ? 'The selected Composio app is not available to this user.'
          : 'The selected Composio tool is no longer available.');
    this.name = 'ManagedComposioProtocolError';
  }
}

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
  const sharedContext = managedComposioConnectionContext(context);
  const body = options.body ? JSON.stringify({ ...options.body, composioUserId: context.composioUserId,
    ...(sharedContext && path === '/execute' ? { bindingProtocolVersion: 2 } : {}) }) : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${instanceToken()}`,
    'X-Canvas-Composio-User-Id': context.composioUserId,
    ...(sharedContext ? { 'X-Canvas-Composio-Connection-Context': JSON.stringify(sharedContext) } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  for (let attempt = 0; attempt < (operation === 'read' ? 2 : 1); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutFor(operation));
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      signal.throwIfAborted();
      const response = await fetch(url, { method, headers, body, signal });
      const payload = parsePayload(await response.text());
      if (options.bindingProtocolErrors && [403, 404, 409].includes(response.status)
        && ['binding_changed', 'schema_changed', 'provider_denied', 'tool_not_found'].includes(String(payload.code))) {
        throw new ManagedComposioProtocolError(payload.code as BindingProtocolCode, response.status);
      }
      if (response.ok || payload.auth_required === true && !options.bindingProtocolErrors) return payload as T;
      const error = classifyComposioFailure({ status: response.status, headers: response.headers, payload, mutation: operation !== 'read' });
      if (attempt === 0 && operation === 'read' && canRetry(error) && !options.signal?.aborted) {
        if (error.retryAfterMs) await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
        continue;
      }
      throw error;
    } catch (error) {
      if (error instanceof ManagedComposioProtocolError) throw error;
      const classified = error instanceof Error && error.name === 'ComposioProviderError'
        ? error as ComposioProviderError
        : classifyComposioFailure({ error, mutation: operation !== 'read', timeout: controller.signal.aborted || options.signal?.aborted });
      if (attempt === 0 && operation === 'read' && canRetry(classified) && !options.signal?.aborted) {
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
