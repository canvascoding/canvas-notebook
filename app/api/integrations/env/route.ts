import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import {
  type EnvScope,
  mutateScopedEnvEntries,
  mutateScopedEnvRaw,
  readScopedEnvState,
  type EnvStorageScope,
} from '@/app/lib/integrations/env-config';
import { closeMcpServersForScope } from '@/app/lib/mcp/manager';
import { migrateLegacyAgentEnvIfNeeded } from '@/app/lib/agents/storage';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isSystemEmailEnvKey } from '@/app/lib/email/system-email-keys';

interface KeyValueEntry {
  key: string;
  value: string;
}

interface PutPayload {
  scope?: EnvScope;
  secretScope?: SecretScope;
  mode?: 'kv' | 'raw';
  entries?: KeyValueEntry[];
  rawContent?: string;
}

type SecretScope = 'user' | 'organization' | 'system';

function redactSystemEmailEntries<T extends { key: string; value: string }>(entries: T[]): T[] {
  return entries.map((entry) => isSystemEmailEnvKey(entry.key)
    ? { ...entry, value: '' }
    : entry);
}

function redactSystemEmailRaw(rawContent: string): string {
  return rawContent.split(/\r?\n/u)
    .filter((line) => !isSystemEmailEnvKey(line.trim().replace(/^export\s+/u, '').split('=', 1)[0] || ''))
    .join('\n');
}

function clientEnvState<T extends { entries: Array<{ key: string; value: string }>; rawContent: string }>(state: T): T {
  return {
    ...state,
    entries: redactSystemEmailEntries(state.entries),
    rawContent: redactSystemEmailRaw(state.rawContent),
  };
}

function parseScope(value: string | null | undefined): EnvScope {
  return value === 'agents' ? 'agents' : 'integrations';
}

function parseSecretScope(value: unknown): SecretScope | null {
  if (value === undefined || value === null || value === '') return 'user';
  return value === 'user' || value === 'organization' || value === 'system' ? value : null;
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

async function resolveAuthorizedStorageScope(
  session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>,
  secretScope: SecretScope,
): Promise<
  | { ok: true; storageScope: EnvStorageScope | null; organizationId: string | null }
  | { ok: false; response: NextResponse }
> {
  if (secretScope === 'user') {
    return {
      ok: true,
      storageScope: { secretScope: 'user', userId: session.user.id },
      organizationId: null,
    };
  }

  if (secretScope === 'system') {
    if (!isAdminUser(session.user)) {
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, code: 'ADMIN_REQUIRED', error: 'Instance admin permission required.' },
          { status: 403 },
        ),
      };
    }
    // The legacy /data/secrets files remain the canonical app-wide store.
    return { ok: true, storageScope: null, organizationId: null };
  }

  if (!isAdminUser(session.user)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, code: 'ADMIN_REQUIRED', error: 'Instance admin permission required.' },
        { status: 403 },
      ),
    };
  }
  const state = await readOrganizationPermissionForUser(session.user.id);
  if (!state.configured || !state.organizationId) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Organization setup required.' },
        { status: 409 },
      ),
    };
  }
  if (!isOrganizationAdminLike(state.permission)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    storageScope: { secretScope: 'organization', organizationId: state.organizationId },
    organizationId: state.organizationId,
  };
}

export async function GET(request: NextRequest) {
  const authResult = await requireSession(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const scope = parseScope(request.nextUrl.searchParams.get('scope'));
    const secretScope = parseSecretScope(request.nextUrl.searchParams.get('secretScope'));
    if (!secretScope) {
      return NextResponse.json({ success: false, error: 'Unsupported secret scope.' }, { status: 400 });
    }
    const authorization = await resolveAuthorizedStorageScope(authResult.session, secretScope);
    if (!authorization.ok) return authorization.response;
    const { storageScope } = authorization;
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: `integrations-env-get:${secretScope}:${scope}:${authResult.session.user.id}`,
    });
    if (!limited.ok) {
      return limited.response;
    }

    if (secretScope === 'system') await migrateLegacyAgentEnvIfNeeded();
    const state = clientEnvState(await readScopedEnvState(scope, storageScope));
    const requestedKey = request.nextUrl.searchParams.get('key')?.trim() || null;
    if (requestedKey && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(requestedKey)) {
      return NextResponse.json({ success: false, error: 'Invalid environment variable key.' }, { status: 400 });
    }
    return NextResponse.json({
      success: true,
      data: requestedKey
        ? {
            ...state,
            rawContent: '',
            entries: state.entries.filter((entry) => entry.key === requestedKey),
          }
        : state,
    });
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
    const payload = (await request.json().catch(() => null)) as PutPayload | null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 });
    }
    const secretScope = parseSecretScope(payload.secretScope ?? request.nextUrl.searchParams.get('secretScope'));
    if (!secretScope) {
      return NextResponse.json({ success: false, error: 'Unsupported secret scope.' }, { status: 400 });
    }
    const authorization = await resolveAuthorizedStorageScope(authResult.session, secretScope);
    if (!authorization.ok) return authorization.response;
    const { storageScope, organizationId } = authorization;
    const limited = rateLimit(request, {
      limit: 30,
      windowMs: 60_000,
      keyPrefix: `integrations-env-put:${secretScope}:${requestScope}:${authResult.session.user.id}`,
    });
    if (!limited.ok) {
      return limited.response;
    }

    const scope = parseScope(payload.scope ?? requestScope);
    const mode = payload.mode || 'kv';

    if (secretScope === 'system') await migrateLegacyAgentEnvIfNeeded();

    if (mode === 'raw') {
      const rawIncludesSystemEmailSetting = typeof payload.rawContent === 'string'
        && payload.rawContent.split(/\r?\n/u).some((line) => isSystemEmailEnvKey(line.trim().replace(/^export\s+/u, '').split('=', 1)[0] || ''));
      if (rawIncludesSystemEmailSetting) {
        return NextResponse.json({ success: false, code: 'SYSTEM_EMAIL_SETTINGS_RESERVED', error: 'System email settings must be changed in System Email settings.' }, { status: 400 });
      }
      const updated = await mutateScopedEnvRaw(scope, (existing) => {
        if (existing.entries.some((entry) => isSystemEmailEnvKey(entry.key))) {
          throw new Error('SYSTEM_EMAIL_SETTINGS_RESERVED');
        }
        return typeof payload.rawContent === 'string' ? payload.rawContent : '';
      }, storageScope);
      await closeMcpServersForScope(storageScope);
      await recordAuditEvent({
        organizationId,
        userId: authResult.session.user.id,
        source: 'integrations',
        eventType: 'secret',
        entityType: 'env_scope',
        entityId: scope,
        action: 'env.update_raw',
        status: 'success',
        summary: `${scope} environment variables updated in raw mode.`,
        metadata: {
          scope,
          secretScope,
          mode,
          rawContentLength: payload.rawContent?.length ?? 0,
          keys: updated.entries.map((entry) => entry.key),
        },
      });
      return NextResponse.json({ success: true, data: clientEnvState(updated) });
    }

    const requestedEntries = Array.isArray(payload.entries) ? payload.entries : [];
    const updated = await mutateScopedEnvEntries(scope, (existingEntries) => [
      ...requestedEntries.filter((entry) => !isSystemEmailEnvKey(entry.key)),
      ...existingEntries
        .filter((entry) => isSystemEmailEnvKey(entry.key))
        .map((entry) => ({ key: entry.key, value: entry.value })),
    ], storageScope);
    await closeMcpServersForScope(storageScope);
    await recordAuditEvent({
      organizationId,
      userId: authResult.session.user.id,
      source: 'integrations',
      eventType: 'secret',
      entityType: 'env_scope',
      entityId: scope,
      action: 'env.update',
      status: 'success',
      summary: `${scope} environment variables updated.`,
      metadata: {
        scope,
        secretScope,
        mode,
        keys: updated.entries.map((entry) => entry.key),
        entryCount: updated.entries.length,
      },
    });
    return NextResponse.json({ success: true, data: clientEnvState(updated) });
  } catch (error) {
    if (error instanceof Error && error.message === 'SYSTEM_EMAIL_SETTINGS_RESERVED') {
      return NextResponse.json({ success: false, code: 'SYSTEM_EMAIL_SETTINGS_RESERVED', error: 'System email settings must be changed in System Email settings.' }, { status: 400 });
    }
    console.error('[API] integrations/env PUT error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
