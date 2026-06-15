import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { testAgentModelConnection } from '@/app/lib/agents/model-test';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function redactLogText(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|gh[pousr]|glpat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-jwt]');
  return redacted.length > 800 ? `${redacted.slice(0, 800)}...` : redacted;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'agents-model-test',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const payload = (await request.json().catch(() => ({}))) as { agentId?: unknown };
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : DEFAULT_MANAGED_AGENT_ID;
  console.log('[agents/model-test/api] POST start', { agentId });
  const result = await testAgentModelConnection({ agentId });
  const logPayload = {
    agentId,
    runId: result.runId,
    success: result.success,
    code: result.code,
    provider: result.provider,
    model: result.model,
    durationMs: Date.now() - startedAt,
    probeDurationMs: result.durationMs,
    timeoutMs: result.timeoutMs,
  };
  if (result.success) {
    console.log('[agents/model-test/api] POST complete', logPayload);
  } else {
    console.warn('[agents/model-test/api] POST failed', {
      ...logPayload,
      error: redactLogText(result.error),
    });
  }

  return NextResponse.json(result, { status: result.success ? 200 : 400 });
}
