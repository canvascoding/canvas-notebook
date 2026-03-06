import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import {
  type EnvScope,
  readScopedEnvState,
  replaceScopedEnvEntries,
  writeScopedEnvRaw,
} from '@/app/lib/integrations/env-config';
import { migrateLegacyAgentEnvIfNeeded } from '@/app/lib/agents/storage';
import { rateLimit } from '@/app/lib/utils/rate-limit';

interface KeyValueEntry {
  key: string;
  value: string;
}

interface PutPayload {
  scope?: EnvScope;
  mode?: 'kv' | 'raw';
  entries?: KeyValueEntry[];
  rawContent?: string;
}

function parseScope(value: string | null | undefined): EnvScope {
  return value === 'agents' ? 'agents' : 'integrations';
}

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const scope = parseScope(request.nextUrl.searchParams.get('scope'));
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: `integrations-env-get:${scope}`,
    });
    if (!limited.ok) {
      return limited.response;
    }

    await migrateLegacyAgentEnvIfNeeded();
    const state = await readScopedEnvState(scope);
    return NextResponse.json({ success: true, data: state });
  } catch (error) {
    console.error('[API] integrations/env GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const requestScope = parseScope(request.nextUrl.searchParams.get('scope'));
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: `integrations-env-put:${requestScope}`,
    });
    if (!limited.ok) {
      return limited.response;
    }

    const payload = (await request.json()) as PutPayload;
    const scope = parseScope(payload.scope ?? requestScope);
    const mode = payload.mode || 'kv';

    await migrateLegacyAgentEnvIfNeeded();

    if (mode === 'raw') {
      await writeScopedEnvRaw(scope, payload.rawContent ?? '');
      const updated = await readScopedEnvState(scope);
      return NextResponse.json({ success: true, data: updated });
    }

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const updated = await replaceScopedEnvEntries(scope, entries);
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('[API] integrations/env PUT error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
