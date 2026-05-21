import assert from 'node:assert/strict';

import { getDefaultAutomationTargetOutputPath, getEffectiveAutomationTargetOutputPath } from '../app/lib/automations/paths';
import { buildAutomationPrompt } from '../app/lib/automations/prompt';
import { computeNextRunAt } from '../app/lib/automations/schedule';
import { type FriendlySchedule } from '../app/lib/automations/types';

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

assert.match(prompt, /If you create workspace deliverables, write them to: reports\/daily/);
assert.match(prompt, /Preferred skill: \/pdf/);
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
assert.match(composioPrompt, /Composio integration\/toolkit used: gmail/);
assert.match(composioPrompt, /Webhook source: managed/);

console.log('automation schedule tests passed');
