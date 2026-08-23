import { NextRequest, NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { auth } from '@/app/lib/auth';
import {
  markMobileAggregateInboxRead,
  markMobileInboxRead,
  MobileInboxError,
} from '@/app/lib/mobile/inbox';
import { loadMobileInboxScope } from '@/app/lib/mobile/inbox-scope';
import { readNotificationAttention } from '@/app/lib/notifications/attention';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type PatchPayload = {
  action?: 'mark_all_read' | 'mark_item_read' | 'set_item_read_state' | 'dismiss_item';
  itemId?: string;
  workspaceId?: string;
  read?: boolean;
};

function mobileInboxErrorResponse(error: unknown) {
  if (error instanceof MobileInboxError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code },
      { status: error.status },
    );
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'notifications-summary-get',
    });
    if (!limited.ok) return limited.response;

    const scope = await loadMobileInboxScope(session.user);
    const attention = await readNotificationAttention({
      userId: session.user.id,
      workspaces: scope.includedWorkspaces,
    });
    const items = [...attention.sections.notifications, ...attention.sections.todoAttention, ...attention.sections.emailAttention];

    return NextResponse.json({
      success: true,
      data: {
        unreadCount: attention.unreadCount,
        counts: attention.counts,
        // Keep `items` for existing dashboard consumers while the notification
        // center can render its persistent To-do section independently.
        items,
        sections: {
          notifications: attention.sections.notifications,
          todos: attention.sections.todoAttention,
          todoUnread: attention.sections.todoAttention.filter((item) => item.unread),
          todoAttention: attention.sections.todoAttention,
          emailAttention: attention.sections.emailAttention,
        },
      },
    });
  } catch (error) {
    const response = mobileInboxErrorResponse(error);
    if (response) return response;
    return jsonServerError('[API] Notifications summary GET error:', error, 'Could not load notification summary.');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: 'notifications-summary-patch',
    });
    if (!limited.ok) return limited.response;

    const payload = (await request.json().catch(() => ({}))) as PatchPayload;
    const scope = await loadMobileInboxScope(session.user);

    if (payload.action === 'mark_all_read') {
      const data = await markMobileAggregateInboxRead({
        userId: session.user.id,
        workspaces: scope.includedWorkspaces,
        category: 'notifications',
      });
      return NextResponse.json({ success: true, data });
    }

    if (
      (payload.action === 'mark_item_read' || payload.action === 'set_item_read_state' || payload.action === 'dismiss_item')
      && payload.itemId
      && payload.workspaceId
    ) {
      const workspace = scope.includedWorkspaces.find((item) => item.workspaceId === payload.workspaceId);
      if (!workspace) {
        return NextResponse.json({ success: false, error: 'Inbox source not found.' }, { status: 404 });
      }
      const data = await markMobileInboxRead({
        userId: session.user.id,
        workspace,
        action: payload.action,
        itemId: payload.itemId,
        read: payload.read,
      });
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json({ success: false, error: 'Invalid action.' }, { status: 400 });
  } catch (error) {
    const response = mobileInboxErrorResponse(error);
    if (response) return response;
    return jsonServerError('[API] Notifications summary PATCH error:', error, 'Could not update notification summary.');
  }
}
