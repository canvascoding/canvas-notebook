import { timingSafeEqual } from 'node:crypto';

import { makeSignature } from 'better-auth/crypto';

import { db } from '@/app/lib/db';
import { oauthClient } from '@/app/lib/db/schema';
import {
  DIRECT_MCP_OAUTH_SCOPES,
  type DirectMcpOAuthScope,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';
import { eq } from 'drizzle-orm';

export type OAuthPageSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type VerifiedOAuthPageQuery = {
  oauthQuery: string;
  clientId: string;
  scopes: DirectMcpOAuthScope[];
};

export type DirectMcpConsentPresentation = VerifiedOAuthPageQuery & {
  clientName: string;
  instanceHost: string;
};

function toSearchParams(searchParams: OAuthPageSearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

function canonicalize(params: URLSearchParams): string {
  const canonical = new URLSearchParams();
  const entries = [...params.entries()].sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    if (valueA < valueB) return -1;
    if (valueA > valueB) return 1;
    return 0;
  });
  for (const [key, value] of entries) canonical.append(key, value);
  return canonical.toString();
}

function safeSignatureEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readSingle(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 && values[0] ? values[0] : null;
}

export async function verifyOAuthPageQuery(
  searchParams: OAuthPageSearchParams,
  now = Date.now(),
): Promise<VerifiedOAuthPageQuery | null> {
  const params = toSearchParams(searchParams);
  if (params.toString().length > 8_192) return null;

  const signature = readSingle(params, 'sig');
  if (!signature) return null;
  params.delete('sig');

  const expectedSignature = await makeSignature(
    canonicalize(params),
    resolveAuthSecret(process.env, { allowProductionBuildFallback: true }),
  );
  if (!safeSignatureEqual(signature, expectedSignature)) return null;

  const expiration = Number(readSingle(params, 'exp'));
  const issuedAt = Number(readSingle(params, 'ba_iat'));
  if (
    !Number.isFinite(expiration)
    || !Number.isFinite(issuedAt)
    || expiration * 1_000 < now
    || expiration * 1_000 > now + 6 * 60 * 1_000
    || issuedAt > now + 60_000
    || issuedAt < now - 6 * 60 * 1_000
  ) {
    return null;
  }

  const signedNames = new Set(params.getAll('ba_param'));
  for (const requiredName of [
    'client_id',
    'redirect_uri',
    'response_type',
    'scope',
    'code_challenge',
    'code_challenge_method',
    'exp',
    'ba_iat',
  ]) {
    if (!signedNames.has(requiredName)) return null;
  }

  const clientId = readSingle(params, 'client_id');
  const redirectUri = readSingle(params, 'redirect_uri');
  const scope = readSingle(params, 'scope');
  if (
    !clientId
    || !redirectUri
    || !scope
    || readSingle(params, 'response_type') !== 'code'
    || readSingle(params, 'code_challenge_method') !== 'S256'
  ) {
    return null;
  }
  try {
    const parsedRedirect = new URL(redirectUri);
    if (!['https:', 'http:'].includes(parsedRedirect.protocol) || parsedRedirect.hash) {
      return null;
    }
  } catch {
    return null;
  }

  const allowedScopes = new Set<string>(DIRECT_MCP_OAUTH_SCOPES);
  const scopes = [...new Set(scope.split(' ').filter(Boolean))];
  if (
    scopes.length === 0
    || scopes.some((requestedScope) => !allowedScopes.has(requestedScope))
  ) {
    return null;
  }

  params.append('sig', signature);
  return {
    oauthQuery: params.toString(),
    clientId,
    scopes: scopes as DirectMcpOAuthScope[],
  };
}

function safeClientName(value: string | null): string {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return normalized || 'MCP client';
}

function parseStoredStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function resolveDirectMcpConsentPresentation(
  searchParams: OAuthPageSearchParams,
): Promise<DirectMcpConsentPresentation | null> {
  const verified = await verifyOAuthPageQuery(searchParams);
  if (!verified) return null;

  const rows = await db.select({
    clientId: oauthClient.clientId,
    name: oauthClient.name,
    disabled: oauthClient.disabled,
    public: oauthClient.public,
    tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
    scopes: oauthClient.scopes,
  }).from(oauthClient).where(eq(oauthClient.clientId, verified.clientId)).limit(1);
  const client = rows[0];
  if (
    !client
    || client.disabled === true
    // Better Auth derives public-client status from the `none` endpoint auth
    // method and no longer persists the legacy `public` column for DCR rows.
    || client.public === false
    || client.tokenEndpointAuthMethod !== 'none'
  ) {
    return null;
  }

  const registeredScopes = new Set(parseStoredStringArray(client.scopes));
  if (verified.scopes.some((scope) => !registeredScopes.has(scope))) {
    return null;
  }

  return {
    ...verified,
    clientName: safeClientName(client.name),
    instanceHost: new URL(resolveDirectMcpOAuthConfig().origin).host,
  };
}
