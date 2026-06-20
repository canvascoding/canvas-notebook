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
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { ok: true as const, session };
}

export async function GET(request: NextRequest) {
  const authResult = await requireSession(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const scope = parseScope(request.nextUrl.searchParams.get('scope'));
    const storageScope = { userId: authResult.session.user.id };
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: `integrations-env-get:${scope}:${authResult.session.user.id}`,
    });
    if (!limited.ok) {
      return limited.response;
    }

    await migrateLegacyAgentEnvIfNeeded();
    const state = await readScopedEnvState(scope, storageScope);
    return NextResponse.json({ success: true, data: state });
  } catch (error) {
    console.error('[API] integrations/env GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const authResult = await requireSession(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const requestScope = parseScope(request.nextUrl.searchParams.get('scope'));
    const storageScope = { userId: authResult.session.user.id };
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: `integrations-env-put:${requestScope}:${authResult.session.user.id}`,
    });
    if (!limited.ok) {
      return limited.response;
    }

    const payload = (await request.json()) as PutPayload;
    const scope = parseScope(payload.scope ?? requestScope);
    const mode = payload.mode || 'kv';

    await migrateLegacyAgentEnvIfNeeded();

    if (mode === 'raw') {
      await writeScopedEnvRaw(scope, payload.rawContent ?? '', storageScope);
      const updated = await readScopedEnvState(scope, storageScope);
      return NextResponse.json({ success: true, data: updated });
    }

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const updated = await replaceScopedEnvEntries(scope, entries, storageScope);
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('[API] integrations/env PUT error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
