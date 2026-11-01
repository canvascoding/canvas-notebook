import 'server-only';
import { types } from 'node:util';
import { ApiKeyAccessError } from './contracts';

export type ApiKeyDocumentFailureV1 = Readonly<{ apiVersion: 1; success: false; code: `API_KEY_${string}` }>;
function own(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value as unknown : undefined;
}
/** Denial data only. Never serialize the error, its message or credential details. */
export function apiKeyDocumentFailureV1(error: unknown): Readonly<{ body: ApiKeyDocumentFailureV1; status: number; retryAfter?: string }> | null {
  if (!error || typeof error !== 'object' || types.isProxy(error) || !(error instanceof ApiKeyAccessError)) return null;
  const code = own(error, 'code'), status = own(error, 'status');
  if (typeof code !== 'string' || code.length > 96 || !/^API_KEY_[A-Z_]+$/u.test(code)
    || typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return null;
  const details = own(error, 'details');
  const rawRetry = details && typeof details === 'object' && !types.isProxy(details) ? own(details, 'retryAfter') : undefined;
  const retry = typeof rawRetry === 'string' || typeof rawRetry === 'number' ? Number(rawRetry) : NaN;
  return Object.freeze({ body: Object.freeze({ apiVersion: 1, success: false, code: code as `API_KEY_${string}` }), status,
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: String(Math.min(60, Math.max(1, Math.ceil(retry)))) } : {}) });
}
