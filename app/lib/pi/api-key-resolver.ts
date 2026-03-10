import { readScopedEnvState } from '../integrations/env-config';
import { getProviderApiKey, isOAuthProvider } from './oauth';

/**
 * Resolves API keys for PI providers using existing environment stores.
 * For OAuth providers, returns the OAuth token instead of an API key.
 */
export async function resolvePiApiKey(provider: string): Promise<string | undefined> {
  const providerId = provider.toLowerCase();

  // Check if this is an OAuth provider first
  if (isOAuthProvider(providerId as any)) {
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
