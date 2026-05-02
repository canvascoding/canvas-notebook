/**
 * PI OAuth Credential Manager
 * Manages OAuth credentials for all PI providers in /data/canvas-agent/auth.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveAgentStorageDir } from '@/app/lib/runtime-data-paths';
import {
  loginAnthropic,
  loginOpenAICodex,
  loginGitHubCopilot,
  refreshOAuthToken,
  getOAuthApiKey,
  type OAuthProviderId,
  type OAuthCredentials,
  type OAuthPrompt,
} from '@mariozechner/pi-ai/oauth';

export type { OAuthCredentials, OAuthProviderId, OAuthPrompt };

// Credentials storage path - use env var or fall back to local dev path
const AUTH_FILE_PATH = process.env.OAUTH_STORAGE_PATH || join(resolveAgentStorageDir(), 'auth.json');

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

/**
 * Ensure the auth file directory exists
 */
function ensureAuthDir(): void {
  const dir = join(AUTH_FILE_PATH, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load auth data from file
 */
function loadAuthFile(): AuthFile {
  try {
    if (existsSync(AUTH_FILE_PATH)) {
      const content = readFileSync(AUTH_FILE_PATH, 'utf-8');
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
function saveAuthFile(auth: AuthFile): void {
  ensureAuthDir();
  writeFileSync(AUTH_FILE_PATH, JSON.stringify(auth, null, 2));
}

/**
 * Get credentials for a provider
 */
export function getProviderCredentials(provider: OAuthProviderId): OAuthCredentials | null {
  const auth = loadAuthFile();
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
  credentials: OAuthCredentials
): void {
  const auth = loadAuthFile();
  auth[provider] = credentials;
  saveAuthFile(auth);
}

/**
 * Remove credentials for a provider
 */
export function removeProviderCredentials(provider: OAuthProviderId): void {
  const auth = loadAuthFile();
  delete auth[provider];
  saveAuthFile(auth);
}

/**
 * Check if provider has valid credentials
 */
export function hasProviderCredentials(provider: OAuthProviderId): boolean {
  const creds = getProviderCredentials(provider);
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
        onAuth: (url: string, instructions?: string) => {
          onAuthUrl(url, instructions);
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
export async function refreshProviderToken(provider: OAuthProviderId): Promise<OAuthCredentials | null> {
  const credentials = getProviderCredentials(provider);
  if (!credentials) return null;
  
  try {
    const newCreds = await refreshOAuthToken(provider, credentials);
    saveProviderCredentials(provider, newCreds);
    return newCreds;
  } catch (error) {
    console.error(`Failed to refresh token for ${provider}:`, error);
    return null;
  }
}

/**
 * Get API key for a provider (auto-refreshes if expired)
 */
export async function getProviderApiKey(provider: OAuthProviderId): Promise<{ apiKey: string; credentials: OAuthCredentials } | null> {
  const auth = loadAuthFile();
  
  const result = await getOAuthApiKey(provider, auth);
  if (!result) return null;
  
  // Save refreshed credentials if they changed
  if (result.newCredentials) {
    saveProviderCredentials(provider, result.newCredentials);
  }
  
  return {
    apiKey: result.apiKey,
    credentials: result.newCredentials || getProviderCredentials(provider)!,
  };
}

/**
 * Get status for all providers
 */
export function getAllProviderStatus(): Array<{
  provider: OAuthProviderId;
  displayName: string;
  connected: boolean;
  expiresAt?: number;
}> {
  const auth = loadAuthFile();
  
  return PI_OAUTH_PROVIDERS.map((provider) => {
    const creds = auth[provider];
    const isConnected = hasProviderCredentials(provider);
    
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
