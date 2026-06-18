export const DEFAULT_USER_TIME_ZONE = 'Europe/Berlin';

const FALLBACK_TIME_ZONE = 'UTC';

const COMMON_TIME_ZONES = [
  DEFAULT_USER_TIME_ZONE,
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Vienna',
  'Europe/Zurich',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'Europe/Rome',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

function canFormatInTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeZone(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && canFormatInTimeZone(value.trim());
}

export function normalizeTimeZone(value: unknown, fallback = DEFAULT_USER_TIME_ZONE): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (isValidTimeZone(candidate)) {
    return candidate;
  }

  if (fallback && canFormatInTimeZone(fallback)) {
    return fallback;
  }

  return FALLBACK_TIME_ZONE;
}

export function resolveRuntimeTimeZone(fallback = DEFAULT_USER_TIME_ZONE): string {
  const runtimeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return normalizeTimeZone(runtimeTimeZone, fallback);
}

function getTimeZoneOffset(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
    if (offset === 'GMT') {
      return 'UTC+00:00';
    }
    if (offset?.startsWith('GMT')) {
      return offset.replace('GMT', 'UTC');
    }
  } catch {
    // Fall through to UTC if offset formatting is unavailable.
  }

  return 'UTC+00:00';
}

export function formatZonedDateTimeForPrompt(value: string | number | Date, timeZone: string): {
  localDateTime: string;
  timeZone: string;
  utcOffset: string;
} {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const date = new Date(value);
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const localDateTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: normalizedTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(validDate);

  return {
    localDateTime,
    timeZone: normalizedTimeZone,
    utcOffset: getTimeZoneOffset(validDate, normalizedTimeZone),
  };
}

export function getSupportedTimeZones(currentTimeZone?: string): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [];
  const normalizedCurrentTimeZone = isValidTimeZone(currentTimeZone) ? currentTimeZone.trim() : null;
  const zones = new Set<string>([
    ...COMMON_TIME_ZONES,
    ...supported,
    ...(normalizedCurrentTimeZone ? [normalizedCurrentTimeZone] : []),
  ]);

  return [
    DEFAULT_USER_TIME_ZONE,
    ...Array.from(zones)
      .filter((zone) => zone !== DEFAULT_USER_TIME_ZONE && canFormatInTimeZone(zone))
      .sort((left, right) => left.localeCompare(right)),
  ];
}
