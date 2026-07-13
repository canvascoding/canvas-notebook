import 'server-only';

import {
  readScopedEnvState,
  type EnvStorageScope,
  type IntegrationEnvState,
} from '@/app/lib/integrations/env-config';

export type StudioCredentialProvider = 'gemini' | 'openai' | 'kie';

const STUDIO_PROVIDER_ENV_KEYS: Record<StudioCredentialProvider, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  kie: 'KIE_API_KEY',
};

function hasScopedCredentialStore(storageScope?: EnvStorageScope | null): storageScope is EnvStorageScope {
  return Boolean(
    storageScope?.userId?.trim()
    || storageScope?.organizationId?.trim()
    || (storageScope?.secretScope && storageScope.secretScope !== 'legacy' && storageScope.secretScope !== 'system'),
  );
}

async function readCredentialStates(storageScope?: EnvStorageScope | null): Promise<IntegrationEnvState[]> {
  return Promise.all([
    readScopedEnvState('integrations', storageScope),
    readScopedEnvState('agents', storageScope),
  ]);
}

function findCredential(states: IntegrationEnvState[], key: string): string | null {
  for (const state of states) {
    const value = state.entries.find((entry) => entry.key === key)?.value.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Resolve Studio media credentials without making per-user setup mandatory.
 *
 * Priority:
 * 1. optional user/organization override,
 * 2. central administrator-managed secrets,
 * 3. process environment provisioned on the VM,
 * 4. no key, so the caller may use the managed Control Plane fallback.
 *
 * Both Canvas-Integrations.env and Canvas-Agents.env are checked because the
 * AI provider catalog stores some system credentials (notably OpenAI) in the
 * agent environment while Studio media credentials normally live in the
 * integrations environment.
 */
export async function resolveStudioProviderCredential(
  provider: StudioCredentialProvider,
  storageScope?: EnvStorageScope | null,
): Promise<string | null> {
  const key = STUDIO_PROVIDER_ENV_KEYS[provider];

  if (hasScopedCredentialStore(storageScope)) {
    const scopedCredential = findCredential(await readCredentialStates(storageScope), key);
    if (scopedCredential) return scopedCredential;
  }

  const centralCredential = findCredential(await readCredentialStates(null), key);
  if (centralCredential) return centralCredential;

  return process.env[key]?.trim() || null;
}
