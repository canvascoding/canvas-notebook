import 'server-only';

import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveSystemLogsDir } from '@/app/lib/runtime-data-paths';

type OnboardingLogLevel = 'debug' | 'error' | 'info' | 'warn';

const SENSITIVE_KEY_PATTERN = /(secret|token|password|passphrase|credential|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key)/iu;
const MAX_STRING_LENGTH = 800;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 80;

function stringifyError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.slice(0, 2000),
    };
  }
  return { message: String(error) };
}

function sanitizeValue(value: unknown, depth = 0, keyHint = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return stringifyError(value);
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return '[MAX_DEPTH]';
  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeValue(entry, depth + 1, keyHint));
    if (value.length > MAX_ARRAY_LENGTH) entries.push(`[${value.length - MAX_ARRAY_LENGTH} more items truncated]`);
    return entries;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const entries = Object.entries(record).slice(0, MAX_OBJECT_KEYS);
    for (const [key, entry] of entries) {
      result[key] = sanitizeValue(entry, depth + 1, key);
    }
    const keyCount = Object.keys(record).length;
    if (keyCount > MAX_OBJECT_KEYS) result.__truncatedKeys = keyCount - MAX_OBJECT_KEYS;
    return result;
  }
  return String(value);
}

function onboardingLogPath(): string {
  return path.join(resolveSystemLogsDir(), 'onboarding.log');
}

export async function writeOnboardingLog(
  level: OnboardingLogLevel,
  event: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    context: sanitizeValue(context),
  };
  const line = `${JSON.stringify(entry)}\n`;

  try {
    const filePath = onboardingLogPath();
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await appendFile(filePath, line, { mode: 0o600 });
  } catch (error) {
    console.warn('[onboarding-log] Failed to write persistent log', error);
  }

  const consoleMessage = `[onboarding] ${event}`;
  if (level === 'error') {
    console.error(consoleMessage, entry.context);
  } else if (level === 'warn') {
    console.warn(consoleMessage, entry.context);
  } else {
    console.info(consoleMessage, entry.context);
  }
}
