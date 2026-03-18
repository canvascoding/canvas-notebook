import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AgentConfigValidationError,
  buildAgentConfigReadiness,
} from '@/app/lib/agents/storage';
import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { getQmdDoctorStatus } from '@/app/lib/qmd/status';

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
    // buildAgentConfigReadiness no longer requires a config parameter
    const [readiness, promptResult, qmd] = await Promise.all([
      buildAgentConfigReadiness(),
      loadManagedAgentSystemPrompt(),
      getQmdDoctorStatus(),
    ]);
    const { diagnostics } = promptResult;
    const errorCount = (readiness.pi?.issues.length || 0) + qmd.issues.length;
    const warningCount = (diagnostics.usedFallback ? 1 : 0) + (qmd.derivedDocxIndexing.warningCount > 0 ? 1 : 0);

    return NextResponse.json({
      success: true,
      data: {
        checkedAt: new Date().toISOString(),
        readiness,
        promptDiagnostics: diagnostics,
        qmd,
        summary: {
          ready: readiness.activeProviderReady && !diagnostics.usedFallback && qmd.ready,
          errors: errorCount,
          warnings: warningCount,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run doctor checks.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
