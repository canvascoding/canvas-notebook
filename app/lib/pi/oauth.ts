/**
 * PI OAuth Credential Manager
 * Manages OAuth credentials for all PI providers in /data/settings/auth.json
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  resolveAgentStorageDir,
  resolveScopedSettingsDir,
  resolveSettingsStorageDir,
  type UserScopedDataStorageScope,
} from '@/app/lib/runtime-data-paths';
import {
  loginAnthropic,
  loginOpenAICodex,
  loginGitHubCopilot,
  refreshOAuthToken,
  getOAuthApiKey,
  type OAuthProviderId,
  type OAuthCredentials,
  type OAuthDeviceCodeInfo,
  type OAuthPrompt,
} from '@earendil-works/pi-ai/oauth';

export type { OAuthCredentials, OAuthProviderId, OAuthPrompt };

const DEFAULT_AUTH_FILE_PATH = join(resolveSettingsStorageDir(), 'auth.json');
const LEGACY_AUTH_FILE_PATH = join(resolveAgentStorageDir(), 'auth.json');

export type OAuthStorageScope = UserScopedDataStorageScope;

// Built-in OAuth providers (Google Gemini CLI and Antigravity removed in pi-ai 0.71.0)
export const PI_OAUTH_PROVIDERS: OAuthProviderId[] = [
  'anthropic',
  'openai-codex',
  'github-copilot',
];

// Provider display names – dynamic lookup for providers registered at runtime
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'anthropic': 'Anthropic (Claude)',
  'openai-codex': 'OpenAI Codex',
  'github-copilot': 'GitHub Copilot',
};

// Auth file structure
interface AuthFile {
  [provider: string]: OAuthCredentials;
}

// Callback types
export type AuthUrlCallback = (url: string, instructions?: string) => void;
export type PromptCallback = (message: string) => Promise<string>;
export type ProgressCallback = (message: string) => void;

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

/**
 * Load auth data from file
 */
function loadAuthFile(scope?: OAuthStorageScope | null): AuthFile {
  try {
    migrateLegacyAuthFileIfNeeded(scope);
    const authFilePath = getAuthFilePath(scope);
    if (existsSync(authFilePath)) {
      const content = readFileSync(authFilePath, 'utf-8');
      return JSON.parse(content) as AuthFile;
    }
    if (!hasUserScope(scope) && !process.env.OAUTH_STORAGE_PATH && existsSync(LEGACY_AUTH_FILE_PATH)) {
      const content = readFileSync(LEGACY_AUTH_FILE_PATH, 'utf-8');
      return JSON.parse(content) as AuthFile;
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
    writeFileSync(getAuthFilePath(scope), JSON.stringify(auth, null, 2));
  } catch (error) {
    if (process.env.OAUTH_STORAGE_PATH || hasUserScope(scope)) {
      throw error;
    }
    const legacyDir = dirname(LEGACY_AUTH_FILE_PATH);
    if (!existsSync(legacyDir)) {
      mkdirSync(legacyDir, { recursive: true });
    }
    writeFileSync(LEGACY_AUTH_FILE_PATH, JSON.stringify(auth, null, 2));
  }
}

/**
 * Get credentials for a provider
 */
export function getProviderCredentials(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): OAuthCredentials | null {
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
export function saveProviderCredentials(
  provider: OAuthProviderId,
  credentials: OAuthCredentials,
  scope?: OAuthStorageScope | null,
): void {
  const auth = loadAuthFile(scope);
  auth[provider] = credentials;
  saveAuthFile(auth, scope);
}

/**
 * Remove credentials for a provider
 */
export function removeProviderCredentials(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): void {
  const auth = loadAuthFile(scope);
  delete auth[provider];
  saveAuthFile(auth, scope);
}

/**
 * Check if provider has valid credentials
 */
export function hasProviderCredentials(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): boolean {
  const creds = getProviderCredentials(provider, scope);
  if (!creds) return false;
  
  // Check if token is expired (with 5 min buffer)
  if (creds.expires && creds.expires < Date.now() + 5 * 60 * 1000) {
    return false;
  }
  
  return true;
}

/**
 * Initiate OAuth login for a provider
 * Each provider has different signatures, handled individually
 */
export async function initiateOAuthLogin(
  provider: OAuthProviderId,
  onAuthUrl: AuthUrlCallback,
  onPrompt: PromptCallback,
  onProgress?: ProgressCallback
): Promise<OAuthCredentials> {
  switch (provider) {
    case 'anthropic': {
      return await loginAnthropic({
        onAuth: (info: { url: string; instructions?: string }) => {
          onAuthUrl(info.url, info.instructions);
        },
        onPrompt: async (prompt) => {
          return await onPrompt(prompt.message);
        },
        onManualCodeInput: async () => {
          return await onPrompt('If automatic callback failed, paste the redirect URL here');
        },
        onProgress: onProgress,
      });
    }
    
     case 'openai-codex': {
      return await loginOpenAICodex({
        onAuth: (info: { url: string; instructions?: string }) => {
          onAuthUrl(info.url, info.instructions);
        },
        onPrompt: async (prompt: OAuthPrompt) => {
          return await onPrompt(prompt.message);
        },
        onProgress: onProgress || (() => {}),
      });
    }
    
    case 'github-copilot': {
      return await loginGitHubCopilot({
        onDeviceCode: (info) => {
          onAuthUrl(info.verificationUri, formatDeviceCodeInstructions(info));
        },
        onPrompt: async (prompt) => {
          return await onPrompt(prompt.message);
        },
        onProgress: onProgress || (() => {}),
      });
    }
    
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
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
    const newCreds = await refreshOAuthToken(provider, credentials);
    saveProviderCredentials(provider, newCreds, scope);
    return newCreds;
  } catch (error) {
    console.error(`Failed to refresh token for ${provider}:`, error);
    return null;
  }
}

/**
 * Get API key for a provider (auto-refreshes if expired)
 */
export async function getProviderApiKey(
  provider: OAuthProviderId,
  scope?: OAuthStorageScope | null,
): Promise<{ apiKey: string; credentials: OAuthCredentials } | null> {
  const auth = loadAuthFile(scope);
  
  const result = await getOAuthApiKey(provider, auth);
  if (!result) return null;
  
  // Save refreshed credentials if they changed
  if (result.newCredentials) {
    saveProviderCredentials(provider, result.newCredentials, scope);
  }
  
  return {
    apiKey: result.apiKey,
    credentials: result.newCredentials || getProviderCredentials(provider, scope)!,
  };
}

/**
 * Get status for all providers
 */
export function getAllProviderStatus(scope?: OAuthStorageScope | null): Array<{
  provider: OAuthProviderId;
  displayName: string;
  connected: boolean;
  expiresAt?: number;
}> {
  const auth = loadAuthFile(scope);
  
  return PI_OAUTH_PROVIDERS.map((provider) => {
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
