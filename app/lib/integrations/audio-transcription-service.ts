import 'server-only';

import { getGroqApiKeyFromIntegrations, readScopedEnvState } from './env-config';
import { IntegrationServiceError } from './integration-service-error';

export const MAX_AUDIO_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
export const DEFAULT_GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

export type AudioTranscriptionProvider = 'groq';

export interface TranscribeAudioRequest {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface AudioTranscriptionResult {
  text: string;
  provider: AudioTranscriptionProvider;
  model: string;
  durationMs: number;
}

type GroqTranscriptionResponse = {
  text?: unknown;
  error?: {
    message?: unknown;
  };
};

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

async function getGroqTranscriptionModel(): Promise<string> {
  try {
    const state = await readScopedEnvState('integrations');
    const byKey = new Map(state.entries.map((entry) => [entry.key, entry.value]));
    return (
      normalizeOptionalText(byKey.get('GROQ_TRANSCRIPTION_MODEL')) ||
      normalizeOptionalText(byKey.get('VOICE_TRANSCRIPTION_MODEL')) ||
      normalizeOptionalText(process.env.GROQ_TRANSCRIPTION_MODEL) ||
      normalizeOptionalText(process.env.VOICE_TRANSCRIPTION_MODEL) ||
      DEFAULT_GROQ_TRANSCRIPTION_MODEL
    );
  } catch {
    return (
      normalizeOptionalText(process.env.GROQ_TRANSCRIPTION_MODEL) ||
      normalizeOptionalText(process.env.VOICE_TRANSCRIPTION_MODEL) ||
      DEFAULT_GROQ_TRANSCRIPTION_MODEL
    );
  }
}

async function parseGroqError(response: Response): Promise<string> {
  const body = await response.text();
  if (!body) {
    return `Groq transcription request failed (${response.status}).`;
  }

  try {
    const parsed = JSON.parse(body) as GroqTranscriptionResponse;
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : null;
    return message || `Groq transcription request failed (${response.status}). ${body.slice(0, 300)}`;
  } catch {
    return `Groq transcription request failed (${response.status}). ${body.slice(0, 300)}`;
  }
}

export async function transcribeAudio(request: TranscribeAudioRequest): Promise<AudioTranscriptionResult> {
  const startedAt = Date.now();
  if (request.buffer.length === 0) {
    throw new IntegrationServiceError('Audio transcription requires a non-empty audio file.', 400);
  }
  if (request.buffer.length > MAX_AUDIO_TRANSCRIPTION_BYTES) {
    throw new IntegrationServiceError(
      `Audio file is too large for transcription. Maximum size: ${MAX_AUDIO_TRANSCRIPTION_BYTES / (1024 * 1024)}MB.`,
      400,
    );
  }

  const apiKey = await getGroqApiKeyFromIntegrations();
  if (!apiKey) {
    throw new IntegrationServiceError(
      'Voice transcription is not configured. Configure GROQ_API_KEY in /settings?tab=integrations.',
      400,
    );
  }

  const model = await getGroqTranscriptionModel();
  const formData = new FormData();
  formData.set(
    'file',
    new Blob([new Uint8Array(request.buffer)], {
      type: request.mimeType || 'application/octet-stream',
    }),
    request.filename,
  );
  formData.set('model', model);
  formData.set('response_format', 'json');

  const language = normalizeOptionalText(request.language);
  if (language) {
    formData.set('language', language);
  }

  const prompt = normalizeOptionalText(request.prompt);
  if (prompt) {
    formData.set('prompt', prompt);
  }

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: request.signal,
  });

  if (!response.ok) {
    throw new IntegrationServiceError(await parseGroqError(response), response.status);
  }

  const parsed = await response.json() as GroqTranscriptionResponse;
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!text) {
    throw new IntegrationServiceError('Audio transcription completed without transcript text.', 502);
  }

  return {
    text,
    provider: 'groq',
    model,
    durationMs: Date.now() - startedAt,
  };
}
