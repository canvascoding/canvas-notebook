import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import {
  readIntegrationsEnvState,
  replaceIntegrationsEntries,
  writeIntegrationsRaw,
} from '@/app/lib/integrations/env-config';
import { rateLimit } from '@/app/lib/utils/rate-limit';

interface KeyValueEntry {
  key: string;
  value: string;
}

interface PutPayload {
  mode?: 'kv' | 'raw';
  entries?: KeyValueEntry[];
  rawContent?: string;
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
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'integrations-env-get',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const state = await readIntegrationsEnvState();
    return NextResponse.json({ success: true, data: state });
  } catch (error) {
    console.error('[API] integrations/env GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read integrations env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: 'integrations-env-put',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const payload = (await request.json()) as PutPayload;
    const mode = payload.mode || 'kv';

    if (mode === 'raw') {
      await writeIntegrationsRaw(payload.rawContent ?? '');
      const updated = await readIntegrationsEnvState();
      return NextResponse.json({ success: true, data: updated });
    }

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const updated = await replaceIntegrationsEntries(entries);
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('[API] integrations/env PUT error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update integrations env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

