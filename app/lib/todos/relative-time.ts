const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** Date picker values are persisted at UTC midnight, but represent a calendar day. */
export function isTodoDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/u.test(value);
}

export function isTodoDueOverdue(value: string | null, now = new Date()): boolean {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return isTodoDateOnly(value)
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    : date.getTime() < now.getTime();
}

export function formatTodoRelativeTime(value: string | null, locale: string,
  options: { dateOnly?: boolean; now?: Date } = {}): string | null {
  if (!value) return null;
  const date = new Date(value);
  const now = options.now ?? new Date();
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return null;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (options.dateOnly ?? isTodoDateOnly(value)) {
    // Calendar arithmetic avoids 23/25-hour days around daylight-saving changes.
    const days = Math.round((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / day);
    if (Math.abs(days) < 14) return formatter.format(days, 'day');
    return formatter.format(Math.sign(days) * Math.round(Math.abs(days) / 7), 'week');
  }
  const delta = date.getTime() - now.getTime();
  const magnitude = Math.abs(delta);
  if (magnitude < minute) return formatter.format(0, 'second');
  const [unit, duration]: [Intl.RelativeTimeFormatUnit, number] = magnitude < hour ? ['minute', minute]
    : magnitude < day ? ['hour', hour]
      : magnitude < 14 * day ? ['day', day] : ['week', 7 * day];
  return formatter.format(Math.sign(delta) * Math.max(1, Math.round(magnitude / duration)), unit);
}

export function formatTodoDueDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, isTodoDateOnly(value)
    ? { dateStyle: 'medium', timeZone: 'UTC' }
    : { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
