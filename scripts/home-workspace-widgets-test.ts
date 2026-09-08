import assert from 'node:assert/strict';

import type { EmailResponseCacheMetadata } from '../app/lib/email/cache/read-through';
import { loadHomeWidgetEmails } from '../app/lib/home/workspace-email-widget';
import {
  loadHomeWidgetAutomation,
  loadHomeWidgetStudio,
  loadHomeWidgetTodos,
} from '../app/lib/home/workspace-widget-data';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function cache(input: Partial<EmailResponseCacheMetadata> = {}): EmailResponseCacheMetadata {
  return {
    enabled: true,
    scope: 'list',
    state: 'fresh',
    source: 'cache',
    generation: 1,
    fetchedAt: '2026-09-07T11:00:00.000Z',
    staleAt: '2026-09-07T11:01:00.000Z',
    expiresAt: '2026-09-14T11:00:00.000Z',
    refreshQueued: false,
    ...input,
  };
}

async function main() {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('/api/todos?')) return response({ success: true, data: [{ id: 'todo', title: 'Critical task', priority: 'high', dueAt: null, readState: 'unread' }] });
    if (url === '/api/automations/jobs') return response({ success: true, data: [{ id: 'other', name: 'Other', workspaceId: 'other', status: 'active', updatedAt: '2026-09-07T13:00:00Z' }, { id: 'job', name: 'Workspace job', workspaceId: 'workspace', status: 'active', lastRunAt: '2026-09-07T12:00:00Z', lastRunStatus: 'success' }] });
    if (url === '/api/automations/jobs/job/runs') return response({ success: true, data: [{ createdAt: '2026-09-07T12:00:00Z', resultText: 'Campaign updated' }] });
    if (url.startsWith('/api/studio/generations?')) return response({ success: true, generations: [{ id: 'generation', prompt: 'Editorial product', createdAt: '2026-09-07T12:00:00Z', status: 'completed', outputs: [{ id: 'output', mediaUrl: '/preview.png', mimeType: 'image/png' }] }] });
    return response({ success: false }, 404);
  };

  const listCalls: Array<{ accountId: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const scheduleBackgroundTask = () => undefined;
  const services = {
    listAccounts: async () => ({
      accounts: [
        { id: 'a', emailAddress: 'a@example.com' },
        { id: 'b', emailAddress: 'b@example.com' },
      ],
    }),
    listMessages: async (_userId: string, input: Record<string, unknown>, options: Record<string, unknown>) => {
      const accountId = String(input.accountId);
      listCalls.push({ accountId, input, options });
      if (accountId === 'b') {
        return {
          folder: 'INBOX',
          messages: [{ id: 'imap:v1:SU5CT1g:77:9001', folder: 'INBOX', subject: 'Mail b', date: '2026-09-07T12:00:00Z', isRead: false }],
          cache: cache({
            state: 'stale' as const,
            source: 'cache' as const,
            generation: 2,
            fetchedAt: '2026-09-07T10:00:00.000Z',
            staleAt: '2026-09-07T10:01:00.000Z',
            refreshQueued: true,
          }),
        };
      }
      return {
        folder: 'inbox',
        messages: [{ id: 'provider-id-a', subject: 'Mail a', date: '2026-09-07T11:00:00Z', isRead: false }],
        cache: cache({ source: 'provider' as const }),
      };
    },
  };

  const emails = await loadHomeWidgetEmails('user-a', { services, scheduleBackgroundTask });
  assert.deepEqual(emails.data.map((email) => email.id), ['imap:v1:SU5CT1g:77:9001', 'provider-id-a']);
  assert.equal(emails.data[0]?.id, 'imap:v1:SU5CT1g:77:9001', 'opaque provider IDs must be retained exactly');
  assert.equal(emails.data[1]?.folder, 'inbox', 'the central list response supplies the provider default folder');
  assert.deepEqual(listCalls.map((call) => call.accountId).sort(), ['a', 'b']);
  for (const call of listCalls) {
    assert.deepEqual(call.input, { accountId: call.accountId, filter: 'unread', limit: 3 });
    assert.equal(call.options.enforceReadPolicy, false);
    assert.equal(call.options.cacheMode, 'swr');
    assert.equal(call.options.scheduleBackgroundTask, scheduleBackgroundTask);
  }
  assert.equal(emails.cache.state, 'stale');
  assert.equal(emails.cache.source, 'mixed');
  assert.equal(emails.cache.refreshQueued, true);
  assert.equal(emails.cache.partial, false);
  assert.equal(emails.cache.fetchedAt, '2026-09-07T10:00:00.000Z');
  assert.equal(emails.stale, true);

  const reordered = await loadHomeWidgetEmails('user-a', {
    services: {
      ...services,
      listAccounts: async () => ({ accounts: [{ id: 'b', emailAddress: 'b@example.com' }, { id: 'a', emailAddress: 'a@example.com' }] }),
    },
    scheduleBackgroundTask,
  });
  assert.equal(reordered.cache.refreshToken, emails.cache.refreshToken, 'refresh tokens must not depend on account order');

  const partial = await loadHomeWidgetEmails('user-a', {
    services: {
      listAccounts: services.listAccounts,
      listMessages: async (userId, input, options) => {
        if (input.accountId === 'b') throw new Error('provider unavailable');
        return services.listMessages(userId, input, options);
      },
    },
  });
  assert.deepEqual(partial.data.map((email) => email.id), ['provider-id-a']);
  assert.equal(partial.cache.partial, true);
  assert.equal(partial.cache.accountCount, 2);
  assert.equal(partial.cache.successfulAccountCount, 1);
  assert.equal(partial.cache.state, 'fresh');
  assert.equal(partial.cache.source, 'provider');

  await assert.rejects(() => loadHomeWidgetEmails('user-a', {
    services: {
      listAccounts: services.listAccounts,
      listMessages: async () => { throw new Error('provider unavailable'); },
    },
  }), /Email widget data could not be loaded/u);

  const noAccounts = await loadHomeWidgetEmails('user-a', {
    services: {
      listAccounts: async () => ({ accounts: [] }),
      listMessages: async () => assert.fail('an empty account list must not query messages'),
    },
  });
  assert.deepEqual(noAccounts.data, []);
  assert.equal(noAccounts.cache.source, 'none');
  assert.equal(noAccounts.cache.state, 'fresh');
  assert.equal(noAccounts.cache.partial, false);

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
