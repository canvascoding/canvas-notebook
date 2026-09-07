import assert from 'node:assert/strict';

import {
  loadHomeWidgetAutomation,
  loadHomeWidgetEmails,
  loadHomeWidgetStudio,
  loadHomeWidgetTodos,
} from '../app/lib/home/workspace-widget-data';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function main() {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/email/accounts') return response({ success: true, data: { accounts: [{ id: 'a', emailAddress: 'a@example.com' }, { id: 'b', emailAddress: 'b@example.com' }] } });
    if (url.startsWith('/api/email/folders')) return response({ success: true, data: { folders: [{ path: 'INBOX', role: 'inbox' }] } });
    if (url === '/api/email/messages/list') {
      const accountId = JSON.parse(String(init?.body)).accountId;
      return response({ success: true, data: { messages: [{ id: accountId, subject: `Mail ${accountId}`, date: accountId === 'b' ? '2026-09-07T12:00:00Z' : '2026-09-07T11:00:00Z', isRead: false }] } });
    }
    if (url.startsWith('/api/todos?')) return response({ success: true, data: [{ id: 'todo', title: 'Critical task', priority: 'high', dueAt: null, readState: 'unread' }] });
    if (url === '/api/automations/jobs') return response({ success: true, data: [{ id: 'other', name: 'Other', workspaceId: 'other', status: 'active', updatedAt: '2026-09-07T13:00:00Z' }, { id: 'job', name: 'Workspace job', workspaceId: 'workspace', status: 'active', lastRunAt: '2026-09-07T12:00:00Z', lastRunStatus: 'success' }] });
    if (url === '/api/automations/jobs/job/runs') return response({ success: true, data: [{ createdAt: '2026-09-07T12:00:00Z', resultText: 'Campaign updated' }] });
    if (url.startsWith('/api/studio/generations?')) return response({ success: true, generations: [{ id: 'generation', prompt: 'Editorial product', createdAt: '2026-09-07T12:00:00Z', status: 'completed', outputs: [{ id: 'output', mediaUrl: '/preview.png', mimeType: 'image/png' }] }] });
    return response({ success: false }, 404);
  };

  const emails = await loadHomeWidgetEmails(fetcher);
  assert.deepEqual(emails.map((email) => email.id), ['b', 'a']);
  assert.equal(emails[0]?.accountLabel, 'b@example.com');

  const todos = await loadHomeWidgetTodos(fetcher, 'workspace');
  assert.equal(todos[0]?.priority, 'high');
  assert.ok(calls.some((url) => url.includes('workspaceId=workspace') && url.includes('scope=workspace')));

  const automation = await loadHomeWidgetAutomation(fetcher, 'workspace');
  assert.equal(automation?.id, 'job');
  assert.equal(automation?.resultText, 'Campaign updated');

  const studio = await loadHomeWidgetStudio(fetcher, 'workspace');
  assert.equal(studio?.output?.mediaUrl, '/preview.png');
  assert.ok(calls.some((url) => url.includes('/api/studio/generations?') && url.includes('workspaceId=workspace')));

  console.log('Home workspace widget data tests passed');
}

void main();
