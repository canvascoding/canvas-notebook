import 'server-only';

import { mutateScopedEnvEntries, readScopedEnvState } from '@/app/lib/integrations/env-config';

import { TRANSCRIPTION_API_KEYS, type CloudDictationProvider } from '../transcription/config';
export type { CloudDictationProvider } from '../transcription/config';
export type DictationCredentialSource = 'integrations' | 'agents' | 'environment';
export type DictationCredentialStatus = { configured: boolean; source: DictationCredentialSource | null };

export async function resolveDictationCredential(provider: CloudDictationProvider): Promise<{
  value: string | null;
  source: DictationCredentialSource | null;
}> {
  const key = TRANSCRIPTION_API_KEYS[provider];
  for (const scope of ['integrations', 'agents'] as const) {
    const state = await readScopedEnvState(scope);
    const value = state.entries.find((entry) => entry.key === key && entry.readable)?.value.trim();
    if (value) return { value, source: scope };
  }
  const value = process.env[key]?.trim() || null;
  return { value, source: value ? 'environment' : null };
}

export async function readDictationCredentialStatuses(): Promise<Record<CloudDictationProvider, DictationCredentialStatus>> {
  const [openai, groq, gemini, wispr] = await Promise.all([
    resolveDictationCredential('openai'),
    resolveDictationCredential('groq'),
    resolveDictationCredential('gemini'),
    resolveDictationCredential('wispr'),
  ]);
  return {
    openai: { configured: Boolean(openai.value), source: openai.source },
    groq: { configured: Boolean(groq.value), source: groq.source },
    gemini: { configured: Boolean(gemini.value), source: gemini.source },
    wispr: { configured: Boolean(wispr.value), source: wispr.source },
  };
}

export async function saveDictationCredential(provider: CloudDictationProvider, value: string): Promise<void> {
  const key = TRANSCRIPTION_API_KEYS[provider];
  await mutateScopedEnvEntries('integrations', (entries) => [
    ...entries.filter((entry) => entry.key !== key),
    { key, value },
  ]);
}
