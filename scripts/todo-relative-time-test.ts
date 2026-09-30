import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTodoDueDate, formatTodoRelativeTime, isTodoDueOverdue } from '../app/lib/todos/relative-time';

test('timed deadlines explain minutes, hours, days, weeks and overdue times', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  const relative = (value: string) => formatTodoRelativeTime(value, 'de', { dateOnly: false, now });
  assert.equal(relative('2026-09-30T10:15:00Z'), 'in 15 Minuten');
  assert.equal(relative('2026-09-30T12:00:00Z'), 'in 2 Stunden');
  assert.equal(relative('2026-10-03T10:00:00Z'), 'in 3 Tagen');
  assert.equal(relative('2026-10-21T10:00:00Z'), 'in 3 Wochen');
  assert.equal(relative('2026-09-30T08:00:00Z'), 'vor 2 Stunden');
  assert.equal(relative('2026-09-30T10:00:20Z'), 'jetzt');
  assert.equal(isTodoDueOverdue('2026-09-30T08:00:00Z', now), true);
  assert.equal(isTodoDueOverdue('2026-09-30', now), false);
  assert.equal(isTodoDueOverdue('2026-09-29', now), true);
  assert.equal(isTodoDueOverdue(null, now), false);
});

test('calendar due dates remain today through the whole local day across timezones and DST', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Berlin';
    assert.equal(formatTodoRelativeTime('2026-09-30T00:00:00.000Z', 'de', { now: new Date('2026-09-30T18:00:00Z') }), 'heute');
    assert.equal(formatTodoRelativeTime('2026-10-26', 'de', { now: new Date('2026-10-24T23:30:00Z') }), 'morgen');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(formatTodoRelativeTime('2026-09-30', 'en', { now: new Date('2026-10-01T02:00:00Z') }), 'today');
    assert.equal(formatTodoDueDate('2026-09-30T00:00:00.000Z', 'en'), 'Sep 30, 2026');
    assert.equal(formatTodoRelativeTime('2026-10-03', 'en', { now: new Date('2026-09-30T18:00:00Z') }), 'in 3 days');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('absent and invalid dates yield no visible metadata', () => {
  assert.equal(formatTodoRelativeTime(null, 'de'), null);
  assert.equal(formatTodoRelativeTime('invalid', 'de'), null);
  assert.equal(formatTodoDueDate(null, 'en'), null);
  assert.equal(formatTodoDueDate('invalid', 'en'), null);
});
