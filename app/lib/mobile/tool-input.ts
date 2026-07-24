const SENSITIVE_KEY_PATTERN = /(secret|token|password|passphrase|credential|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key)/iu;
const SENSITIVE_ENV_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gu;
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 120;
const MAX_STRING_LENGTH = 24_000;
export const MAX_MOBILE_TOOL_INPUT_LENGTH = 80_000;

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|gh[pousr]|glpat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED-JWT]')
    .replace(SENSITIVE_ENV_ASSIGNMENT_PATTERN, '$1=[REDACTED]');
}

function redactMobileToolValue(value: unknown, depth = 0, keyHint = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(keyHint)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value);
    return redacted.length > MAX_STRING_LENGTH
      ? `${redacted.slice(0, MAX_STRING_LENGTH)}\n… [TRUNCATED]`
      : redacted;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return '[MAX DEPTH]';
  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => redactMobileToolValue(entry, depth + 1, keyHint));
    if (value.length > MAX_ARRAY_LENGTH) {
      entries.push(`[${value.length - MAX_ARRAY_LENGTH} more items truncated]`);
    }
    return entries;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const entries = Object.entries(record).slice(0, MAX_OBJECT_KEYS);
    for (const [key, entryValue] of entries) {
      result[key] = redactMobileToolValue(entryValue, depth + 1, key);
    }
    const keyCount = Object.keys(record).length;
    if (keyCount > MAX_OBJECT_KEYS) result.__truncatedKeys = keyCount - MAX_OBJECT_KEYS;
    return result;
  }
  return String(value);
}

export function formatMobileToolInput(value: unknown): string | null {
  if (value === undefined) return null;
  const redacted = redactMobileToolValue(value);
  let formatted: string;
  if (typeof redacted === 'string') {
    formatted = redacted;
  } else {
    try {
      formatted = JSON.stringify(redacted, null, 2);
    } catch {
      formatted = String(redacted);
    }
  }
  const normalized = formatted.trim();
  if (!normalized) return null;
  return normalized.length > MAX_MOBILE_TOOL_INPUT_LENGTH
    ? `${normalized.slice(0, MAX_MOBILE_TOOL_INPUT_LENGTH)}\n… [TRUNCATED]`
    : normalized;
}
