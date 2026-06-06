import 'server-only';

const DEFAULT_INFO_THROTTLE_MS = 60 * 60 * 1000;

const lastInfoLogs = new Map<string, number>();

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
