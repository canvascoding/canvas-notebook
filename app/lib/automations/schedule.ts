import {
  type AutomationIntervalUnit,
  type AutomationWeekday,
  type FriendlySchedule,
} from './types';

const WEEKDAY_MAP: Record<AutomationWeekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function parseDateInput(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function normalizeTimeZone(value: string | undefined): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!value) {
    return fallback;
  }

  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return fallback;
  }
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type);
    return part?.value || '';
  };

  const weekdayRaw = getPart('weekday').toLowerCase().slice(0, 3);
  const weekday = weekdayRaw === 'sun'
    ? 0
    : weekdayRaw === 'mon'
      ? 1
      : weekdayRaw === 'tue'
        ? 2
        : weekdayRaw === 'wed'
          ? 3
          : weekdayRaw === 'thu'
            ? 4
            : weekdayRaw === 'fri'
              ? 5
              : 6;

  return {
    year: Number(getPart('year')),
    month: Number(getPart('month')),
    day: Number(getPart('day')),
    hour: Number(getPart('hour')),
    minute: Number(getPart('minute')),
    weekday,
  };
}

function findNextMatchingDate(
  start: Date,
  timeZone: string,
  matcher: (parts: ZonedDateParts) => boolean,
  maxMinutesToSearch: number,
): Date | null {
  const cursor = new Date(start.getTime());
  cursor.setSeconds(0, 0);

  for (let index = 0; index <= maxMinutesToSearch; index += 1) {
    if (matcher(getZonedDateParts(cursor, timeZone))) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  return null;
}

function intervalToMs(every: number, unit: AutomationIntervalUnit): number {
  if (unit === 'minutes') return every * 60_000;
  if (unit === 'hours') return every * 60 * 60_000;
  return every * 24 * 60 * 60_000;
}

export function validateFriendlySchedule(input: unknown): { schedule: FriendlySchedule | null; error: string | null } {
  if (!input || typeof input !== 'object') {
    return { schedule: null, error: 'Schedule is required.' };
  }

  const candidate = input as Record<string, unknown>;
  const kind = candidate.kind;
  if (kind !== 'once' && kind !== 'daily' && kind !== 'weekly' && kind !== 'interval') {
    return { schedule: null, error: 'Unsupported schedule kind.' };
  }

  const timeZone = normalizeTimeZone(typeof candidate.timeZone === 'string' ? candidate.timeZone : undefined);

  if (kind === 'once') {
    const date = typeof candidate.date === 'string' ? candidate.date.trim() : '';
    const time = typeof candidate.time === 'string' ? candidate.time.trim() : '';
    if (!parseDateInput(date) || !parseTimeInput(time)) {
      return { schedule: null, error: 'One-time schedules require a valid date and time.' };
    }
    return { schedule: { kind, date, time, timeZone }, error: null };
  }

  if (kind === 'daily') {
    const time = typeof candidate.time === 'string' ? candidate.time.trim() : '';
    if (!parseTimeInput(time)) {
      return { schedule: null, error: 'Daily schedules require a valid time.' };
    }
    return { schedule: { kind, time, timeZone }, error: null };
  }

  if (kind === 'weekly') {
    const days = Array.isArray(candidate.days)
      ? candidate.days.filter((value): value is AutomationWeekday =>
          value === 'mon' ||
          value === 'tue' ||
          value === 'wed' ||
          value === 'thu' ||
          value === 'fri' ||
          value === 'sat' ||
          value === 'sun')
      : [];
    const time = typeof candidate.time === 'string' ? candidate.time.trim() : '';
    if (!days.length || !parseTimeInput(time)) {
      return { schedule: null, error: 'Weekly schedules require at least one weekday and a valid time.' };
    }
    return { schedule: { kind, days, time, timeZone }, error: null };
  }

  const every = typeof candidate.every === 'number' ? candidate.every : Number(candidate.every);
  const unit = candidate.unit;
  if (!Number.isFinite(every) || every <= 0) {
    return { schedule: null, error: 'Interval schedules require a positive repeat value.' };
  }
  if (unit !== 'minutes' && unit !== 'hours' && unit !== 'days') {
    return { schedule: null, error: 'Interval schedules require a supported unit.' };
  }

  return {
    schedule: { kind, every: Math.floor(every), unit, timeZone },
    error: null,
  };
}

export function computeNextRunAt(
  schedule: FriendlySchedule,
  options?: { from?: Date; lastRunAt?: Date | null },
): Date | null {
  const from = options?.from ? new Date(options.from) : new Date();

  if (schedule.kind === 'interval') {
    const anchor = options?.lastRunAt ? new Date(options.lastRunAt) : from;
    return new Date(anchor.getTime() + intervalToMs(schedule.every, schedule.unit));
  }

  const timeZone = normalizeTimeZone(schedule.timeZone);
  const fromDate = new Date(from.getTime() + 60_000);

  if (schedule.kind === 'once') {
    const date = parseDateInput(schedule.date);
    const time = parseTimeInput(schedule.time);
    if (!date || !time) {
      return null;
    }
    return findNextMatchingDate(
      fromDate,
      timeZone,
      (parts) =>
        parts.year === date.year &&
        parts.month === date.month &&
        parts.day === date.day &&
        parts.hour === time.hour &&
        parts.minute === time.minute,
      370 * 24 * 60,
    );
  }

  if (schedule.kind === 'daily') {
    const time = parseTimeInput(schedule.time);
    if (!time) {
      return null;
    }
    return findNextMatchingDate(
      fromDate,
      timeZone,
      (parts) => parts.hour === time.hour && parts.minute === time.minute,
      3 * 24 * 60,
    );
  }

  const time = parseTimeInput(schedule.time);
  if (!time) {
    return null;
  }
  const weekdays = new Set(schedule.days.map((day) => WEEKDAY_MAP[day]));
  return findNextMatchingDate(
    fromDate,
    timeZone,
    (parts) => weekdays.has(parts.weekday) && parts.hour === time.hour && parts.minute === time.minute,
    10 * 24 * 60,
  );
}

export function describeFriendlySchedule(schedule: FriendlySchedule): string {
  if (schedule.kind === 'once') {
    return `Einmalig am ${schedule.date} um ${schedule.time}`;
  }
  if (schedule.kind === 'daily') {
    return `Täglich um ${schedule.time}`;
  }
  if (schedule.kind === 'weekly') {
    return `Wöchentlich (${schedule.days.join(', ')}) um ${schedule.time}`;
  }
  return `Alle ${schedule.every} ${schedule.unit}`;
}
