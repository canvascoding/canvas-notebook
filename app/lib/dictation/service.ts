import 'server-only';

import { resolveDictationCredential } from './credentials';
import { localDictationAvailable, transcribeLocally } from './local-worker';
import { localDictationRuntimeSupported } from './runtime-install';
import { readDictationSettings, type DictationSettings } from './settings';

export const MAX_DICTATION_BYTES = 25 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
};

export type DictationAvailability = {
  enabled: boolean;
  available: boolean;
  provider: DictationSettings['provider'];
  model: string;
  reason: string | null;
};

async function providerKey(provider: DictationSettings['provider']): Promise<string | null> {
  if (provider === 'groq' || provider === 'openai') {
    return (await resolveDictationCredential(provider)).value;
  }
  return null;
}

export async function readDictationAvailability(settings?: DictationSettings): Promise<DictationAvailability> {
  const selected = settings ?? await readDictationSettings();
  if (!selected.enabled) {
    return { enabled: false, available: false, provider: selected.provider, model: selected.model, reason: null };
  }
  if (selected.provider === 'local') {
    if (!localDictationRuntimeSupported()) {
      return {
        enabled: true,
        available: false,
        provider: 'local',
        model: selected.model,
        reason: 'Local dictation is unavailable in this Docker release. Choose a cloud provider.',
      };
    }
    const available = await localDictationAvailable(selected.model);
    return {
      enabled: true,
      available,
      provider: 'local',
      model: selected.model,
      reason: available ? null : process.env.CANVAS_RUNTIME_ENV === 'docker'
        ? 'Install the selected local model in Settings → Dictation.'
        : 'Install the optional local runtime in Settings → Dictation.',
    };
  }
  const available = Boolean(await providerKey(selected.provider));
  return {
    enabled: true,
    available,
    provider: selected.provider,
    model: selected.model,
    reason: available ? null : `${selected.provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY'} is missing from the instance-wide dictation credentials.`,
  };
}

async function transcribeCloud(input: {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  settings: DictationSettings;
}): Promise<string> {
  const provider = input.settings.provider;
  if (provider === 'local') throw new Error('Unsupported cloud dictation provider.');
  const key = await providerKey(provider);
  if (!key) throw new Error('The selected dictation provider is not configured.');
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }), `recording${input.extension}`);
  form.set('model', input.settings.model);
  form.set('response_format', 'json');
  if (input.settings.language !== 'auto') form.set('language', input.settings.language);
  const baseUrl = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    throw new Error(`${provider} transcription failed (${response.status}).`);
  }
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== 'string') throw new Error('The transcription provider returned no text.');
  return result.text.trim();
}

export async function transcribeDictationFile(file: File, settings: DictationSettings): Promise<string> {
  if (!settings.enabled) throw new Error('Dictation is disabled.');
  const mimeType = file.type.split(';', 1)[0].toLowerCase();
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) throw new Error('Unsupported audio format.');
  if (file.size < 1 || file.size > MAX_DICTATION_BYTES) {
    throw new Error('Audio recording must be between 1 byte and 25 MB.');
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (settings.provider === 'local') {
    return transcribeLocally({ buffer, extension, model: settings.model, language: settings.language });
  }
  return transcribeCloud({ buffer, mimeType, extension, settings });
}
