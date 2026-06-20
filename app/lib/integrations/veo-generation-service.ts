import 'server-only';

import {
  GoogleGenAI,
  VideoGenerationReferenceType,
  type GenerateVideosOperation,
  type VideoGenerationReferenceImage,
} from '@google/genai';

import {
  ensureStudioOutputsWorkspace,
  generateOutputFilename,
  writeOutputFile,
} from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { getGeminiApiKeyFromIntegrations, type EnvStorageScope } from '@/app/lib/integrations/env-config';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';
import {
  getVideoModelCapabilities,
  VEO_MAX_REFERENCE_IMAGES,
  type VideoResolution,
  type VideoDuration,
} from '@/app/lib/integrations/image-generation-constants';
import { loadMediaReference } from '@/app/lib/integrations/media-reference-resolver';
import { generateManagedMedia, isManagedMediaFallbackAvailable, type ManagedMediaReference } from '@/app/lib/integrations/managed-media-client';

export type GenerationMode = 'text_to_video' | 'frames_to_video' | 'references_to_video' | 'extend_video';

export interface GenerateVideoRequestBody {
  prompt?: string;
  model?: string;
  aspectRatio?: '16:9' | '9:16';
  resolution?: VideoResolution;
  durationSeconds?: VideoDuration;
  mode?: GenerationMode;
  startFramePath?: string | null;
  endFramePath?: string | null;
  isLooping?: boolean;
  referenceImagePaths?: string[];
  inputVideoPath?: string | null;
  personGeneration?: 'allow_all' | 'allow_adult' | 'dont_allow';
  negativePrompt?: string;
  enhancePrompt?: boolean;
  generateAudio?: boolean;
  seed?: number;
  storageScope?: EnvStorageScope | null;
}

export interface VideoGenerationResultData {
  path: string;
  mediaUrl: string;
  fileSize: number;
  mimeType: string;
  metadata: Record<string, unknown>;
}

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim();
}

function promptToSlug(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'video';
}

async function loadImageBytes(filePath: string): Promise<{ imageBytes: string; mimeType: string }> {
  try {
    const file = await loadMediaReference(filePath, { allowedTypes: ['image'] });
    return {
      imageBytes: file.imageBytes,
      mimeType: file.mimeType,
    };
  } catch (error) {
    throw new IntegrationServiceError(error instanceof Error ? error.message : `Image reference could not be loaded: ${filePath}`, 400);
  }
}

async function loadVideoBytes(filePath: string): Promise<{ videoBytes: string; mimeType: string }> {
  try {
    const file = await loadMediaReference(filePath, { allowedTypes: ['video'] });
    return {
      videoBytes: file.videoBytes,
      mimeType: file.mimeType,
    };
  } catch (error) {
    throw new IntegrationServiceError(error instanceof Error ? error.message : `Video reference could not be loaded: ${filePath}`, 400);
  }
}

function withApiKeyInUri(uri: string, apiKey: string): string {
  return `${uri}${uri.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
}

function extensionFromResponse(contentType: string | null): string {
  if (!contentType) {
    return 'mp4';
  }
  if (contentType.includes('quicktime')) {
    return 'mov';
  }
  return 'mp4';
}

async function fetchOperationVideo(
  operation: GenerateVideosOperation,
  apiKey: string,
): Promise<{ bytes: Buffer; sourceUri: string; extension: string }> {
  const generated = operation.response?.generatedVideos?.[0]?.video;
  if (!generated) {
    throw new Error('No video generated');
  }

  if (generated.videoBytes) {
    return {
      bytes: Buffer.from(generated.videoBytes, 'base64'),
      sourceUri: generated.uri || '',
      extension: generated.mimeType?.includes('quicktime') ? 'mov' : 'mp4',
    };
  }

  if (!generated.uri) {
    throw new Error('Generated video is missing URI and bytes');
  }

  const decodedUri = decodeURIComponent(generated.uri);
  const response = await fetch(withApiKeyInUri(decodedUri, apiKey));
  if (!response.ok) {
    throw new Error(`Failed to fetch generated video: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    sourceUri: decodedUri,
    extension: extensionFromResponse(response.headers.get('content-type')),
  };
}

export async function generateVideo(
  body: GenerateVideoRequestBody,
  callerEmail = 'system',
): Promise<VideoGenerationResultData> {
  const apiKey = await getGeminiApiKeyFromIntegrations(body.storageScope);
  const useManagedFallback = !apiKey && isManagedMediaFallbackAvailable();
  if (!apiKey && !useManagedFallback) {
    throw new IntegrationServiceError('Gemini API key is missing. Configure GEMINI_API_KEY in /settings.', 400);
  }

  const mode: GenerationMode = body.mode || 'text_to_video';
  const prompt = sanitizePrompt(body.prompt || '');
  const model = body.model || 'veo-3.1-fast-generate-preview';
  const aspectRatio = body.aspectRatio || '16:9';
  const resolution = body.resolution || '720p';
  const durationSeconds = body.durationSeconds || 6;

  const hasImageInput = mode === 'frames_to_video' || mode === 'references_to_video';
  const requestedPersonGeneration = body.personGeneration || 'allow_all';
  const personGeneration: 'allow_all' | 'allow_adult' | 'dont_allow' =
    (hasImageInput && requestedPersonGeneration === 'allow_all') ? 'allow_adult' : requestedPersonGeneration;

  if (!prompt && mode !== 'frames_to_video' && mode !== 'extend_video') {
    throw new IntegrationServiceError('Prompt is required.', 400);
  }

  const caps = getVideoModelCapabilities(model);

  if (mode === 'extend_video' && !caps.extension) {
    throw new IntegrationServiceError(`Video extension is not supported by model ${model}.`, 400);
  }
  if (mode === 'references_to_video' && !caps.references) {
    throw new IntegrationServiceError(`Reference images are not supported by model ${model}.`, 400);
  }
  if (mode === 'extend_video' && resolution !== '720p') {
    throw new IntegrationServiceError('Video extension requires 720p resolution.', 400);
  }
  if (mode === 'extend_video' && durationSeconds !== 8) {
    throw new IntegrationServiceError('Video extension requires 8-second duration.', 400);
  }
  if (!caps.resolutions.includes(resolution)) {
    throw new IntegrationServiceError(
      `Resolution ${resolution} is not supported by model ${model}. Supported: ${caps.resolutions.join(', ')}`,
      400,
    );
  }

  const needsMinDuration8 = resolution === '1080p' || resolution === '4k' || mode === 'references_to_video';
  const effectiveDuration = needsMinDuration8 ? 8 : durationSeconds;
  if (!caps.durations.includes(effectiveDuration as VideoDuration)) {
    throw new IntegrationServiceError(
      `Duration ${effectiveDuration}s is not supported by model ${model}. Supported: ${caps.durations.join(', ')}s`,
      400,
    );
  }
  if (!caps.personGeneration.includes(personGeneration)) {
    throw new IntegrationServiceError(
      `personGeneration "${personGeneration}" is not supported by model ${model} in ${mode} mode. Supported: ${caps.personGeneration.join(', ')}`,
      400,
    );
  }

  if (useManagedFallback) {
    const references: ManagedMediaReference[] = [];
    if (mode === 'frames_to_video') {
      if (!body.startFramePath) {
        throw new IntegrationServiceError('Start frame is required.', 400);
      }
      references.push({ ...(await loadImageBytes(body.startFramePath)), role: 'start_frame' });
      const endFramePath = body.isLooping ? null : body.endFramePath;
      if (endFramePath) references.push({ ...(await loadImageBytes(endFramePath)), role: 'end_frame' });
      for (const sourcePath of (body.referenceImagePaths || []).slice(0, VEO_MAX_REFERENCE_IMAGES)) {
        references.push({ ...(await loadImageBytes(sourcePath)), role: 'reference' });
      }
    }
    if (mode === 'references_to_video') {
      for (const sourcePath of (body.referenceImagePaths || []).slice(0, VEO_MAX_REFERENCE_IMAGES)) {
        references.push({ ...(await loadImageBytes(sourcePath)), role: 'reference' });
      }
    }
    if (mode === 'extend_video') {
      if (!body.inputVideoPath) {
        throw new IntegrationServiceError('Input video is required for extend mode.', 400);
      }
      const video = await loadVideoBytes(body.inputVideoPath);
      references.push({
        imageBytes: video.videoBytes,
        mimeType: video.mimeType,
        role: 'input_video',
      });
    }

    const managed = await generateManagedMedia({
      capability: 'video',
      provider: 'gemini',
      model,
      prompt,
      parameters: {
        mode,
        aspectRatio,
        resolution,
        durationSeconds: effectiveDuration,
        isLooping: body.isLooping || false,
        personGeneration,
        negativePrompt: body.negativePrompt,
        enhancePrompt: body.enhancePrompt,
        generateAudio: body.generateAudio,
        seed: body.seed,
      },
      references,
    });
    const output = managed.outputs[0];
    if (!output) throw new IntegrationServiceError('Managed Veo generation completed without output.', 500);

    await ensureStudioOutputsWorkspace();
    const promptSlug = promptToSlug(prompt);
    const extension = extensionFromResponse(output.mimeType);
    const relativeVideoPath = generateOutputFilename(promptSlug, 0, extension);
    await writeOutputFile(relativeVideoPath, output.bytes);
    const metadata = {
      provider: 'gemini',
      model,
      createdAt: new Date().toISOString(),
      createdBy: callerEmail,
      managedFallback: true,
      controlPlaneJobId: managed.jobId,
      mode,
      prompt,
      resolution,
      aspectRatio,
      durationSeconds: effectiveDuration,
      personGeneration,
      negativePrompt: body.negativePrompt || null,
      enhancePrompt: body.enhancePrompt ?? null,
      generateAudio: body.generateAudio ?? null,
      seed: body.seed ?? null,
      input: {
        startFramePath: body.startFramePath || null,
        endFramePath: body.endFramePath || null,
        referenceImagePaths: body.referenceImagePaths || [],
        inputVideoPath: body.inputVideoPath || null,
      },
      output: {
        path: relativeVideoPath,
        size: output.bytes.length,
        sourceUri: null,
      },
      providerMetadata: output.metadata || {},
    };

    return {
      path: relativeVideoPath,
      mediaUrl: toMediaUrl(relativeVideoPath),
      fileSize: output.bytes.length,
      mimeType: output.mimeType,
      metadata,
    };
  }

  const ai = new GoogleGenAI({ apiKey: apiKey! });
  const config: Record<string, unknown> = {
    numberOfVideos: 1,
    resolution,
    aspectRatio,
    durationSeconds: effectiveDuration,
    personGeneration,
  };

  if (body.negativePrompt) {
    config.negativePrompt = body.negativePrompt;
  }
  if (body.enhancePrompt !== undefined) {
    config.enhancePrompt = body.enhancePrompt;
  }
  if (body.generateAudio !== undefined) {
    config.generateAudio = body.generateAudio;
  }
  if (body.seed !== undefined) {
    config.seed = body.seed;
  }

  const payload: Record<string, unknown> = {
    model,
    config,
  };

  if (prompt) {
    payload.prompt = prompt;
  }

  if (mode === 'frames_to_video') {
    if (!body.startFramePath) {
      throw new IntegrationServiceError('Start frame is required.', 400);
    }

    const startFrame = await loadImageBytes(body.startFramePath);
    payload.image = startFrame;

    const endFramePath = body.isLooping ? body.startFramePath : body.endFramePath;
    if (endFramePath) {
      const endFrame = await loadImageBytes(endFramePath);
      config.lastFrame = endFrame;
    }

    const sourcePaths = (body.referenceImagePaths || []).slice(0, VEO_MAX_REFERENCE_IMAGES);
    if (sourcePaths.length > 0 && caps.references) {
      const referenceImages: VideoGenerationReferenceImage[] = [];
      for (const sourcePath of sourcePaths) {
        const image = await loadImageBytes(sourcePath);
        referenceImages.push({
          image,
          referenceType: VideoGenerationReferenceType.ASSET,
        });
      }
      config.referenceImages = referenceImages;
      if (effectiveDuration !== 8) {
        throw new IntegrationServiceError('Reference images require 8-second duration.', 400);
      }
    }
  }

  if (mode === 'references_to_video') {
    const sourcePaths = (body.referenceImagePaths || []).slice(0, VEO_MAX_REFERENCE_IMAGES);
    if (!prompt || sourcePaths.length === 0) {
      throw new IntegrationServiceError('Prompt and at least one reference image are required.', 400);
    }

    const referenceImages: VideoGenerationReferenceImage[] = [];
    for (const sourcePath of sourcePaths) {
      const image = await loadImageBytes(sourcePath);
      referenceImages.push({
        image,
        referenceType: VideoGenerationReferenceType.ASSET,
      });
    }

    config.referenceImages = referenceImages;
  }

  if (mode === 'extend_video') {
    if (!body.inputVideoPath) {
      throw new IntegrationServiceError('Input video is required for extend mode.', 400);
    }
    payload.video = await loadVideoBytes(body.inputVideoPath);
  }

  let operation = (await ai.models.generateVideos(payload as never)) as GenerateVideosOperation;

  const timeoutAt = Date.now() + 15 * 60 * 1000;
  while (!operation.done) {
    if (Date.now() > timeoutAt) {
      throw new Error('Video generation timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  if (operation.error) {
    throw new Error(JSON.stringify(operation.error));
  }

  const fetched = await fetchOperationVideo(operation, apiKey!);
  await ensureStudioOutputsWorkspace();

  const promptSlug = promptToSlug(prompt);
  const relativeVideoPath = generateOutputFilename(promptSlug, 0, fetched.extension);
  await writeOutputFile(relativeVideoPath, fetched.bytes);
  const metadata = {
    provider: 'gemini',
    model,
    createdAt: new Date().toISOString(),
    createdBy: callerEmail,
    mode,
    prompt,
    resolution,
    aspectRatio,
    durationSeconds: effectiveDuration,
    personGeneration,
    negativePrompt: body.negativePrompt || null,
    enhancePrompt: body.enhancePrompt ?? null,
    generateAudio: body.generateAudio ?? null,
    seed: body.seed ?? null,
    input: {
      startFramePath: body.startFramePath || null,
      endFramePath: body.endFramePath || null,
      referenceImagePaths: body.referenceImagePaths || [],
      inputVideoPath: body.inputVideoPath || null,
    },
    output: {
      path: relativeVideoPath,
      size: fetched.bytes.length,
      sourceUri: fetched.sourceUri,
    },
  };

  return {
    path: relativeVideoPath,
    mediaUrl: toMediaUrl(relativeVideoPath),
    fileSize: fetched.bytes.length,
    mimeType: fetched.extension === 'mov' ? 'video/quicktime' : 'video/mp4',
    metadata,
  };
}
