/**
 * PI OAuth Credential Manager
 * Manages provider OAuth credentials in the unified, owner-scoped secret store
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuthEvent,
  AuthPrompt,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
  ProviderEnv,
  ProviderHeaders,
} from '@earendil-works/pi-ai';
import type {
  OAuthCredentials as PiOAuthCredentials,
  OAuthDeviceCodeInfo,
  OAuthPrompt,
  OAuthSelectPrompt,
} from '@earendil-works/pi-ai/oauth';
import {
  resolveAgentStorageDir,
  resolveScopedSettingsDir,
  resolveSettingsStorageDir,
  type UserScopedDataStorageScope,
} from '@/app/lib/runtime-data-paths';
import { getUnifiedEnvFilePath, readUnifiedSecretValue, mutateUnifiedSecretValue, type EnvStorageScope } from '@/app/lib/integrations/env-config';

export type OAuthCredentials = PiOAuthCredentials;

export const PI_OAUTH_PROVIDERS = [
  'anthropic',
  'openai',
  'openai-codex',
  'github-copilot',
  'kimi-coding',
  'meta',
  'openrouter',
  'radius',
  'xai',
] as const;

export type OAuthProviderId = (typeof PI_OAUTH_PROVIDERS)[number];
export type { OAuthPrompt };

const PI_OAUTH_SECRET_KEY = 'CANVAS_CREDENTIAL_PI_OAUTH';
const PI_OAUTH_DEVICE_ID_KEY = 'CANVAS_PI_OAUTH_DEVICE_ID';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OAuthStorageScope = UserScopedDataStorageScope;

export const PI_VISIBLE_OAUTH_PROVIDERS: OAuthProviderId[] = [
  'openai',
  'openai-codex',
  'openrouter',
  'kimi-coding',
  'meta',
  'radius',
  'xai',
];

// Provider display names – dynamic lookup for providers registered at runtime
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'anthropic': 'Anthropic (Claude legacy OAuth)',
  'openai': 'OpenAI (ChatGPT Login)',
  'openai-codex': 'OpenAI Codex (Legacy ChatGPT Login)',
  'github-copilot': 'GitHub Copilot',
  'kimi-coding': 'Kimi Code',
  'meta': 'Meta AI',
  'radius': 'Radius',
  'openrouter': 'OpenRouter',
  'xai': 'xAI (Grok/X)',
};

// Auth file structure
interface AuthFile {
  [provider: string]: OAuthCredential;
}

// Callback types
export type AuthUrlCallback = (url: string, instructions?: string) => void;
export type PromptCallback = (message: string) => Promise<string>;
export type ProgressCallback = (message: string) => void;

function selectDefaultOAuthOption(provider: OAuthProviderId, prompt: OAuthSelectPrompt): string | undefined {
  if (provider === 'openai-codex') {
    return prompt.options.find((option) => option.id === 'device_code')?.id
      ?? prompt.options.find((option) => option.id === 'browser')?.id;
  }

  return prompt.options[0]?.id;
}

function formatDeviceCodeInstructions(info: OAuthDeviceCodeInfo): string {
  const details = [`Enter code: ${info.userCode}`];
  if (info.expiresInSeconds) {
    details.push(`Expires in ${Math.round(info.expiresInSeconds / 60)} minutes.`);
  }
  return details.join('\n');
}

/**
 * Ensure the auth file directory exists
 */
function hasUserScope(scope?: OAuthStorageScope | null): boolean {
  return Boolean(scope?.userId?.trim());
}

function oauthSecretScope(scope?: OAuthStorageScope | null): EnvStorageScope {
  return hasUserScope(scope) ? { userId: scope!.userId } : { secretScope: 'system' };
}

/** One stable installation identity, independent of account, reconnect and token refresh. */
export async function getOrCreatePiOAuthDeviceId(): Promise<string> {
  let deviceId = '';
  await mutateUnifiedSecretValue(PI_OAUTH_DEVICE_ID_KEY, async current => {
    if (current !== null && !UUID_PATTERN.test(current)) {
      throw new Error('Invalid Canvas Pi OAuth device ID in system Secrets.');
    }
    deviceId = current ?? randomUUID();
    return deviceId;
  }, { secretScope: 'system' });
  return deviceId;
}

/** Canonical durable storage path; auth.json paths are read-only migration sources. */
export function getAuthFilePath(scope?: OAuthStorageScope | null): string {
  return getUnifiedEnvFilePath(oauthSecretScope(scope));
}

function readLegacyAuthFile(scope?: OAuthStorageScope | null): AuthFile {
  const candidates = hasUserScope(scope)
    ? [join(resolveScopedSettingsDir(scope), 'auth.json')]
    : process.env.OAUTH_STORAGE_PATH
      ? [process.env.OAUTH_STORAGE_PATH]
      : [join(resolveSettingsStorageDir(), 'auth.json'), join(resolveAgentStorageDir(), 'auth.json')];
  for (const filePath of candidates) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    return parseAuthFile(content);
  }
  return Object.create(null) as AuthFile;
}

function normalizeOAuthCredential(value: unknown): OAuthCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.access !== 'string'
    || typeof candidate.refresh !== 'string'
    || typeof candidate.expires !== 'number'
    || !Number.isFinite(candidate.expires)
    || (candidate.type !== undefined && candidate.type !== 'oauth')
  ) {
    return null;
  }
  return {
    ...candidate,
    type: 'oauth',
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
  } as OAuthCredential;
}

function parseAuthFile(content: string): AuthFile {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('PI OAuth credential data is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PI OAuth credential data must be a provider map.');
  const auth = Object.create(null) as AuthFile;
  for (const [provider, value] of Object.entries(parsed)) {
    const credential = normalizeOAuthCredential(value);
    if (!credential || ['__proto__', 'constructor', 'prototype'].includes(provider)) throw new Error('PI OAuth credential data contains an invalid provider credential.');
    auth[provider] = credential;
  }
  return auth;
}

/** Synchronous status lookups never write or borrow another user's credentials. */
function loadAuthFile(scope?: OAuthStorageScope | null): AuthFile {
  const encoded = readUnifiedSecretValue(PI_OAUTH_SECRET_KEY, oauthSecretScope(scope));
  return encoded === null ? readLegacyAuthFile(scope) : parseAuthFile(encoded);
}

/** All import, refresh and edits serialize the whole provider map across processes. */
async function mutateAuthFile<T>(scope: OAuthStorageScope | null | undefined, operation: (auth: AuthFile) => Promise<T>): Promise<T> {
  let result!: T;
  await mutateUnifiedSecretValue(PI_OAUTH_SECRET_KEY, async current => {
    const auth = current === null ? readLegacyAuthFile(scope) : parseAuthFile(current);
    const before = JSON.stringify(auth);
    result = await operation(auth);
    const after = JSON.stringify(auth);
    return current !== null && before === after ? current : after;
  }, oauthSecretScope(scope));
  return result;
}

function credentialStoreForScope(scope?: OAuthStorageScope | null, newConnection = false): CredentialStore {
  return {
    read: async (providerId, options) => mutateAuthFile(scope, async auth => {
      options?.signal?.throwIfAborted();
      return auth[providerId];
    }),
    list: async (options): Promise<readonly CredentialInfo[]> => mutateAuthFile(scope, async auth => {
      options?.signal?.throwIfAborted();
      return Object.entries(auth).map(([providerId, credential]) => ({ providerId, type: credential.type }));
    }),
    modify: async (providerId, operation, options) => mutateAuthFile(scope, async auth => {
      options?.signal?.throwIfAborted();
      const next = await operation(auth[providerId]);
      options?.signal?.throwIfAborted();
      if (next) {
        const normalized = normalizeOAuthCredential(next);
        if (!normalized || ['__proto__', 'constructor', 'prototype'].includes(providerId)) throw new Error('Invalid PI OAuth provider credential.');
        const previous = auth[providerId];
        auth[providerId] = {
          ...normalized,
          canvasConnectionId: newConnection ? randomUUID() : connectionId(normalized) ?? connectionId(previous)
            ?? (previous ? legacyConnectionId(previous) : randomUUID()),
        } as OAuthCredential;
      }
      return auth[providerId];
    }),
    delete: async (providerId, options) => mutateAuthFile(scope, async auth => {
      options?.signal?.throwIfAborted();
      delete auth[providerId];
    }),
  };
}

async function modelsForScope(scope?: OAuthStorageScope | null, newConnection = false) {
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  return builtinModels({ credentials: credentialStoreForScope(scope, newConnection) });
}

function connectionId(credential?: OAuthCredential): string | null {
  const value = (credential as OAuthCredential & { canvasConnectionId?: unknown } | undefined)?.canvasConnectionId;
  return typeof value === 'string' && value ? value : null;
}

function legacyConnectionId(credential: OAuthCredential): string {
  return createHash('sha256').update(credential.refresh).digest('hex');
}

/** Opaque owner-scoped connection identity. Refresh preserves it; reconnect replaces it. */
export function getProviderConnectionId(provider: OAuthProviderId, scope: OAuthStorageScope): string | null {
  const credential = getProviderCredentials(provider, scope);
  return credential?.refresh ? connectionId(credential) ?? legacyConnectionId(credential) : null;
}

/**
 * Get credentials for a provider
 */
export function getProviderCredentials(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): OAuthCredential | null {
  const auth = loadAuthFile(scope);
  const creds = auth[provider];
  
  if (!creds || !creds.access) {
    return null;
  }
  
  return creds;
}

/**
 * Save credentials for a provider
 */
export async function saveProviderCredentials(
  provider: OAuthProviderId,
  credentials: OAuthCredentials | OAuthCredential,
  scope?: OAuthStorageScope | null,
): Promise<void> {
  const normalized = normalizeOAuthCredential(credentials);
  if (!normalized) throw new Error(`Invalid OAuth credentials for ${provider}.`);
  await credentialStoreForScope(scope, true).modify(provider, async () => normalized);
}

/**
 * Remove credentials for a provider
 */
export async function removeProviderCredentials(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): Promise<void> {
  await credentialStoreForScope(scope).delete(provider);
}

/**
 * Check whether refreshable provider credentials are stored. Expiry is handled
 * by Models.getAuth(), which refreshes under the credential-store lock.
 */
export function hasProviderCredentials(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): boolean {
  const creds = getProviderCredentials(provider, scope);
  if (!creds) return false;
  
  return Boolean(creds.refresh);
}

/**
 * Initiate OAuth login for a provider
 * Each provider has different signatures, handled individually
 */
export async function initiateOAuthLogin(
  provider: OAuthProviderId,
  onAuthUrl: AuthUrlCallback,
  onPrompt: PromptCallback,
  onProgress?: ProgressCallback,
  scope?: OAuthStorageScope | null,
): Promise<OAuthCredentials> {
  const models = await modelsForScope(scope, true);
  const deviceId = provider === 'openai' ? await getOrCreatePiOAuthDeviceId() : undefined;
  const credential = await models.login(provider, 'oauth', {
    prompt: async (prompt: AuthPrompt) => {
      prompt.signal?.throwIfAborted();
      if (prompt.type === 'select') {
        return selectDefaultOAuthOption(provider, {
          message: prompt.message,
          options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
        }) ?? '';
      }
      if (prompt.type === 'manual_code') {
        return onPrompt(prompt.message || 'If automatic callback failed, paste the redirect URL here');
      }
      return onPrompt(prompt.message);
    },
    notify: (event: AuthEvent) => {
      if (event.type === 'auth_url') {
        onAuthUrl(event.url, event.instructions);
      } else if (event.type === 'device_code') {
        const info: OAuthDeviceCodeInfo = event;
        onAuthUrl(info.verificationUri, formatDeviceCodeInstructions(info));
      } else if (event.type === 'progress' || event.type === 'info') {
        onProgress?.(event.message);
      }
    },
  }, deviceId ? { getDeviceId: () => deviceId } : undefined);
  if (credential.type !== 'oauth') throw new Error(`Provider ${provider} did not return OAuth credentials.`);
  return credential;
}

/**
 * Refresh OAuth token if needed
 */
export async function refreshProviderToken(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): Promise<OAuthCredentials | null> {
  const credentials = getProviderCredentials(provider, scope);
  if (!credentials) return null;
  
  try {
    await (await modelsForScope(scope)).getAuth(provider);
    return getProviderCredentials(provider, scope);
  } catch (error) {
    console.error(`Failed to refresh token for ${provider}:`, error);
    return null;
  }
}

export type ProviderOAuthRequestAuth = {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
  env: ProviderEnv;
  credentials: OAuthCredential;
};

export async function getProviderRequestAuth(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
  options: { signal?: AbortSignal } = {},
): Promise<ProviderOAuthRequestAuth | null> {
  const stored = getProviderCredentials(provider, scope);
  if (!stored) return null;
  const resolution = await (await modelsForScope(scope)).getAuth(provider, { signal: options.signal });
  if (!resolution) return null;
  const credentials = getProviderCredentials(provider, scope);
  if (!credentials) return null;
  return {
    ...resolution.auth,
    env: resolution.env ?? {},
    credentials,
  };
}

/**
 * Get API key for a provider (auto-refreshes if expired)
 */
export async function getProviderApiKey(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): Promise<{ apiKey: string; credentials: OAuthCredentials } | null> {
  const resolution = await getProviderRequestAuth(provider, scope);
  if (!resolution?.apiKey) return null;
  return { apiKey: resolution.apiKey, credentials: resolution.credentials };
}

/**
 * Get status for all providers
 */
export function getAllProviderStatus(
  scope?: OAuthStorageScope | null,
  options: { includeHidden?: boolean } = {},
): Array<{
  provider: OAuthProviderId;
  displayName: string;
  connected: boolean;
  expiresAt?: number;
}> {
  const auth = loadAuthFile(scope);
  
  const providers = options.includeHidden ? PI_OAUTH_PROVIDERS : PI_VISIBLE_OAUTH_PROVIDERS;

  return providers.map((provider) => {
    const creds = auth[provider];
    const isConnected = Boolean(creds?.refresh);
    
    return {
      provider,
      displayName: PROVIDER_DISPLAY_NAMES[provider],
      connected: isConnected,
      expiresAt: creds?.expires,
    };
  });
}

/**
 * Map PI provider to API type for model resolver
 */
export function getProviderApiType(provider: OAuthProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai-codex':
      return 'openai-codex';
    case 'github-copilot':
      return 'github-copilot';
    case 'kimi-coding':
      return 'kimi-coding';
    case 'openrouter':
      return 'openrouter';
    case 'xai':
      return 'xai';
    default:
      return 'unknown';
  }
}

/**
 * Check if a provider ID is an OAuth provider
 */
export function isOAuthProvider(providerId: string): providerId is OAuthProviderId {
  return PI_OAUTH_PROVIDERS.includes(providerId as OAuthProviderId);
}
