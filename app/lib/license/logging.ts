import 'server-only';

import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';

const DEFAULT_INFO_THROTTLE_MS = 60 * 60 * 1000;
const DEFAULT_ERROR_THROTTLE_MS = 60 * 1000;

const lastInfoLogs = new Map<string, number>();
const lastErrorLogs = new Map<string, number>();

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

export function logLicenseInfoThrottled(prefix: string, message: string, context: Record<string, unknown>, throttleMs = DEFAULT_INFO_THROTTLE_MS) {
  const signature = `${prefix} ${message} ${stableStringify(context)}`;
  const now = Date.now();
  const lastLoggedAt = lastInfoLogs.get(signature);

  if (lastLoggedAt && now - lastLoggedAt < throttleMs) {
    return;
  }

  lastInfoLogs.set(signature, now);
  console.info(`${prefix} ${message}`, context);
}

function redactLogValue(value: unknown, knownSecrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactTeamControlPlaneLogText(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, knownSecrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactLogValue(item, knownSecrets),
      ]),
    );
  }
  return value;
}

function errorLogContext(error: unknown, knownSecrets: readonly string[]): Record<string, unknown> {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      errorName: error.name,
      errorMessage: redactTeamControlPlaneLogText(error.message, knownSecrets),
    };
    if ('code' in error && typeof error.code === 'string') details.errorCode = error.code;
    if ('status' in error && typeof error.status === 'number') details.errorStatus = error.status;
    return details;
  }
  return { errorName: 'UnknownError' };
}

export function logLicenseError(
  prefix: string,
  message: string,
  context: Record<string, unknown>,
  error: unknown,
  options: {
    knownSecrets?: readonly string[];
    throttleMs?: number;
  } = {},
) {
  const knownSecrets = options.knownSecrets ?? [];
  const details = {
    ...redactLogValue(context, knownSecrets) as Record<string, unknown>,
    ...errorLogContext(error, knownSecrets),
  };
  const signature = `${prefix} ${message} ${stableStringify(details)}`;
  const now = Date.now();
  const lastLoggedAt = lastErrorLogs.get(signature);
  const throttleMs = options.throttleMs ?? DEFAULT_ERROR_THROTTLE_MS;

  if (lastLoggedAt && now - lastLoggedAt < throttleMs) {
    return;
  }

  lastErrorLogs.set(signature, now);
  console.error(`${prefix} ${message}`, details);
}
