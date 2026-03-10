import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AgentConfigValidationError,
  buildAgentConfigReadiness,
} from '@/app/lib/agents/storage';
import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';

type DoctorPayload = {
  livePing?: boolean;
};

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

export async function POST(request: NextRequest) {
  const { response } = await requireSession(request);
  if (response) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'agents-doctor-post',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    await request.json().catch(() => ({} as DoctorPayload));
    // We pass an empty object because the new storage.ts ignores it and returns PI readiness
    const readiness = await buildAgentConfigReadiness({});
    const { diagnostics } = await loadManagedAgentSystemPrompt();

    return NextResponse.json({
      success: true,
      data: {
        checkedAt: new Date().toISOString(),
        readiness,
        promptDiagnostics: diagnostics,
        summary: {
          ready: readiness.activeProviderReady && !diagnostics.usedFallback,
          errors: readiness.pi?.issues.length || 0,
          warnings: diagnostics.usedFallback ? 1 : 0,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run doctor checks.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
