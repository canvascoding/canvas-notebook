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
import { HOME_WIDGET_NAMES, parseHomeWidgetSelection } from '@/app/lib/home/workspace-widget-request';
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

  const requestedWidgets = parseHomeWidgetSelection(request.nextUrl.searchParams.get('widgets'), HOME_WIDGET_NAMES);
  if (!requestedWidgets) return jsonError('Invalid workspace widget selection', 400);
  const refreshParam = request.nextUrl.searchParams.get('refresh');
  const forceRefreshWidgets = refreshParam === '1'
    ? requestedWidgets
    : parseHomeWidgetSelection(refreshParam, []);
  if (!forceRefreshWidgets) return jsonError('Invalid workspace widget refresh selection', 400);
  const selected = new Set(requestedWidgets);
  const forced = new Set(forceRefreshWidgets);
  const fetcher = requestFetcher(request);
  const [emails, todos, automation, studio] = await Promise.all([
    selected.has('emails')
      ? widgetResult(() => loadHomeWidgetEmails(access.session.user.id, {
        scheduleBackgroundTask: after,
        services: { listAccounts: listEmailAccounts, listMessages: listEmailMessages },
      }))
      : undefined,
    selected.has('todos')
      ? widgetResult(() => loadCachedWorkspaceWidget({
        userId: access.session.user.id,
        workspaceId,
        forceRefresh: forced.has('todos'),
        widget: 'todos',
        ttlMs: TTL.todos,
        load: () => loadHomeWidgetTodos(fetcher, workspaceId),
      }))
      : undefined,
    selected.has('automation')
      ? widgetResult(() => loadCachedWorkspaceWidget({
        userId: access.session.user.id,
        workspaceId,
        forceRefresh: forced.has('automation'),
        widget: 'automation',
        ttlMs: TTL.automation,
        load: () => loadHomeWidgetAutomation(fetcher, workspaceId),
      }))
      : undefined,
    selected.has('studio')
      ? widgetResult(() => loadCachedWorkspaceWidget({
        userId: access.session.user.id,
        workspaceId,
        forceRefresh: forced.has('studio'),
        widget: 'studio',
        ttlMs: TTL.studio,
        load: () => loadHomeWidgetStudio(fetcher, workspaceId),
      }))
      : undefined,
  ]);

  return jsonSuccess({ data: {
    ...(emails ? { emails } : {}),
    ...(todos ? { todos } : {}),
    ...(automation ? { automation } : {}),
    ...(studio ? { studio } : {}),
  } }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
