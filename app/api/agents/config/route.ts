import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AgentConfigValidationError,
  buildAgentConfigReadiness,
  readAgentRuntimeConfig,
  sanitizeAgentRuntimeConfig,
  writeAgentRuntimeConfig,
} from '@/app/lib/agents/storage';

function resolveUpdatedBy(session: Awaited<ReturnType<typeof auth.api.getSession>>): string {
  if (!session) {
    return 'system:unknown';
  }

  const userLabel = session.user.email || session.user.id;
  return `user:${userLabel}`;
}

function unwrapPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  if ('config' in payload) {
    return (payload as { config?: unknown }).config;
  }

  return payload;
}

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
    keyPrefix: 'agents-config-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const config = await readAgentRuntimeConfig();
    const readiness = await buildAgentConfigReadiness(config);

    return NextResponse.json({
      success: true,
      data: {
        config: sanitizeAgentRuntimeConfig(config),
        readiness,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read runtime config.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function PUT(request: NextRequest) {
  const { session, response } = await requireSession(request);
  if (response || !session) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'agents-config-put',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const input = unwrapPayload(payload);
    const updatedConfig = await writeAgentRuntimeConfig(input, resolveUpdatedBy(session));
    const readiness = await buildAgentConfigReadiness(updatedConfig);

    return NextResponse.json({
      success: true,
      data: {
        config: sanitizeAgentRuntimeConfig(updatedConfig),
        readiness,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update runtime config.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
