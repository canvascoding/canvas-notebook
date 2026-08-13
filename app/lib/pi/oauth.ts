/**
 * PI OAuth Credential Manager
 * Manages OAuth credentials for all PI providers in /data/settings/auth.json
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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
import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';

export type OAuthCredentials = PiOAuthCredentials;

export const PI_OAUTH_PROVIDERS = [
  'anthropic',
  'openai-codex',
  'github-copilot',
  'kimi-coding',
  'openrouter',
  'xai',
] as const;

export type OAuthProviderId = (typeof PI_OAUTH_PROVIDERS)[number];
export type { OAuthPrompt };

const DEFAULT_AUTH_FILE_PATH = join(resolveSettingsStorageDir(), 'auth.json');
const LEGACY_AUTH_FILE_PATH = join(resolveAgentStorageDir(), 'auth.json');

export type OAuthStorageScope = UserScopedDataStorageScope;

export const PI_VISIBLE_OAUTH_PROVIDERS: OAuthProviderId[] = [
  'openai-codex',
  'openrouter',
  'kimi-coding',
  'xai',
];

// Provider display names – dynamic lookup for providers registered at runtime
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'anthropic': 'Anthropic (Claude legacy OAuth)',
  'openai-codex': 'OpenAI Codex (ChatGPT Login)',
  'github-copilot': 'GitHub Copilot',
  'kimi-coding': 'Kimi Code',
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

function getAuthFilePath(scope?: OAuthStorageScope | null): string {
  if (hasUserScope(scope)) {
    return join(resolveScopedSettingsDir(scope), 'auth.json');
  }

  return process.env.OAUTH_STORAGE_PATH || DEFAULT_AUTH_FILE_PATH;
}

function ensureAuthDir(scope?: OAuthStorageScope | null): void {
  const dir = dirname(getAuthFilePath(scope));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function migrateLegacyAuthFileIfNeeded(scope?: OAuthStorageScope | null): void {
  if (hasUserScope(scope)) {
    return;
  }

  const authFilePath = getAuthFilePath(scope);
  if (process.env.OAUTH_STORAGE_PATH || existsSync(authFilePath) || !existsSync(LEGACY_AUTH_FILE_PATH)) {
    return;
  }

  try {
    ensureAuthDir(scope);
    copyFileSync(LEGACY_AUTH_FILE_PATH, authFilePath);
  } catch {
    // If /data/settings is unavailable, reads continue from the legacy path.
  }
}

function normalizeOAuthCredential(value: unknown): OAuthCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.access !== 'string'
    || typeof candidate.refresh !== 'string'
    || typeof candidate.expires !== 'number'
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
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const auth: AuthFile = {};
  for (const [provider, value] of Object.entries(parsed)) {
    const credential = normalizeOAuthCredential(value);
    if (credential) auth[provider] = credential;
  }
  return auth;
}

/**
 * Load auth data from file
 */
function loadAuthFile(scope?: OAuthStorageScope | null): AuthFile {
  try {
    migrateLegacyAuthFileIfNeeded(scope);
    const authFilePath = getAuthFilePath(scope);
    if (existsSync(authFilePath)) {
      const content = readFileSync(authFilePath, 'utf-8');
      return parseAuthFile(content);
    }
    if (!hasUserScope(scope) && !process.env.OAUTH_STORAGE_PATH && existsSync(LEGACY_AUTH_FILE_PATH)) {
      const content = readFileSync(LEGACY_AUTH_FILE_PATH, 'utf-8');
      return parseAuthFile(content);
    }
  } catch (error) {
    console.error('Failed to load auth file:', error);
  }
  return {};
}

/**
 * Save auth data to file
 */
function saveAuthFile(auth: AuthFile, scope?: OAuthStorageScope | null): void {
  try {
    migrateLegacyAuthFileIfNeeded(scope);
    ensureAuthDir(scope);
    const authFilePath = getAuthFilePath(scope);
    const temporaryPath = `${authFilePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
      renameSync(temporaryPath, authFilePath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  } catch (error) {
    if (process.env.OAUTH_STORAGE_PATH || hasUserScope(scope)) {
      throw error;
    }
    const legacyDir = dirname(LEGACY_AUTH_FILE_PATH);
    if (!existsSync(legacyDir)) {
      mkdirSync(legacyDir, { recursive: true });
    }
    const temporaryPath = `${LEGACY_AUTH_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
      renameSync(temporaryPath, LEGACY_AUTH_FILE_PATH);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}

function credentialStoreForScope(scope?: OAuthStorageScope | null): CredentialStore {
  const lockKey = getAuthFilePath(scope);
  return {
    read: async (providerId, options) => {
      options?.signal?.throwIfAborted();
      return loadAuthFile(scope)[providerId];
    },
    list: async (options): Promise<readonly CredentialInfo[]> => {
      options?.signal?.throwIfAborted();
      return Object.entries(loadAuthFile(scope)).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    modify: async (providerId, operation, options) => withKeyedOperationLock(
      'pi-oauth-credential',
      JSON.stringify([lockKey, providerId]),
      async () => {
        options?.signal?.throwIfAborted();
        const auth = loadAuthFile(scope);
        const next = await operation(auth[providerId]);
        options?.signal?.throwIfAborted();
        if (next) {
          if (next.type !== 'oauth') {
            throw new Error(`Unsupported credential type for ${providerId}.`);
          }
          auth[providerId] = next;
          saveAuthFile(auth, scope);
        }
        return auth[providerId];
      },
    ),
    delete: async (providerId, options) => withKeyedOperationLock(
      'pi-oauth-credential',
      JSON.stringify([lockKey, providerId]),
      async () => {
        options?.signal?.throwIfAborted();
        const auth = loadAuthFile(scope);
        if (!(providerId in auth)) return;
        delete auth[providerId];
        saveAuthFile(auth, scope);
      },
    ),
  };
}

async function modelsForScope(scope?: OAuthStorageScope | null) {
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  return builtinModels({ credentials: credentialStoreForScope(scope) });
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
  await credentialStoreForScope(scope).modify(provider, async () => normalized);
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
  const models = await modelsForScope(scope);
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
  });
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
    const isConnected = hasProviderCredentials(provider, scope);
    
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
