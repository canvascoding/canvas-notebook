import 'server-only';

import { mutateScopedEnvEntries, readScopedEnvState } from '@/app/lib/integrations/env-config';

export type CloudDictationProvider = 'openai' | 'groq';
export type DictationCredentialSource = 'integrations' | 'agents' | 'environment';
export type DictationCredentialStatus = { configured: boolean; source: DictationCredentialSource | null };

const API_KEY_BY_PROVIDER: Record<CloudDictationProvider, string> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
};

export async function resolveDictationCredential(provider: CloudDictationProvider): Promise<{
  value: string | null;
  source: DictationCredentialSource | null;
}> {
  const key = API_KEY_BY_PROVIDER[provider];
  for (const scope of ['integrations', 'agents'] as const) {
    const state = await readScopedEnvState(scope);
    const value = state.entries.find((entry) => entry.key === key && entry.readable)?.value.trim();
    if (value) return { value, source: scope };
  }
  const value = process.env[key]?.trim() || null;
  return { value, source: value ? 'environment' : null };
}

export async function readDictationCredentialStatuses(): Promise<Record<CloudDictationProvider, DictationCredentialStatus>> {
  const [openai, groq] = await Promise.all([
    resolveDictationCredential('openai'),
    resolveDictationCredential('groq'),
  ]);
  return {
    openai: { configured: Boolean(openai.value), source: openai.source },
    groq: { configured: Boolean(groq.value), source: groq.source },
  };
}

export async function saveDictationCredential(provider: CloudDictationProvider, value: string): Promise<void> {
  const key = API_KEY_BY_PROVIDER[provider];
  await mutateScopedEnvEntries('integrations', (entries) => [
    ...entries.filter((entry) => entry.key !== key),
    { key, value },
  ]);
}
