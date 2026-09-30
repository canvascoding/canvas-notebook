import crypto from 'crypto';
import { resolveDefaultAgentsEnvPath, resolveDefaultIntegrationsEnvPath, type SecretDataStorageScope } from '../runtime-data-paths';
import { parseEnvDocument } from '../secrets/env-document';
import {
  getUnifiedEnvFilePath, readUnifiedEnvState, projectEnvView, replaceEnvView, withUnifiedEnvLock,
  type UnifiedEnvState, type SecretEnvEntry,
} from '../secrets/unified-env-store';
export {
  getUnifiedEnvFilePath, readUnifiedEnvState, patchUnifiedEnvEntries, replaceUnifiedEnvRaw,
  readUnifiedSecretValue, mutateUnifiedSecretValue, SecretRevisionConflictError,
} from '../secrets/unified-env-store';
export type { UnifiedEnvState, EnvPatch } from '../secrets/unified-env-store';

export const DEFAULT_INTEGRATIONS_ENV_PATH = resolveDefaultIntegrationsEnvPath();
export const DEFAULT_AGENTS_ENV_PATH = resolveDefaultAgentsEnvPath();
export type EnvScope = 'integrations' | 'agents';
export type EnvStorageScope = SecretDataStorageScope;
export type IntegrationEnvEntry = SecretEnvEntry;
export type IntegrationEnvState = UnifiedEnvState & { scope: EnvScope };

export function getEnvFilePath(_scope: EnvScope, storageScope?: EnvStorageScope | null): string {
  return getUnifiedEnvFilePath(storageScope);
}
export async function writeScopedEnvRaw(scope: EnvScope, rawContent: string, storageScope?: EnvStorageScope | null): Promise<void> {
  const entries = parseEnvDocument(rawContent).filter(token => token.key).map(token => ({ key: token.key!, value: token.value! }));
  await replaceEnvView(scope, entries, storageScope, rawContent);
}
export async function readScopedEnvState(scope: EnvScope, storageScope?: EnvStorageScope | null): Promise<IntegrationEnvState> {
  const state = await readUnifiedEnvState(storageScope);
  if (!state.readable) throw new Error('Encrypted secrets cannot be read safely. Configure the secret master key.');
  return projectEnvView(state, scope);
}
export async function replaceScopedEnvEntries(scope: EnvScope, entries: Array<{ key: string; value: string }>, storageScope?: EnvStorageScope | null): Promise<IntegrationEnvState> {
  return replaceEnvView(scope, entries, storageScope);
}
export async function mutateScopedEnvEntries(scope: EnvScope, mutate: (entries: Array<{ key: string; value: string }>) => Array<{ key: string; value: string }>, storageScope?: EnvStorageScope | null): Promise<IntegrationEnvState> {
  return withUnifiedEnvLock(storageScope, async () => {
    const state = await readScopedEnvState(scope, storageScope);
    return replaceScopedEnvEntries(scope, mutate(state.entries.map(({ key, value }) => ({ key, value }))), storageScope);
  });
}
export async function mutateScopedEnvRaw(scope: EnvScope, mutate: (state: IntegrationEnvState) => string, storageScope?: EnvStorageScope | null): Promise<IntegrationEnvState> {
  return withUnifiedEnvLock(storageScope, async () => {
    const state = await readScopedEnvState(scope, storageScope);
    await writeScopedEnvRaw(scope, mutate(state), storageScope);
    return readScopedEnvState(scope, storageScope);
  });
}
function generateNumericFallback(length = 24): string {
  return Array.from({ length }, () => crypto.randomInt(0, 10)).join('');
}
export async function ensureGeneratedScopedEnvEntry(scope: EnvScope, key: string, options?: { length?: number; storageScope?: EnvStorageScope | null }): Promise<string> {
  return withUnifiedEnvLock(options?.storageScope, async () => {
    const state = await readScopedEnvState(scope, options?.storageScope);
    const entry = state.entries.find(entry => entry.key === key);
    if (entry && !entry.readable) throw new Error('Cannot regenerate an unreadable encrypted secret.');
    const existing = entry?.value.trim();
    if (existing) return existing;
    const value = generateNumericFallback(options?.length ?? 24);
    await replaceScopedEnvEntries(scope, [...state.entries.filter(entry => entry.key !== key).map(({ key, value }) => ({ key, value })), { key, value }], options?.storageScope);
    return value;
  });
}

export async function writeIntegrationsRaw(rawContent: string, storageScope?: EnvStorageScope | null): Promise<void> {
  await writeScopedEnvRaw('integrations', rawContent, storageScope);
}

export async function readIntegrationsEnvState(storageScope?: EnvStorageScope | null): Promise<IntegrationEnvState> {
  return readScopedEnvState('integrations', storageScope);
}

export async function replaceIntegrationsEntries(
  entries: Array<{ key: string; value: string }>,
  storageScope?: EnvStorageScope | null,
): Promise<IntegrationEnvState> {
  return replaceScopedEnvEntries('integrations', entries, storageScope);
}

export async function writeAgentsRaw(rawContent: string, storageScope?: EnvStorageScope | null): Promise<void> {
  await writeScopedEnvRaw('agents', rawContent, storageScope);
}

export async function readAgentsEnvState(storageScope?: EnvStorageScope | null): Promise<IntegrationEnvState> {
  return readScopedEnvState('agents', storageScope);
}

export async function replaceAgentsEntries(
  entries: Array<{ key: string; value: string }>,
  storageScope?: EnvStorageScope | null,
): Promise<IntegrationEnvState> {
  return replaceScopedEnvEntries('agents', entries, storageScope);
}

export async function getGeminiApiKeyFromIntegrations(storageScope?: EnvStorageScope | null): Promise<string | null> {
  try {
    const state = await readScopedEnvState('integrations', storageScope);
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));
    
    const envKey = byKey.get('GEMINI_API_KEY');
    if (envKey) {
      console.log('[EnvConfig] Found GEMINI_API_KEY in integrations env file');
      return envKey;
    }
    
    if (process.env.GEMINI_API_KEY) {
      console.log('[EnvConfig] Found GEMINI_API_KEY in process.env');
      return process.env.GEMINI_API_KEY;
    }
    
    console.warn('[EnvConfig] GEMINI_API_KEY not found in integrations env or process.env');
    console.warn(`[EnvConfig] Integrations env file path: ${state.path}, exists: ${state.exists}`);
    return null;
  } catch (error) {
    console.error('[EnvConfig] Error loading GEMINI_API_KEY:', error);
    throw error;
  }
}

export async function getOpenAIApiKeyFromIntegrations(storageScope?: EnvStorageScope | null): Promise<string | null> {
  try {
    const state = await readScopedEnvState('integrations', storageScope);
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));
    
    const envKey = byKey.get('OPENAI_API_KEY');
    if (envKey) {
      console.log('[EnvConfig] Found OPENAI_API_KEY in integrations env file');
      return envKey;
    }
    
    if (process.env.OPENAI_API_KEY) {
      console.log('[EnvConfig] Found OPENAI_API_KEY in process.env');
      return process.env.OPENAI_API_KEY;
    }
    
    console.warn('[EnvConfig] OPENAI_API_KEY not found in integrations env or process.env');
    console.warn(`[EnvConfig] Integrations env file path: ${state.path}, exists: ${state.exists}`);
    return null;
  } catch (error) {
    console.error('[EnvConfig] Error loading OPENAI_API_KEY:', error);
    throw error;
  }
}

export async function getGroqApiKeyFromIntegrations(storageScope?: EnvStorageScope | null): Promise<string | null> {
  try {
    const state = await readScopedEnvState('integrations', storageScope);
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));

    const envKey = byKey.get('GROQ_API_KEY');
    if (envKey) {
      console.log('[EnvConfig] Found GROQ_API_KEY in integrations env file');
      return envKey;
    }

    if (process.env.GROQ_API_KEY) {
      console.log('[EnvConfig] Found GROQ_API_KEY in process.env');
      return process.env.GROQ_API_KEY;
    }

    console.warn('[EnvConfig] GROQ_API_KEY not found in integrations env or process.env');
    console.warn(`[EnvConfig] Integrations env file path: ${state.path}, exists: ${state.exists}`);
    return null;
  } catch (error) {
    console.error('[EnvConfig] Error loading GROQ_API_KEY:', error);
    throw error;
  }
}

export async function getKieApiKeyFromIntegrations(storageScope?: EnvStorageScope | null): Promise<string | null> {
  try {
    const state = await readScopedEnvState('integrations', storageScope);
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));

    const envKey = byKey.get('KIE_API_KEY');
    if (envKey) {
      console.log('[EnvConfig] Found KIE_API_KEY in integrations env file');
      return envKey;
    }

    if (process.env.KIE_API_KEY) {
      console.log('[EnvConfig] Found KIE_API_KEY in process.env');
      return process.env.KIE_API_KEY;
    }

    console.warn('[EnvConfig] KIE_API_KEY not found in integrations env or process.env');
    console.warn(`[EnvConfig] Integrations env file path: ${state.path}, exists: ${state.exists}`);
    return null;
  } catch (error) {
    console.error('[EnvConfig] Error loading KIE_API_KEY:', error);
    throw error;
  }
}

// Telegram remains in the codebase for a possible future revival, but is not an
// available product channel. Keep this separate from the persisted environment
// value so an old TELEGRAM_CHANNEL_ENABLED=true cannot restart the bot.
const TELEGRAM_CHANNEL_AVAILABLE = false;

export async function getTelegramConfigFromIntegrations(storageScope?: EnvStorageScope | null): Promise<{
  botToken: string | null;
  channelEnabled: boolean;
}> {
  try {
    const state = await readScopedEnvState('integrations', storageScope);
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));

    const botToken = byKey.get('TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN || null;
    const enabledRaw = byKey.get('TELEGRAM_CHANNEL_ENABLED') || process.env.TELEGRAM_CHANNEL_ENABLED || 'false';
    const channelEnabled = TELEGRAM_CHANNEL_AVAILABLE && enabledRaw.toLowerCase() === 'true';

    if (botToken) {
      console.log('[EnvConfig] Found TELEGRAM_BOT_TOKEN in integrations env file');
    } else {
      console.warn('[EnvConfig] TELEGRAM_BOT_TOKEN not found — Telegram channel will not start');
    }

    return { botToken, channelEnabled };
  } catch (error) {
    console.error('[EnvConfig] Error loading Telegram config:', error);
    return {
      botToken: process.env.TELEGRAM_BOT_TOKEN || null,
      channelEnabled: TELEGRAM_CHANNEL_AVAILABLE
        && (process.env.TELEGRAM_CHANNEL_ENABLED || 'false').toLowerCase() === 'true',
    };
  }
}
