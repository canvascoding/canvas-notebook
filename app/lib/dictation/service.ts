import 'server-only';

import { readDictationSettings, type DictationSettings } from './settings';
import { MAX_AUDIO_TRANSCRIPTION_BYTES, readTranscriptionAvailability, transcribeAudio, TranscriptionServiceError } from '@/app/lib/transcription/service';

export const MAX_DICTATION_BYTES = MAX_AUDIO_TRANSCRIPTION_BYTES;

export type DictationAvailability = {
  enabled: boolean;
  available: boolean;
  provider: DictationSettings['provider'];
  model: string;
  reason: string | null;
};

export async function readDictationAvailability(settings?: DictationSettings): Promise<DictationAvailability> {
  const selected = settings ?? await readDictationSettings();
  if (!selected.enabled) {
    return { enabled: false, available: false, provider: selected.provider, model: selected.model, reason: null };
  }
  const status = await readTranscriptionAvailability(selected);
  return { enabled: true, available: status.available, provider: status.provider, model: status.model, reason: status.reason };
}

export async function transcribeDictationFile(file: File, settings: DictationSettings, signal?: AbortSignal): Promise<string> {
  if (!settings.enabled) throw new TranscriptionServiceError('Dictation is disabled.', 'DICTATION_DISABLED', 503);
  if (file.size < 1 || file.size > MAX_DICTATION_BYTES) {
    throw new TranscriptionServiceError('Audio recording must be between 1 byte and 25 MB.', 'INVALID_AUDIO_SIZE', file.size ? 413 : 400);
  }
  const result = await transcribeAudio({ buffer: Buffer.from(await file.arrayBuffer()),
    filename: file.name, mimeType: file.type, signal }, settings);
  return result.text;
}
