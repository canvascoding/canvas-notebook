import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { resolveAgentRuntimeSettings } from '@/app/lib/agents/effective-runtime-config';
import { getBrowserRequirementStatus, runBrowserLaunchProbe } from '@/app/lib/pi/browser/requirements';
import {
  closeBrowserRuntime,
  deleteBrowserProfile,
  getBrowserProfileDetails,
  type BrowserRuntimeContext,
} from '@/app/lib/pi/browser/runtime';
import { isBrowserToolEnabledConfig } from '@/app/lib/pi/enabled-tools';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type BrowserActionPayload = {
  action?: 'close_session' | 'delete_profile' | 'launch_probe';
  agentId?: string;
};

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return { session, response: null };
}

function makeContext(userId: string, agentId: string): BrowserRuntimeContext {
  return {
    userId,
    agentId,
  };
}

async function buildBrowserStatus(userId: string, rawAgentId?: string | null) {
  const agentId = normalizeManagedAgentId(rawAgentId);
  const context = makeContext(userId, agentId);
  const [effectiveConfig, requirements, profile] = await Promise.all([
    resolveAgentRuntimeSettings(agentId),
    Promise.resolve(getBrowserRequirementStatus({ cache: true })),
    getBrowserProfileDetails(context),
  ]);
  const toolEnabled = isBrowserToolEnabledConfig(effectiveConfig.enabledTools);

  return {
    agentId,
    toolEnabled,
    toolAvailable: toolEnabled && requirements.available,
    requirements,
    profile,
  };
}

export async function GET(request: NextRequest) {
  const { session, response } = await requireSession(request);
  if (response || !session) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-browser-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const status = await buildBrowserStatus(session.user.id, request.nextUrl.searchParams.get('agentId'));
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load browser status.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const { session, response } = await requireSession(request);
  if (response || !session) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'agents-browser-post',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as BrowserActionPayload;
    const agentId = normalizeManagedAgentId(payload.agentId);
    const context = makeContext(session.user.id, agentId);

    if (payload.action === 'close_session') {
      await closeBrowserRuntime(context, 'settings');
      return NextResponse.json({
        success: true,
        data: await buildBrowserStatus(session.user.id, agentId),
      });
    }

    if (payload.action === 'delete_profile') {
      await deleteBrowserProfile(context);
      return NextResponse.json({
        success: true,
        data: await buildBrowserStatus(session.user.id, agentId),
      });
    }

    if (payload.action === 'launch_probe') {
      const probe = await runBrowserLaunchProbe();
      return NextResponse.json({
        success: true,
        data: {
          ...(await buildBrowserStatus(session.user.id, agentId)),
          probe,
        },
      });
    }

    return NextResponse.json({ success: false, error: 'Invalid action.' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update browser runtime.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
