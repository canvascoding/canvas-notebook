import 'server-only';

import { GoogleGenAI } from '@google/genai';
import { getGeminiApiKeyFromIntegrations, type EnvStorageScope } from './env-config';
import { IntegrationServiceError } from './integration-service-error';
import { generateManagedMedia, isManagedMediaFallbackAvailable } from './managed-media-client';

export const LYRIA_CLIP_MODEL_ID = 'lyria-3-clip-preview';
export const LYRIA_PRO_MODEL_ID = 'lyria-3-pro-preview';

export type LyriaModelId = typeof LYRIA_CLIP_MODEL_ID | typeof LYRIA_PRO_MODEL_ID;
export type SoundOutputFormat = 'mp3' | 'wav';

export interface GenerateSoundReferenceImage {
  imageBytes: string;
  mimeType: string;
}

export interface GenerateSoundRequest {
  prompt: string;
  model?: string;
  outputFormat?: SoundOutputFormat;
  referenceImages?: GenerateSoundReferenceImage[];
  storageScope?: EnvStorageScope | null;
}

export interface GenerateSoundResult {
  audioBytes: Buffer;
  mimeType: string;
  lyricsText: string | null;
  metadata: {
    provider: 'gemini';
    model: LyriaModelId;
    outputFormat: SoundOutputFormat;
    referenceImageCount: number;
    textParts: string[];
    managedFallback?: boolean;
    controlPlaneJobId?: string;
    providerMetadata?: Record<string, unknown>;
  };
}

const SUPPORTED_MODELS = new Set<string>([LYRIA_CLIP_MODEL_ID, LYRIA_PRO_MODEL_ID]);

function resolveModel(model?: string): LyriaModelId {
  return SUPPORTED_MODELS.has(model || '') ? model as LyriaModelId : LYRIA_CLIP_MODEL_ID;
}

function resolveOutputFormat(model: LyriaModelId, outputFormat?: SoundOutputFormat): SoundOutputFormat {
  if (model === LYRIA_PRO_MODEL_ID && outputFormat === 'wav') {
    return 'wav';
  }
  return 'mp3';
}

function extractLyriaParts(response: unknown): { audioBytes: Buffer; mimeType: string; textParts: string[] } {
  const candidates = (response as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> } }>;
  }).candidates || [];

  const textParts: string[] = [];
  let audioBytes: Buffer | null = null;
  let mimeType = 'audio/mpeg';

  for (const candidate of candidates) {
    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        textParts.push(part.text);
      } else if (part.inlineData?.data) {
        audioBytes = Buffer.from(part.inlineData.data, 'base64');
        mimeType = part.inlineData.mimeType || mimeType;
      }
    }
  }

  if (!audioBytes) {
    console.error('[Gemini Sound] No audio in response:', JSON.stringify(response, null, 2).slice(0, 2000));
    throw new Error('No audio was returned by Lyria.');
  }

  return { audioBytes, mimeType, textParts };
}

export async function generateSound(request: GenerateSoundRequest): Promise<GenerateSoundResult> {
  const model = resolveModel(request.model);
  const outputFormat = resolveOutputFormat(model, request.outputFormat);
  const referenceImages = (request.referenceImages || []).slice(0, 10);
  const apiKey = await getGeminiApiKeyFromIntegrations(request.storageScope);
  const useManagedFallback = !apiKey && isManagedMediaFallbackAvailable();
  if (!apiKey && !useManagedFallback) {
    throw new IntegrationServiceError('Gemini API key is missing. Configure GEMINI_API_KEY in /settings?tab=integrations.', 400);
  }

  if (useManagedFallback) {
    const managed = await generateManagedMedia({
      capability: 'sound',
      provider: 'gemini',
      model,
      prompt: request.prompt,
      parameters: {
        outputFormat,
      },
      references: referenceImages.map((image) => ({
        imageBytes: image.imageBytes,
        mimeType: image.mimeType,
        role: 'reference',
      })),
    });
    const output = managed.outputs[0];
    if (!output) {
      throw new IntegrationServiceError('Managed Gemini sound generation completed without output.', 500);
    }
    const rawTextParts = Array.isArray(output.metadata?.textParts) ? output.metadata.textParts : [];
    const textParts = rawTextParts.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return {
      audioBytes: output.bytes,
      mimeType: output.mimeType,
      lyricsText: textParts.length > 0 ? textParts.join('\n\n') : null,
      metadata: {
        provider: 'gemini',
        model,
        outputFormat,
        referenceImageCount: referenceImages.length,
        textParts,
        managedFallback: true,
        controlPlaneJobId: managed.jobId,
        providerMetadata: output.metadata,
      },
    };
  }

  const ai = new GoogleGenAI({ apiKey: apiKey! });
  type GenerateContentConfig = NonNullable<Parameters<typeof ai.models.generateContent>[0]['config']>;
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: request.prompt },
    ...referenceImages.map((image) => ({
      inlineData: {
        mimeType: image.mimeType,
        data: image.imageBytes,
      },
    })),
  ];

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: model === LYRIA_PRO_MODEL_ID && outputFormat === 'wav'
      ? {
          responseModalities: ['AUDIO', 'TEXT'],
          responseFormat: { audio: { mimeType: 'audio/wav' } },
        } as unknown as GenerateContentConfig
      : undefined,
  });

  const extracted = extractLyriaParts(response);
  const mimeType = outputFormat === 'wav' ? 'audio/wav' : (extracted.mimeType || 'audio/mpeg');

  return {
    audioBytes: extracted.audioBytes,
    mimeType,
    lyricsText: extracted.textParts.length > 0 ? extracted.textParts.join('\n\n') : null,
    metadata: {
      provider: 'gemini',
      model,
      outputFormat,
      referenceImageCount: referenceImages.length,
      textParts: extracted.textParts,
    },
  };
}
