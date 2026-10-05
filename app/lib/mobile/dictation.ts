import 'server-only';

import { NextResponse } from 'next/server';
import { readDictationSettings, type DictationSettings } from '@/app/lib/dictation/settings';
import { MAX_AUDIO_TRANSCRIPTION_BYTES, readTranscriptionAvailability, TranscriptionServiceError } from '@/app/lib/transcription/service';

export { MOBILE_DICTATION_CAPABILITY } from './dictation-capabilities';
export const MAX_MOBILE_DICTATION_TEXT_BYTES = 64 * 1024;
export const mobileDictationHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, Authorization, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};
export const mobileDictationLimits = {
  maxAudioBytes: MAX_AUDIO_TRANSCRIPTION_BYTES,
  maxTextBytes: MAX_MOBILE_DICTATION_TEXT_BYTES,
  acceptedMimeTypes: ['audio/webm', 'video/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'],
};

export async function readMobileDictationAvailability(settings?: DictationSettings) {
  const selected = settings ?? await readDictationSettings();
  const status = selected.enabled ? await readTranscriptionAvailability(selected) : null;
  return {
    enabled: selected.enabled,
    available: Boolean(selected.enabled && status?.available),
    // v1 Expo validates this legacy enum but does not display/use it for dispatch.
    // New cloud services use its cloud compatibility value; actual identity is explicit.
    provider: selected.provider === 'gemini' || selected.provider === 'wispr' ? 'openai' : selected.provider,
    transcriptionProvider: selected.provider,
    model: selected.model,
    language: selected.language,
    reasonCode: !selected.enabled ? 'disabled' : status?.available ? null : status?.unavailableReason ?? 'temporarily_unavailable',
  };
}

export function mobileDictationErrorResponse(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return NextResponse.json({ success: false, error: 'Transcription was cancelled.', code: 'TRANSCRIPTION_ABORTED' }, { status: 499, headers: mobileDictationHeaders });
  }
  if (error instanceof TranscriptionServiceError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status, headers: mobileDictationHeaders });
  }
  return NextResponse.json({ success: false, error: 'Dictation is temporarily unavailable.', code: 'TRANSCRIPTION_FAILED' }, { status: 502, headers: mobileDictationHeaders });
}

/** Enforce the cap on streamed native uploads, even without Content-Length. */
export async function readMobileDictationForm(request: Request): Promise<FormData> {
  const maxBytes = MAX_AUDIO_TRANSCRIPTION_BYTES + 100_000;
  const tooLarge = () => new TranscriptionServiceError('Audio recording is too large.', 'AUDIO_TOO_LARGE', 413);
  if (Number(request.headers.get('content-length')) > maxBytes) throw tooLarge();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new TranscriptionServiceError('A multipart audio recording is required.', 'INVALID_AUDIO_UPLOAD', 400);
  }
  request.signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) throw new TranscriptionServiceError('Audio recording is required.', 'INVALID_AUDIO_UPLOAD', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { abort(); throw tooLarge(); }
      chunks.push(next.value);
    }
    request.signal.throwIfAborted();
    try {
      return await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type')! },
        body: new Uint8Array(Buffer.concat(chunks)) }).formData();
    } catch {
      throw new TranscriptionServiceError('Invalid multipart audio recording.', 'INVALID_AUDIO_UPLOAD', 400);
    }
  } finally {
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
