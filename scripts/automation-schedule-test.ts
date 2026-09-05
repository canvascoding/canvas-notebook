import assert from 'node:assert/strict';

import { buildAutomationMutationPayload } from '../app/lib/automations/client-payload';
import { getDefaultAutomationTargetOutputPath, getEffectiveAutomationTargetOutputPath } from '../app/lib/automations/paths';
import { buildAutomationPrompt } from '../app/lib/automations/prompt';
import { computeNextRunAt, validateFriendlySchedule } from '../app/lib/automations/schedule';
import { type FriendlySchedule } from '../app/lib/automations/types';
import { DEFAULT_USER_TIME_ZONE, formatZonedDateTimeForPrompt } from '../app/lib/time-zones';

function assertDate(value: Date | null, message: string): Date {
  assert.ok(value instanceof Date, message);
  return value;
}

const dailySchedule: FriendlySchedule = {
  kind: 'daily',
  times: ['09:15'],
  timeZone: 'UTC',
};

const dailyRun = assertDate(
  computeNextRunAt(dailySchedule, { from: new Date('2026-03-14T08:00:00.000Z') }),
  'Daily schedule should produce a next run.',
);
assert.equal(dailyRun.toISOString(), '2026-03-14T09:15:00.000Z');

const defaultTimeZoneSchedule = validateFriendlySchedule({
  kind: 'daily',
  time: '09:15',
});
assert.equal(defaultTimeZoneSchedule.error, null);
assert.equal(defaultTimeZoneSchedule.schedule?.timeZone, DEFAULT_USER_TIME_ZONE);

const berlinPromptTime = formatZonedDateTimeForPrompt('2026-06-18T10:00:00.000Z', DEFAULT_USER_TIME_ZONE);
assert.equal(berlinPromptTime.localDateTime, '2026-06-18 12:00:00');
assert.equal(berlinPromptTime.utcOffset, 'UTC+02:00');

const berlinDailySchedule: FriendlySchedule = {
  kind: 'daily',
  times: ['15:30'],
  timeZone: DEFAULT_USER_TIME_ZONE,
};

const berlinDailyRun = assertDate(
  computeNextRunAt(berlinDailySchedule, { from: new Date('2026-06-18T10:00:00.000Z') }),
  'Daily Berlin schedule should convert local summer time to UTC.',
);
assert.equal(berlinDailyRun.toISOString(), '2026-06-18T13:30:00.000Z');

const berlinWeeklySchedule: FriendlySchedule = {
  kind: 'weekly',
  days: ['thu'],
  times: ['15:30'],
  timeZone: DEFAULT_USER_TIME_ZONE,
};

const berlinWeeklyRun = assertDate(
  computeNextRunAt(berlinWeeklySchedule, { from: new Date('2026-06-18T10:00:00.000Z') }),
  'Weekly Berlin schedule should convert local summer time to UTC.',
);
assert.equal(berlinWeeklyRun.toISOString(), '2026-06-18T13:30:00.000Z');

const berlinOnceSchedule: FriendlySchedule = {
  kind: 'once',
  date: '2026-06-18',
  time: '15:30',
  timeZone: DEFAULT_USER_TIME_ZONE,
};

const berlinOnceRun = assertDate(
  computeNextRunAt(berlinOnceSchedule, { from: new Date('2026-06-18T10:00:00.000Z') }),
  'One-time Berlin schedule should convert local summer time to UTC.',
);
assert.equal(berlinOnceRun.toISOString(), '2026-06-18T13:30:00.000Z');

const weeklySchedule: FriendlySchedule = {
  kind: 'weekly',
  days: ['mon', 'wed'],
  times: ['10:00'],
  timeZone: 'UTC',
};

const weeklyRun = assertDate(
  computeNextRunAt(weeklySchedule, { from: new Date('2026-03-14T08:00:00.000Z') }),
  'Weekly schedule should produce a next run.',
);
assert.equal(weeklyRun.toISOString(), '2026-03-16T10:00:00.000Z');

const monthlySchedule: FriendlySchedule = {
  kind: 'monthly',
  dayOfMonth: 1,
  time: '09:15',
  timeZone: 'UTC',
};

const monthlyRun = assertDate(
  computeNextRunAt(monthlySchedule, { from: new Date('2026-03-14T08:00:00.000Z') }),
  'Monthly schedule should produce the next requested day of month.',
);
assert.equal(monthlyRun.toISOString(), '2026-04-01T09:15:00.000Z');

const sameMonthRun = assertDate(
  computeNextRunAt({ ...monthlySchedule, dayOfMonth: 20 }, { from: new Date('2026-03-14T08:00:00.000Z') }),
  'Monthly schedule should still run in the current month when its day is ahead.',
);
assert.equal(sameMonthRun.toISOString(), '2026-03-20T09:15:00.000Z');

const lastDayRun = assertDate(
  computeNextRunAt(
    { ...monthlySchedule, dayOfMonth: 31 },
    { from: new Date('2026-02-01T08:00:00.000Z') },
  ),
  'Monthly schedules should use the last calendar day in shorter months.',
);
assert.equal(lastDayRun.toISOString(), '2026-02-28T09:15:00.000Z');

const yearRolloverRun = assertDate(
  computeNextRunAt(monthlySchedule, { from: new Date('2026-12-01T09:15:00.000Z') }),
  'Monthly schedules should advance across the year boundary.',
);
assert.equal(yearRolloverRun.toISOString(), '2027-01-01T09:15:00.000Z');

const berlinMonthlyRun = assertDate(
  computeNextRunAt(
    { ...monthlySchedule, timeZone: DEFAULT_USER_TIME_ZONE },
    { from: new Date('2026-03-29T10:00:00.000Z') },
  ),
  'Monthly Berlin schedule should convert local summer time to UTC.',
);
assert.equal(berlinMonthlyRun.toISOString(), '2026-04-01T07:15:00.000Z');

const validMonthlySchedule = validateFriendlySchedule({
  kind: 'monthly',
  dayOfMonth: '1',
  time: '09:15',
  timeZone: 'UTC',
});
assert.equal(validMonthlySchedule.error, null);
assert.deepEqual(validMonthlySchedule.schedule, monthlySchedule);

for (const dayOfMonth of [0, 1.5, 32]) {
  const invalidMonthlySchedule = validateFriendlySchedule({
    kind: 'monthly',
    dayOfMonth,
    time: '09:15',
    timeZone: 'UTC',
  });
  assert.equal(invalidMonthlySchedule.schedule, null);
  assert.match(invalidMonthlySchedule.error || '', /day of month between 1 and 31/);
}

const invalidMonthlyTime = validateFriendlySchedule({
  kind: 'monthly',
  dayOfMonth: 1,
  time: '25:00',
  timeZone: 'UTC',
});
assert.equal(invalidMonthlyTime.schedule, null);
assert.match(invalidMonthlyTime.error || '', /valid time/);

const intervalSchedule: FriendlySchedule = {
  kind: 'interval',
  every: 2,
  unit: 'hours',
  timeZone: 'UTC',
};

const intervalRun = assertDate(
  computeNextRunAt(intervalSchedule, {
    from: new Date('2026-03-14T08:00:00.000Z'),
    lastRunAt: new Date('2026-03-14T07:30:00.000Z'),
  }),
  'Interval schedule should produce a next run.',
);
assert.equal(intervalRun.toISOString(), '2026-03-14T09:30:00.000Z');

const workingHoursIntervalSchedule: FriendlySchedule = {
  kind: 'interval',
  every: 60,
  unit: 'minutes',
  timeZone: 'UTC',
  workingHours: {
    enabled: true,
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: '09:00',
    end: '18:00',
    timeZone: 'UTC',
  },
};

const workingHoursRun = assertDate(
  computeNextRunAt(workingHoursIntervalSchedule, {
    from: new Date('2026-03-16T10:00:00.000Z'),
    lastRunAt: new Date('2026-03-16T10:00:00.000Z'),
  }),
  'Interval schedule should run inside working hours.',
);
assert.equal(workingHoursRun.toISOString(), '2026-03-16T11:00:00.000Z');

const afterHoursRun = assertDate(
  computeNextRunAt(workingHoursIntervalSchedule, {
    from: new Date('2026-03-16T17:30:00.000Z'),
    lastRunAt: new Date('2026-03-16T17:30:00.000Z'),
  }),
  'Interval schedule should move after-hours runs to the next working window.',
);
assert.equal(afterHoursRun.toISOString(), '2026-03-17T09:00:00.000Z');

const weekendRun = assertDate(
  computeNextRunAt(workingHoursIntervalSchedule, {
    from: new Date('2026-03-14T10:00:00.000Z'),
    lastRunAt: new Date('2026-03-14T10:00:00.000Z'),
  }),
  'Interval schedule should move weekend runs to Monday morning.',
);
assert.equal(weekendRun.toISOString(), '2026-03-16T09:00:00.000Z');

const disabledWorkingHoursRun = assertDate(
  computeNextRunAt({
    ...workingHoursIntervalSchedule,
    workingHours: {
      ...workingHoursIntervalSchedule.workingHours!,
      enabled: false,
    },
  }, {
    from: new Date('2026-03-16T17:30:00.000Z'),
    lastRunAt: new Date('2026-03-16T17:30:00.000Z'),
  }),
  'Disabled working hours should keep the normal interval.',
);
assert.equal(disabledWorkingHoursRun.toISOString(), '2026-03-16T18:30:00.000Z');

const invalidWorkingHours = validateFriendlySchedule({
  ...workingHoursIntervalSchedule,
  workingHours: {
    ...workingHoursIntervalSchedule.workingHours!,
    start: '18:00',
    end: '09:00',
  },
});
assert.equal(invalidWorkingHours.schedule, null);
assert.match(invalidWorkingHours.error || '', /start time must be before/);

const oneTimeSchedule: FriendlySchedule = {
  kind: 'once',
  date: '2026-03-20',
  time: '14:45',
  timeZone: 'UTC',
};

const onceRun = assertDate(
  computeNextRunAt(oneTimeSchedule, { from: new Date('2026-03-14T08:00:00.000Z') }),
  'One-time schedule should produce a next run before the target date.',
);
assert.equal(onceRun.toISOString(), '2026-03-20T14:45:00.000Z');

assert.equal(
  getDefaultAutomationTargetOutputPath('Täglicher Markt-Check'),
  '',
);

assert.equal(
  getEffectiveAutomationTargetOutputPath({
    name: 'Täglicher Markt-Check',
    targetOutputPath: 'reports/daily',
  }),
  'reports/daily',
);

assert.equal(
  getEffectiveAutomationTargetOutputPath({
    name: 'Täglicher Markt-Check',
    targetOutputPath: null,
  }),
  '',
);

const prompt = buildAutomationPrompt({
  name: 'Daily Briefing',
  workspaceContextPaths: ['README.md'],
  prompt: 'Fasse die relevanten Dateien zusammen.',
  preferredSkill: 'pdf',
  effectiveTargetOutputPath: 'reports/daily',
});

assert.match(prompt, /Do not create workspace files unless the configured task explicitly requires a file/);
assert.match(prompt, /\*\*Automation name:\*\* Daily Briefing/);
assert.doesNotMatch(prompt, /Relevant workspace paths|reports\/daily|README\.md/);
assert.match(prompt, /\*\*Preferred skill:\*\* `\/pdf`/);
assert.match(prompt, /Run logs and metadata are stored automatically in the database/);

const composioPrompt = buildAutomationPrompt({
  name: 'Gmail Follow-up',
  workspaceContextPaths: [],
  prompt: 'Handle the incoming message.',
  preferredSkill: 'auto',
  effectiveTargetOutputPath: null,
  webhookContext: {
    provider: 'composio',
    source: 'managed',
    triggerSlug: 'GMAIL_NEW_MESSAGE',
    triggerId: 'trigger-123',
    toolkitSlug: 'gmail',
    eventId: 'event-123',
    timestamp: '2026-05-21T10:00:00.000Z',
    data: { subject: 'Hello' },
  },
});

assert.match(composioPrompt, /This run was started by a Composio trigger/);
assert.match(composioPrompt, /\*\*Composio integration\/toolkit used:\*\* gmail/);
assert.match(composioPrompt, /\*\*Webhook source:\*\* managed/);

const attentionPrompt = buildAutomationPrompt({
  name: 'Regular Workspace Check',
  workspaceContextPaths: [],
  prompt: 'Report only new attention.',
  preferredSkill: 'auto',
  effectiveTargetOutputPath: null,
  resultPolicy: 'deliver_relevant_only',
  workspaceEmailAttention: {
    openCaseCount: 1,
    overdueCaseCount: 0,
    reviewDraftCount: 1,
    sendFailureCount: 0,
    cases: [{ id: 'case-1', subject: 'Support request', status: 'new', priority: 'normal', updatedAt: '2026-08-15T10:00:00.000Z' }],
    drafts: [{ id: 'draft-1', subject: 'Re: Support request', status: 'awaiting_review', updatedAt: '2026-08-15T10:00:00.000Z' }],
  },
});
assert.match(attentionPrompt, /Workspace Email Attention/);
assert.match(attentionPrompt, /"reviewDraftCount": 1/);
assert.match(attentionPrompt, /If this queue has no change worth reporting/);

const createMutationPayload = buildAutomationMutationPayload(
  { name: 'Create automation' },
  { jobId: null, workspaceId: 'workspace-personal', scope: 'personal' },
);
assert.deepEqual(createMutationPayload, {
  name: 'Create automation',
  workspaceId: 'workspace-personal',
  scope: 'personal',
});

const updateMutationPayload = buildAutomationMutationPayload(
  { name: 'Update automation' },
  { jobId: 'job-existing', workspaceId: 'workspace-team', scope: 'organization' },
);
assert.deepEqual(
  updateMutationPayload,
  { name: 'Update automation' },
  'ordinary edits must omit workspace fields so workspace changes stay on the dedicated endpoint',
);
assert.equal('workspaceId' in updateMutationPayload, false);
assert.equal('scope' in updateMutationPayload, false);

console.log('automation schedule tests passed');
