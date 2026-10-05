import 'server-only';

import path from 'node:path';
import { resolveDictationCredential } from '@/app/lib/dictation/credentials';
import { localDictationAvailable, transcribeLocally } from '@/app/lib/dictation/local-worker';
import { localDictationRuntimeSupported } from '@/app/lib/dictation/runtime-install';
import { readDictationSettings, validateDictationSettings, type DictationSettings } from '@/app/lib/dictation/settings';

export const MAX_AUDIO_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
const CLOUD_TIMEOUT_MS = 90_000;
const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/mp4': '.m4a', 'audio/m4a': '.m4a', 'audio/x-m4a': '.m4a', 'video/mp4': '.mp4',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/ogg': '.ogg', 'audio/opus': '.opus',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/webm': '.webm', 'video/webm': '.webm',
};
const MIME_BY_EXTENSION: Record<string, string> = {
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.oga': 'audio/ogg', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.wav': 'audio/wav', '.webm': 'audio/webm',
};

export interface TranscribeAudioRequest {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}
export type AudioTranscriptionResult = {
  text: string;
  provider: DictationSettings['provider'];
  model: string;
  durationMs: number;
};
export type TranscriptionAvailability = {
  available: boolean;
  provider: DictationSettings['provider'];
  model: string;
  reason: string | null;
  code: string | null;
};

export class TranscriptionServiceError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'TranscriptionServiceError';
  }
}

async function selectedSettings(settings?: DictationSettings): Promise<DictationSettings> {
  return validateDictationSettings(settings ?? await readDictationSettings());
}

export async function readTranscriptionAvailability(settings?: DictationSettings): Promise<TranscriptionAvailability> {
  const selected = await selectedSettings(settings);
  let reason: string | null = null;
  if (selected.provider === 'local') {
    if (!localDictationRuntimeSupported()) {
      reason = 'Local transcription is unavailable in this Docker release. Choose a cloud provider in /settings?tab=dictation.';
    } else if (!await localDictationAvailable(selected.model)) {
      reason = 'Install the selected local transcription model in /settings?tab=dictation.';
    }
  } else if (!(await resolveDictationCredential(selected.provider)).value) {
    const key = selected.provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    reason = `${key} is missing from the instance-wide transcription credentials. Configure it in /settings?tab=secrets.`;
  }
  return { available: !reason, provider: selected.provider, model: selected.model,
    reason, code: reason ? 'TRANSCRIPTION_UNAVAILABLE' : null };
}

function audioFormat(request: TranscribeAudioRequest): { mimeType: string; extension: string } {
  let mimeType = request.mimeType?.split(';', 1)[0].trim().toLowerCase() || '';
  if (!mimeType || mimeType === 'application/octet-stream') {
    mimeType = MIME_BY_EXTENSION[path.extname(request.filename).toLowerCase()] || '';
  }
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) throw new TranscriptionServiceError('Unsupported audio format.', 'UNSUPPORTED_AUDIO_FORMAT', 400);
  return { mimeType, extension };
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TranscriptionServiceError('Transcription was cancelled.', 'TRANSCRIPTION_ABORTED', 499);
}

/** The instance service; microphone visibility is enforced by the dictation adapter. */
export async function transcribeAudio(request: TranscribeAudioRequest, settings?: DictationSettings): Promise<AudioTranscriptionResult> {
  const startedAt = Date.now();
  aborted(request.signal);
  if (!request.buffer.length) throw new TranscriptionServiceError('Audio transcription requires a non-empty audio file.', 'EMPTY_AUDIO', 400);
  if (request.buffer.length > MAX_AUDIO_TRANSCRIPTION_BYTES) {
    throw new TranscriptionServiceError('Audio file is too large for transcription. Maximum size: 25 MB.', 'AUDIO_TOO_LARGE', 413);
  }
  const format = audioFormat(request);
  const selected = await selectedSettings(settings);
  const language = request.language?.trim().toLowerCase() || selected.language;
  if (language !== 'auto' && !/^[a-z]{2}$/u.test(language)) {
    throw new TranscriptionServiceError('Language must be auto or a two-letter language code.', 'INVALID_LANGUAGE', 400);
  }
  const prompt = request.prompt?.trim() || undefined;
  aborted(request.signal);
  let text: string;
  let cloudSignal: AbortSignal | undefined;
  try {
    if (selected.provider === 'local') {
      const availability = await readTranscriptionAvailability(selected);
      if (!availability.available) throw new TranscriptionServiceError(availability.reason!, availability.code!, 503);
      text = await transcribeLocally({ buffer: request.buffer, extension: format.extension,
        model: selected.model, language, prompt, signal: request.signal });
    } else {
      const { value: key } = await resolveDictationCredential(selected.provider);
      aborted(request.signal);
      if (!key) {
        throw new TranscriptionServiceError(
          `${selected.provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY'} is missing from the instance-wide transcription credentials. Configure it in /settings?tab=secrets.`,
          'TRANSCRIPTION_UNAVAILABLE', 503,
        );
      }
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(request.buffer)], { type: format.mimeType }), path.basename(request.filename));
      form.set('model', selected.model);
      form.set('response_format', 'json');
      if (language !== 'auto') form.set('language', language);
      if (prompt) form.set('prompt', prompt);
      cloudSignal = AbortSignal.any([AbortSignal.timeout(CLOUD_TIMEOUT_MS), ...(request.signal ? [request.signal] : [])]);
      const baseUrl = selected.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: cloudSignal,
      });
      if (!response.ok) throw new TranscriptionServiceError(`${selected.provider} transcription failed (${response.status}).`, 'TRANSCRIPTION_FAILED', 502);
      const result = await response.json() as { text?: unknown };
      text = typeof result.text === 'string' ? result.text : '';
    }
    aborted(request.signal);
    text = text.trim();
    if (!text) throw new TranscriptionServiceError('Transcription completed without transcript text.', 'EMPTY_TRANSCRIPT', 502);
    return { text, provider: selected.provider, model: selected.model, durationMs: Date.now() - startedAt };
  } catch (error) {
    aborted(request.signal);
    if (cloudSignal?.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new TranscriptionServiceError('Transcription timed out.', 'TRANSCRIPTION_TIMEOUT', 504);
    }
    if (error instanceof TranscriptionServiceError) throw error;
    throw new TranscriptionServiceError(error instanceof Error ? error.message : 'Transcription failed.', 'TRANSCRIPTION_FAILED', 502);
  }
}
