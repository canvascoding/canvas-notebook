import { after, NextRequest } from 'next/server';

import { applyRateLimit, jsonError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { listEmailAccounts, listEmailMessages } from '@/app/lib/email/service';
import { loadCachedWorkspaceWidget } from '@/app/lib/home/workspace-widget-cache';
import {
  loadHomeWidgetAutomation,
  loadHomeWidgetStudio,
  loadHomeWidgetTodos,
} from '@/app/lib/home/workspace-widget-data';
import { loadHomeWidgetEmails } from '@/app/lib/home/workspace-email-widget';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

const TTL = {
  todos: 30_000,
  automation: 30_000,
  studio: 30_000,
} as const;

function requestFetcher(request: NextRequest) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const cookie = request.headers.get('cookie');
    if (cookie) headers.set('cookie', cookie);
    return fetch(new URL(value, request.nextUrl.origin), { ...init, headers });
  };
}

async function widgetResult<T>(load: () => Promise<T>) {
  try {
    return { status: 'ready' as const, ...(await load()) };
  } catch {
    return { status: 'error' as const, errorCode: 'source_unavailable' as const };
  }
}

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspaceId')?.trim();
  if (!workspaceId) return jsonError('Workspace is required', 400);
  const access = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (access.response) return access.response;
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'home-workspace-widgets' });
  if (limited) return limited;

  const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1';
  const fetcher = requestFetcher(request);
  const cacheInput = { userId: access.session.user.id, workspaceId, forceRefresh };
  const [emails, todos, automation, studio] = await Promise.all([
    widgetResult(() => loadHomeWidgetEmails(access.session.user.id, {
      scheduleBackgroundTask: after,
      services: { listAccounts: listEmailAccounts, listMessages: listEmailMessages },
    })),
    widgetResult(() => loadCachedWorkspaceWidget({ ...cacheInput, widget: 'todos', ttlMs: TTL.todos, load: () => loadHomeWidgetTodos(fetcher, workspaceId) })),
    widgetResult(() => loadCachedWorkspaceWidget({ ...cacheInput, widget: 'automation', ttlMs: TTL.automation, load: () => loadHomeWidgetAutomation(fetcher, workspaceId) })),
    widgetResult(() => loadCachedWorkspaceWidget({ ...cacheInput, widget: 'studio', ttlMs: TTL.studio, load: () => loadHomeWidgetStudio(fetcher, workspaceId) })),
  ]);

  return jsonSuccess({ data: { emails, todos, automation, studio } }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
