import 'server-only';

import type { AiProviderInstallation } from '@/app/lib/agent-runtime-policy/types';
import { isManagedControlPlaneAvailable } from '@/app/lib/agents/storage';
import { readScopedEnvState, type EnvStorageScope } from '@/app/lib/integrations/env-config';
import { CANVAS_CONTROL_PLANE_PROVIDER_ID } from '@/app/lib/managed/control-plane-models';
import { getProviderApiKey, isOAuthProvider } from '@/app/lib/pi/oauth';
import { supportsBothAuthMethods } from '@/app/lib/pi/provider-help';

const PROVIDER_API_KEY_NAMES: Record<string, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  'openai-codex': ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
  'openai-compatible': ['OPENAI_COMPATIBLE_API_KEY'],
};

function storageScopeFor(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): EnvStorageScope | null {
  if (input.provider.credentialScope === 'user') {
    return { secretScope: 'user', userId: input.userId };
  }
  if (input.provider.credentialScope === 'organization') {
    return { secretScope: 'organization', organizationId: input.organizationId };
  }
  if (input.provider.credentialScope === 'system') {
    // The app-wide integrations file is the canonical system credential store.
    return null;
  }
  return null;
}

async function hasScopedApiKey(
  providerId: string,
  storageScope: EnvStorageScope | null,
  includeProcessEnvironment: boolean,
): Promise<boolean> {
  const keyNames = PROVIDER_API_KEY_NAMES[providerId] ?? [];
  if (keyNames.length === 0) return false;
  try {
    const [integrations, agents] = await Promise.all([
      readScopedEnvState('integrations', storageScope),
      readScopedEnvState('agents', storageScope),
    ]);
    const available = new Set([
      ...integrations.entries.filter((entry) => entry.value.trim()).map((entry) => entry.key),
      ...agents.entries.filter((entry) => entry.value.trim()).map((entry) => entry.key),
    ]);
    return keyNames.some((key) => (
      available.has(key) || (includeProcessEnvironment && Boolean(process.env[key]?.trim()))
    ));
  } catch {
    return false;
  }
}

export async function isProviderInstallationCredentialAvailable(input: {
  provider: AiProviderInstallation;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const providerId = input.provider.providerId.toLowerCase();
  if (providerId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
    return input.provider.credentialScope === 'managed' && isManagedControlPlaneAvailable();
  }
  if (providerId === 'ollama' && input.provider.config.ollamaMode !== 'cloud') return true;
  if (providerId === 'openai-compatible') return true;

  const wantsOAuth = input.provider.config.authMethod === 'oauth'
    || (isOAuthProvider(providerId) && !supportsBothAuthMethods(providerId));
  if (wantsOAuth) {
    if (input.provider.credentialScope !== 'user' || !isOAuthProvider(providerId)) return false;
    return Boolean(await getProviderApiKey(providerId, { userId: input.userId }));
  }

  const storageScope = storageScopeFor(input);
  return hasScopedApiKey(
    providerId,
    storageScope,
    input.provider.credentialScope === 'system',
  );
}
