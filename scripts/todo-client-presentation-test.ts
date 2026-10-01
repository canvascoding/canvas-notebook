import assert from 'node:assert/strict';
import test from 'node:test';
import type { TodoItem } from '../app/lib/todos/client-types';
import { emptyForm, todoFormPayload, todoToForm, toLocalDateTimeInput } from '../app/lib/todos/client-presentation';

const todo: TodoItem = {
  id: 'todo-form-test', canWrite: true, createdByUserId: 'owner', assigneeUserId: 'assignee',
  organizationId: null, workspaceId: null, workspaceType: 'personal', scopeKind: 'user', workspace: null,
  title: 'Original title', description: 'Original description', status: 'open', priority: 'high', iconKey: 'eye',
  sourceType: 'user', sourceSessionId: null, dueAt: '2026-10-05T13:20:45.678Z',
  remindAt: '2026-10-04T10:34:56.789Z',
  completedAt: null, completionComment: null, followUpSentAt: null, followUpError: null,
  emailNotificationSentAt: null, emailNotificationError: null, archivedAt: null,
  createdAt: '2026-09-30T08:00:00Z', updatedAt: '2026-09-30T08:00:00Z',
  category: { id: 'category', name: 'Review', color: null, icon: 'search-check', isArchived: true, sortOrder: 0 },
  fileLinks: [{ id: 'file', workspaceId: null, workspaceType: 'personal', workspacePath: '/notes/test.md', label: 'Test' }],
  createdBy: { id: 'owner', name: 'Owner', email: null }, assignee: { id: 'assignee', name: 'Assignee', email: null },
};

test('editing unrelated fields preserves exact stored dates, assignments, category, and file links', () => {
  const form = { ...todoToForm(todo), title: ' Updated title ' };
  const payload = todoFormPayload(form, todo);
  assert.deepEqual(payload, { title: 'Updated title' });
  assert.equal('dueAt' in payload, false);
  assert.equal('remindAt' in payload, false);
  assert.equal('categoryId' in payload, false);
  assert.equal('assigneeUserId' in payload, false);
  assert.equal('fileLinks' in payload, false);
});

test('the reminder editor displays local wall-clock time in winter and summer', () => {
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Berlin';
    assert.equal(toLocalDateTimeInput('2026-10-04T10:34:56.789Z'), '2026-10-04T12:34');
    assert.equal(toLocalDateTimeInput('2026-01-04T10:34:56.789Z'), '2026-01-04T11:34');
    const form = { ...todoToForm(todo), remindAt: '2026-10-04T14:45' };
    assert.equal(todoFormPayload(form, todo).remindAt, '2026-10-04T12:45:00.000Z');
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('cleared fields become null and changed due dates remain date-only input values', () => {
  const form = { ...todoToForm(todo), dueAt: '2026-10-06', remindAt: '', description: '', assigneeUserId: '', categoryId: '', iconKey: '' as const, fileLinks: [] };
  const payload = todoFormPayload(form, todo);
  assert.equal(payload.dueAt, '2026-10-06');
  for (const field of ['remindAt', 'description', 'assigneeUserId', 'categoryId', 'iconKey'] as const) {
    assert.equal(payload[field], null);
  }
  assert.deepEqual(payload.fileLinks, []);
  assert.equal(todoFormPayload({ ...emptyForm, title: 'New' }).remindAt, null);
});

test('null and invalid timestamps produce empty editor fields', () => {
  assert.equal(toLocalDateTimeInput(null), '');
  assert.equal(toLocalDateTimeInput('invalid'), '');
  const form = todoToForm({ ...todo, dueAt: null, remindAt: null });
  assert.equal(form.dueAt, '');
  assert.equal(form.remindAt, '');
  assert.deepEqual(todoFormPayload(form, { ...todo, dueAt: null, remindAt: null }), {});
});
