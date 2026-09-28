import 'server-only';

import { readSettingsTextFileIfExists, writeSettingsJsonFileAtomic } from '@/app/lib/settings-storage';

export const DICTATION_PROVIDERS = ['local', 'openai', 'groq'] as const;
export type DictationProvider = typeof DICTATION_PROVIDERS[number];

export const DICTATION_MODELS: Record<DictationProvider, readonly string[]> = {
  local: ['tiny', 'base', 'small', 'medium', 'large-v3'],
  openai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
};

export type DictationSettings = {
  enabled: boolean;
  provider: DictationProvider;
  model: string;
  language: string;
};

const SETTINGS_PATH = 'dictation/settings.json';
const DEFAULT_SETTINGS: DictationSettings = {
  enabled: false,
  provider: 'local',
  model: 'base',
  language: 'auto',
};

let pendingWrite: Promise<unknown> = Promise.resolve();

export function isDictationProvider(value: unknown): value is DictationProvider {
  return typeof value === 'string' && (DICTATION_PROVIDERS as readonly string[]).includes(value);
}

export function defaultDictationModel(provider: DictationProvider): string {
  return DICTATION_MODELS[provider][0];
}

export function validateDictationSettings(value: unknown): DictationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid dictation settings.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== 'boolean' || !isDictationProvider(record.provider)) {
    throw new Error('Choose exactly one supported dictation provider and an enabled state.');
  }
  const provider = record.provider;
  if (typeof record.model !== 'string' || !DICTATION_MODELS[provider].includes(record.model)) {
    throw new Error('Choose a supported model for the selected dictation provider.');
  }
  const language = typeof record.language === 'string' ? record.language.trim().toLowerCase() : '';
  if (language !== 'auto' && !/^[a-z]{2}$/u.test(language)) {
    throw new Error('Dictation language must be auto or a two-letter language code.');
  }
  return { enabled: record.enabled, provider, model: record.model, language };
}

export async function readDictationSettings(): Promise<DictationSettings> {
  const { content } = await readSettingsTextFileIfExists(SETTINGS_PATH);
  if (!content) return { ...DEFAULT_SETTINGS };
  try {
    return validateDictationSettings(JSON.parse(content) as unknown);
  } catch {
    // A damaged configuration must not expose a dictation control to users.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeDictationSettings(value: unknown): Promise<DictationSettings> {
  const settings = validateDictationSettings(value);
  const write = pendingWrite.then(async () => {
    await writeSettingsJsonFileAtomic(SETTINGS_PATH, settings);
    return settings;
  });
  pendingWrite = write.catch(() => undefined);
  return write;
}
