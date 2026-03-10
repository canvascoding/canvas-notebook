import { readScopedEnvState } from '../integrations/env-config';
import { getProviderApiKey, isOAuthProvider } from './oauth';
import { supportsBothAuthMethods } from './provider-help';
import { readPiRuntimeConfig } from '../agents/storage';

/**
 * Resolves API keys for PI providers using existing environment stores.
 * For OAuth providers, returns the OAuth token instead of an API key.
 * Respects authMethod preference from provider config.
 */
export async function resolvePiApiKey(provider: string): Promise<string | undefined> {
  const providerId = provider.toLowerCase();

  // Check if provider supports both auth methods
  const supportsBoth = supportsBothAuthMethods(providerId);
  
  // Check if this is an OAuth provider
  const isOAuth = isOAuthProvider(providerId as any);
  
  // If provider supports both, check config for preferred method
  if (supportsBoth) {
    try {
      const piConfig = await readPiRuntimeConfig();
      const providerConfig = piConfig.providers[providerId];
      const authMethod = providerConfig?.authMethod;
      
      // If OAuth is explicitly selected, use OAuth
      if (authMethod === 'oauth' && isOAuth) {
        const result = await getProviderApiKey(providerId as any);
        return result?.apiKey;
      }
      
      // If API Key is selected or no method set, fall through to API key lookup
      if (authMethod === 'api-key' || !authMethod) {
        // Fall through to API key lookup below
      }
    } catch (e) {
      // Config read failed, continue with default behavior
    }
  }
  
  // If it's an OAuth-only provider (not dual-support), try OAuth first
  if (isOAuth && !supportsBoth) {
    const result = await getProviderApiKey(providerId as any);
    return result?.apiKey;
  }

  // Use existing agents scope for provider keys
  const agentsState = await readScopedEnvState('agents');
  const integrationsState = await readScopedEnvState('integrations');

  const allEntries = new Map<string, string>([
    ...(integrationsState.entries.map(e => [e.key, e.value]) as [string, string][]),
    ...(agentsState.entries.map(e => [e.key, e.value]) as [string, string][]),
    ...Object.entries(process.env).filter(([_, v]) => v !== undefined) as [string, string][],
  ]);

  switch (providerId) {
    case 'openai':
    case 'openai-codex':
      return allEntries.get('OPENAI_API_KEY');
    case 'anthropic':
    case 'claude':
      return allEntries.get('ANTHROPIC_API_KEY');
    case 'google':
      return allEntries.get('GOOGLE_API_KEY') || allEntries.get('GEMINI_API_KEY');
    case 'openrouter':
      return allEntries.get('OPENROUTER_API_KEY');
    case 'groq':
      return allEntries.get('GROQ_API_KEY');
    case 'mistral':
      return allEntries.get('MISTRAL_API_KEY');
    case 'ollama':
      // Ollama Cloud requires API key, local doesn't
      return allEntries.get('OLLAMA_API_KEY');
    default:
      return undefined;
  }
}
