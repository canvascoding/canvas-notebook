import 'server-only';

import { GoogleGenAI } from '@google/genai';
import { setTimeout as delay } from 'node:timers/promises';
import type { DictationSettings } from './config';
import { TranscriptionServiceError } from './errors';
import { convertWisprAudio } from './wav';

type CloudInput = {
  buffer: Buffer; mimeType: string; key: string; language: string;
  prompt?: string; signal: AbortSignal; settings: DictationSettings;
};

function providerFailure(provider: string, status: number): TranscriptionServiceError {
  if (status === 401 || status === 403) {
    return new TranscriptionServiceError(provider === 'wispr'
      ? 'Wispr API access was denied. Check WISPR_API_KEY in /settings?tab=secrets and ensure Wispr has approved API access for your organization.'
      : 'Gemini API access was denied. Check GEMINI_API_KEY in /settings?tab=secrets and access to the selected model.',
    'TRANSCRIPTION_PROVIDER_ACCESS_DENIED', 502);
  }
  if (status === 429) return new TranscriptionServiceError(`${provider} transcription rate limit reached. Try again later.`, 'TRANSCRIPTION_RATE_LIMITED', 429);
  return new TranscriptionServiceError(`${provider} transcription failed${status ? ` (${status})` : ''}.`, 'TRANSCRIPTION_FAILED', 502);
}

function vocabulary(prompt?: string): string[] | undefined {
  // Tool prompts are vocabulary hints, never instructions to a speech model.
  return prompt ? prompt.split(/[,;\n]/u).map(term => term.trim()).filter(Boolean).slice(0, 100).map(term => term.slice(0, 100)) : undefined;
}

export async function transcribeWithGemini(input: CloudInput): Promise<string> {
  const client = new GoogleGenAI({ apiKey: input.key, httpOptions: { timeout: 90_000 } });
  const mimeType = input.mimeType === 'audio/mp4' || input.mimeType === 'video/mp4' ? 'audio/m4a'
    : input.mimeType === 'video/webm' ? 'audio/webm' : input.mimeType;
  let fileName: string | undefined;
  try {
    let file = await client.files.upload({
      file: new Blob([new Uint8Array(input.buffer)], { type: mimeType }),
      config: { mimeType, abortSignal: input.signal },
    });
    fileName = file.name;
    while (file.state === 'PROCESSING' && fileName) {
      await delay(500, undefined, { signal: input.signal });
      file = await client.files.get({ name: fileName, config: { abortSignal: input.signal } });
    }
    if (!file.uri || file.state === 'FAILED') throw providerFailure('gemini', 0);
    input.signal.throwIfAborted();
    const result = await client.interactions.create({
      model: input.settings.model,
      input: [{ type: 'audio', uri: file.uri, mime_type: mimeType }],
      store: false,
      generation_config: { transcription_config: {
        mode: input.settings.mode ?? 'smart',
        ...(input.language !== 'auto' ? { language_codes: [input.language] } : {}),
        ...(input.prompt ? { custom_vocabulary: vocabulary(input.prompt) } : {}),
      } },
    }, { signal: input.signal, maxRetries: 0 });
    return result.output_text ?? '';
  } catch (error) {
    if (input.signal.aborted || error instanceof TranscriptionServiceError) throw error;
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    throw providerFailure('gemini', status);
  } finally {
    if (fileName) {
      try { await client.files.delete({ name: fileName, config: { httpOptions: { timeout: 5_000 } } }); }
      catch { console.warn('[Transcription] Gemini temporary audio cleanup failed.'); }
    }
  }
}

export async function transcribeWithWispr(input: CloudInput): Promise<string> {
  const audio = await convertWisprAudio(input.buffer, input.signal);
  input.signal.throwIfAborted();
  const response = await fetch('https://platform-api.wisprflow.ai/api/v1/dash/api', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: audio.toString('base64'),
      ...(input.language !== 'auto' ? { language: [input.language] } : {}),
      ...(input.prompt ? { context: { dictionary_context: vocabulary(input.prompt) } } : {}),
    }),
    signal: input.signal,
  });
  if (!response.ok) throw providerFailure('wispr', response.status);
  const result = await response.json() as { text?: unknown };
  return typeof result.text === 'string' ? result.text : '';
}
