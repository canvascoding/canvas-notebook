import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import {
  type EnvScope,
  mutateScopedEnvEntries,
  readScopedEnvState,
  writeScopedEnvRaw,
  readUnifiedEnvState,
  patchUnifiedEnvEntries,
  replaceUnifiedEnvRaw,
  SecretRevisionConflictError,
  type EnvStorageScope,
} from '@/app/lib/integrations/env-config';
import { projectEnvView, withUnifiedEnvLock, type UnifiedEnvState } from '@/app/lib/secrets/unified-env-store';
import { isEnvKey, parseEnvDocument, updateEnvDocument } from '@/app/lib/secrets/env-document';
import { getSecretCategories, isHiddenSecretEnvKey, isReservedSecretEnvKey } from '@/app/lib/secrets/env-registry';
import { closeMcpServersForScope } from '@/app/lib/mcp/manager';
import { migrateLegacyAgentEnvIfNeeded } from '@/app/lib/agents/storage';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isSystemEmailEnvKey } from '@/app/lib/email/system-email-keys';
import { isSecretReadinessError } from '@/app/lib/secrets/readiness';

interface KeyValueEntry {
  key: string;
  value: string;
}

interface PutPayload {
  scope?: EnvScope | 'all';
  secretScope?: SecretScope;
  mode?: 'kv' | 'raw' | 'patch';
  entries?: KeyValueEntry[];
  patches?: Array<{ key: string; value: string | null }>;
  rawContent?: string;
  baseRevision?: string;
}

type SecretScope = 'user' | 'organization' | 'system';

function clientEnvState<T extends { entries: Array<{ key: string; value: string; readable?: boolean; failure?: string }>; rawContent: string; readable?: boolean }>(state: T): T & { readinessCode?: string } {
  const tokens = parseEnvDocument(state.rawContent);
  return {
    ...state,
    ...(state.readable === false ? { readinessCode: state.entries.find(entry => entry.readable === false)?.failure || 'decryption_failed' } : {}),
    entries: state.entries.filter(entry => !isHiddenSecretEnvKey(entry.key)).map(entry => ({
      ...entry,
      value: isSystemEmailEnvKey(entry.key) ? '' : entry.value,
      categories: getSecretCategories(entry.key),
      reserved: isReservedSecretEnvKey(entry.key),
    })),
    rawContent: updateEnvDocument(tokens, new Map(tokens.filter(token => token.key && isReservedSecretEnvKey(token.key)).map(token => [token.key!, null]))),
  };
}

function parseScope(value: string | null | undefined): EnvScope | 'all' {
  return value === 'all' ? 'all' : value === 'agents' ? 'agents' : 'integrations';
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
    const state = clientEnvState(scope === 'all' ? await readUnifiedEnvState(storageScope) : await readScopedEnvState(scope, storageScope));
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
    if (isSecretReadinessError(error)) return NextResponse.json({ success: false, code: error.code, error: error.message, settingsUrl: '/settings?tab=secrets' }, { status: error.status });
    console.error('[API] integrations/env GET error:', error);
    const message = error instanceof Error ? error.message : 'Failed to read env file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function validateEntries(entries: unknown, allowDeletion: boolean): entries is Array<{ key: string; value: string | null }> {
  if (!Array.isArray(entries)) return false;
  const keys = new Set<string>();
  return entries.every(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || !isEnvKey(entry.key) || keys.has(entry.key)) return false;
    keys.add(entry.key);
    return typeof entry.value === 'string' || (allowDeletion && entry.value === null);
  });
}

function effectiveMcpEnv(state: UnifiedEnvState): Map<string, string> {
  return new Map(['integrations', 'agents'].flatMap(view => projectEnvView(state, view as EnvScope).entries.map(entry => [entry.key, entry.value] as [string, string])));
}

export async function PUT(request: NextRequest) {
  const authResult = await requireSession(request);
  if (!authResult.ok) return authResult.response;
  try {
    const payload = await request.json().catch(() => null) as PutPayload | null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 });
    }
    const secretScope = parseSecretScope(payload.secretScope ?? request.nextUrl.searchParams.get('secretScope'));
    if (!secretScope) return NextResponse.json({ success: false, error: 'Unsupported secret scope.' }, { status: 400 });
    const authorization = await resolveAuthorizedStorageScope(authResult.session, secretScope);
    if (!authorization.ok) return authorization.response;
    const { storageScope, organizationId } = authorization;
    const scope = parseScope(payload.scope ?? request.nextUrl.searchParams.get('scope'));
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: `integrations-env-put:${secretScope}:${scope}:${authResult.session.user.id}` });
    if (!limited.ok) return limited.response;
    const mode = request.method === 'PATCH' ? 'patch' : payload.mode || 'kv';
    if (!['kv', 'patch', 'raw'].includes(mode)) return NextResponse.json({ success: false, error: 'Unsupported save mode.' }, { status: 400 });
    if (payload.baseRevision !== undefined && typeof payload.baseRevision !== 'string') {
      return NextResponse.json({ success: false, error: 'Invalid revision.' }, { status: 400 });
    }
    if (mode === 'raw' && (typeof payload.rawContent !== 'string' || typeof payload.baseRevision !== 'string')) {
      return NextResponse.json({ success: false, error: 'Raw editing requires text and its original revision.' }, { status: 400 });
    }
    const entries = mode === 'patch' ? payload.patches : payload.entries;
    if (mode !== 'raw' && !validateEntries(entries, mode === 'patch')) {
      return NextResponse.json({ success: false, error: 'Invalid or duplicate environment variable entries.' }, { status: 400 });
    }
    if (mode === 'patch' && entries!.some(entry => isReservedSecretEnvKey(entry.key))) {
      return NextResponse.json({ success: false, code: 'SECRET_SETTINGS_RESERVED', error: 'Use the connection or System Email settings for protected credentials.' }, { status: 400 });
    }
    if (mode === 'kv' && scope === 'all') {
      return NextResponse.json({ success: false, error: 'Use targeted patches or revision-checked raw editing for the unified store.' }, { status: 400 });
    }
    const { updated, changedKeys } = await withUnifiedEnvLock(storageScope, async () => {
      const current = await readUnifiedEnvState(storageScope);
      if (payload.baseRevision !== undefined && payload.baseRevision !== current.revision) throw new SecretRevisionConflictError();
      const updated = await (async () => {
        if (mode === 'raw') {
          const tokens = parseEnvDocument(payload.rawContent!);
          if (tokens.some(token => token.key && isReservedSecretEnvKey(token.key))) throw new Error('SECRET_SETTINGS_RESERVED');
          if (scope === 'all') {
            const preserved = new Map(current.entries.filter(entry => isReservedSecretEnvKey(entry.key)).map(entry => [entry.key, entry.value]));
            return replaceUnifiedEnvRaw(updateEnvDocument(tokens, preserved), payload.baseRevision!, storageScope);
          }
          const existing = await readScopedEnvState(scope, storageScope);
          const preserved = new Map(existing.entries.filter(entry => isReservedSecretEnvKey(entry.key)).map(entry => [entry.key, entry.value]));
          await writeScopedEnvRaw(scope, updateEnvDocument(tokens, preserved), storageScope);
          return readScopedEnvState(scope, storageScope);
        }
        if (scope === 'all') return patchUnifiedEnvEntries(payload.patches!, storageScope, payload.baseRevision);
        return mutateScopedEnvEntries(scope, existing => {
          const reserved = existing.filter(entry => isReservedSecretEnvKey(entry.key));
          if (mode === 'kv') return [...payload.entries!.filter(entry => !isReservedSecretEnvKey(entry.key)), ...reserved];
          const values = new Map(existing.map(entry => [entry.key, entry.value]));
          for (const patch of payload.patches!) {
            if (patch.value === null) values.delete(patch.key);
            else values.set(patch.key, patch.value);
          }
          return [...values].map(([key, value]) => ({ key, value }));
        }, storageScope);
      })();
      const before = effectiveMcpEnv(current);
      const after = effectiveMcpEnv(await readUnifiedEnvState(storageScope));
      const changedKeys = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key));
      return { updated, changedKeys };
    });
    // MCP ENV resolution currently uses personal or system files. An
    // organization-only ENV scope is not an MCP owner scope.
    if (secretScope !== 'organization') {
      await closeMcpServersForScope(secretScope === 'user' ? { userId: authResult.session.user.id } : null, changedKeys);
    }
    await recordAuditEvent({
      organizationId, userId: authResult.session.user.id, source: 'integrations', eventType: 'secret',
      entityType: 'env_scope', entityId: scope, action: mode === 'raw' ? 'env.update_raw' : 'env.update', status: 'success',
      summary: `${scope} environment variables updated.`,
      metadata: { scope, secretScope, mode, keys: clientEnvState(updated).entries.map(entry => entry.key), entryCount: updated.entries.length },
    });
    return NextResponse.json({ success: true, data: clientEnvState(updated) });
  } catch (error) {
    if (isSecretReadinessError(error)) return NextResponse.json({ success: false, code: error.code, error: error.message, settingsUrl: '/settings?tab=secrets' }, { status: error.status });
    if (error instanceof SecretRevisionConflictError) return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: 409 });
    const message = error instanceof Error ? error.message : 'Failed to update env file';
    if (message === 'SECRET_SETTINGS_RESERVED') return NextResponse.json({ success: false, code: message, error: 'Use the connection or System Email settings for protected credentials.' }, { status: 400 });
    if (/^(Invalid ENV|Duplicate ENV|Unterminated|Unexpected text|Invalid, protected)/.test(message)) return NextResponse.json({ success: false, error: message }, { status: 400 });
    console.error('[API] integrations/env PUT error:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  return PUT(request);
}
