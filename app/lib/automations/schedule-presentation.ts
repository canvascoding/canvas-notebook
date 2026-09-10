import type { FriendlySchedule, AutomationWeekday } from './types';

export function describeFriendlyScheduleLocalized(
  schedule: FriendlySchedule,
  translate: (key: string, values?: Record<string, string | number>) => string,
  weekdayLabels: Record<AutomationWeekday, string>,
): string {
  let summary: string;
  if (schedule.kind === 'once') {
    summary = translate('scheduleSummary.once', { date: schedule.date, time: schedule.time });
  } else if (schedule.kind === 'daily') {
    summary = translate('scheduleSummary.daily', { time: schedule.times.join(', ') });
  } else if (schedule.kind === 'weekly') {
    summary = translate('scheduleSummary.weekly', {
      days: schedule.days.map((day) => weekdayLabels[day]).join(', '),
      time: schedule.times.join(', '),
    });
  } else if (schedule.kind === 'monthly') {
    summary = translate('scheduleSummary.monthly', {
      day: schedule.dayOfMonth,
      time: schedule.time,
    });
  } else if (schedule.kind === 'webhook') {
    summary = 'Webhook';
  } else {
    summary = translate('scheduleSummary.interval', {
      every: schedule.every,
      unit: translate(`intervalUnits.${schedule.unit}`),
    });
  }

  return translate('scheduleSummary.withTimeZone', { schedule: summary, timeZone: schedule.timeZone });
}
