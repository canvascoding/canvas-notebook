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
import { createWorkspaceWidgetFetcher } from '@/app/lib/home/workspace-widget-fetcher';
import { HOME_WIDGET_NAMES, type HomeWidgetName, parseHomeWidgetSelection } from '@/app/lib/home/workspace-widget-request';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

const TTL = {
  todos: 30_000,
  automation: 30_000,
  studio: 30_000,
} as const;

async function widgetResult<T>(widget: HomeWidgetName, load: () => Promise<T>) {
  try {
    return { status: 'ready' as const, ...(await load()) };
  } catch (error) {
    console.warn('[home-workspace-widgets] source unavailable', {
      widget,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
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
  const fetcher = createWorkspaceWidgetFetcher(request.headers);
  const [emails, todos, automation, studio] = await Promise.all([
    selected.has('emails')
      ? widgetResult('emails', () => loadHomeWidgetEmails(access.session.user.id, {
        scheduleBackgroundTask: after,
        services: { listAccounts: listEmailAccounts, listMessages: listEmailMessages },
      }))
      : undefined,
    selected.has('todos')
      ? widgetResult('todos', () => loadCachedWorkspaceWidget({
        userId: access.session.user.id,
        workspaceId,
        forceRefresh: forced.has('todos'),
        widget: 'todos',
        ttlMs: TTL.todos,
        load: () => loadHomeWidgetTodos(fetcher, workspaceId),
      }))
      : undefined,
    selected.has('automation')
      ? widgetResult('automation', () => loadCachedWorkspaceWidget({
        userId: access.session.user.id,
        workspaceId,
        forceRefresh: forced.has('automation'),
        widget: 'automation',
        ttlMs: TTL.automation,
        load: () => loadHomeWidgetAutomation(fetcher, workspaceId),
      }))
      : undefined,
    selected.has('studio')
      ? widgetResult('studio', () => loadCachedWorkspaceWidget({
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
