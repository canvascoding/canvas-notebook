import { readScopedEnvState } from '../integrations/env-config';

/**
 * Resolves API keys for PI providers using existing environment stores.
 */
export async function resolvePiApiKey(provider: string): Promise<string | undefined> {
  // Use existing agents scope for provider keys
  const agentsState = await readScopedEnvState('agents');
  const integrationsState = await readScopedEnvState('integrations');

  const allEntries = new Map<string, string>([
    ...(integrationsState.entries.map(e => [e.key, e.value]) as [string, string][]),
    ...(agentsState.entries.map(e => [e.key, e.value]) as [string, string][]),
    ...Object.entries(process.env).filter(([_, v]) => v !== undefined) as [string, string][],
  ]);

  switch (provider.toLowerCase()) {
    case 'openai':
      return allEntries.get('OPENAI_API_KEY');
    case 'anthropic':
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
