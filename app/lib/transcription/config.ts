/** Shared, browser-safe catalog for instance transcription settings. */
export const DICTATION_PROVIDERS = ['local', 'openai', 'groq', 'gemini', 'wispr'] as const;
export type DictationProvider = typeof DICTATION_PROVIDERS[number];
export type CloudDictationProvider = Exclude<DictationProvider, 'local'>;
export const DICTATION_MODELS: Record<DictationProvider, readonly string[]> = {
  local: ['tiny', 'base', 'small', 'medium', 'large-v3'],
  openai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  gemini: ['gemini-3.5-transcribe'],
  // Wispr chooses its model. This is a service identifier, not a Canto model ID.
  wispr: ['flow'],
};
export const TRANSCRIPTION_API_KEYS: Record<CloudDictationProvider, string> = {
  openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', wispr: 'WISPR_API_KEY',
};
export type TranscriptionMode = 'smart' | 'verbatim';
export type DictationSettings = {
  enabled: boolean;
  provider: DictationProvider;
  model: string;
  language: string;
  /** Gemini defaults to smart for existing settings without this field. */
  mode?: TranscriptionMode;
};

export function isCloudDictationProvider(value: unknown): value is CloudDictationProvider {
  return typeof value === 'string' && Object.hasOwn(TRANSCRIPTION_API_KEYS, value);
}
