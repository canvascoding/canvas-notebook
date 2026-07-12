import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { resolveAgentRuntimeSettings } from '@/app/lib/agents/effective-runtime-config';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import {
  DEFAULT_MANAGED_AGENT_ID,
  readPiRuntimeConfig,
  writePiRuntimeConfig,
} from '@/app/lib/agents/storage';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { assertBrowserToolCanBeEnabled } from '@/app/lib/pi/browser/settings-service';
import {
  DISABLED_ALL_TOOLS_SENTINEL,
  normalizeEnabledToolsConfig,
} from '@/app/lib/pi/enabled-tools';
import { getPiToolMetadata } from '@/app/lib/pi/tool-registry';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    session,
    response: null,
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
    keyPrefix: 'agents-tools-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const [tools, effectiveConfig] = await Promise.all([
      getPiToolMetadata(),
      resolveAgentRuntimeSettings(request.nextUrl.searchParams.get('agentId')),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        tools,
        config: {
          agentId: effectiveConfig.agentId,
          enabledTools: effectiveConfig.enabledTools,
          overrideState: effectiveConfig.overrideState,
          inheritedFromMain: !effectiveConfig.isMainAgent,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load tool metadata.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'agents-tools-patch',
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
    let agentId: string;
    try {
      agentId = normalizeManagedAgentId(typeof payload?.agentId === 'string' ? payload.agentId : null);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid agentId.' }, { status: 400 });
    }
    if (agentId !== DEFAULT_MANAGED_AGENT_ID) {
      return NextResponse.json(
        { success: false, error: 'Custom agent tools must be updated through the agent profile API.' },
        { status: 400 },
      );
    }
    if (
      !Array.isArray(payload?.enabledTools)
      || payload.enabledTools.length > 500
      || payload.enabledTools.some((value) => typeof value !== 'string' || value.length > 200)
    ) {
      return NextResponse.json({ success: false, error: 'enabledTools must be a string array.' }, { status: 400 });
    }

    const tools = await getPiToolMetadata();
    const knownToolNames = new Set(tools.map((tool) => tool.name));
    const enabledTools = normalizeEnabledToolsConfig(payload.enabledTools as string[]);
    const unknownTool = enabledTools.find(
      (toolName) => toolName !== DISABLED_ALL_TOOLS_SENTINEL && !knownToolNames.has(toolName),
    );
    if (unknownTool) {
      return NextResponse.json({ success: false, error: `Unknown agent tool: ${unknownTool}` }, { status: 400 });
    }

    const currentConfig = await readPiRuntimeConfig();
    const activeProviderConfig = currentConfig.providers[currentConfig.activeProvider];
    if (!activeProviderConfig) {
      return NextResponse.json({ success: false, error: 'The legacy tool profile is not initialized.' }, { status: 409 });
    }
    await assertBrowserToolCanBeEnabled({
      previousEnabledTools: activeProviderConfig.enabledTools,
      nextEnabledTools: enabledTools,
    });
    await writePiRuntimeConfig({
      ...currentConfig,
      providers: {
        ...currentConfig.providers,
        [currentConfig.activeProvider]: {
          ...activeProviderConfig,
          enabledTools,
        },
      },
    });
    const effectiveConfig = await resolveAgentRuntimeSettings(agentId);
    await recordAuditEvent({
      userId: admin.session.user.id,
      agentId,
      source: 'agents',
      eventType: 'agent',
      entityType: 'agent_tool_config',
      entityId: agentId,
      action: 'agent_tool_config.update',
      status: 'success',
      summary: 'Agent tool configuration updated.',
      metadata: { enabledTools },
    });

    return NextResponse.json({
      success: true,
      data: {
        tools,
        config: {
          agentId,
          enabledTools: effectiveConfig.enabledTools,
          overrideState: effectiveConfig.overrideState,
          inheritedFromMain: false,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update agent tools.';
    const status = message.startsWith('Browser tool cannot be enabled:') ? 409 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
