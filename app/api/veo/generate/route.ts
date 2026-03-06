import { NextRequest, NextResponse } from 'next/server';
import {
  GoogleGenAI,
  VideoGenerationReferenceType,
  type GenerateVideosOperation,
  type VideoGenerationReferenceImage,
} from '@google/genai';
import { auth } from '@/app/lib/auth';
import { getFileStats, readFile, writeFile } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { getGeminiApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import {
  VEO_OUTPUT_DIR,
  createVeoOutputFilename,
  ensureVeoWorkspace,
} from '@/app/lib/integrations/veo-workspace';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

const MAX_REFERENCE_IMAGES = 3;

type GenerationMode = 'text_to_video' | 'frames_to_video' | 'references_to_video' | 'extend_video';

interface GenerateRequestBody {
  prompt?: string;
  model?: string;
  aspectRatio?: '16:9' | '9:16';
  resolution?: '720p' | '1080p' | '4k';
  mode?: GenerationMode;
  startFramePath?: string | null;
  endFramePath?: string | null;
  isLooping?: boolean;
  referenceImagePaths?: string[];
  inputVideoPath?: string | null;
}

function extensionFromPath(filePath: string): string {
  const ext = filePath.split('.').pop();
  return ext ? ext.toLowerCase() : '';
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

function resolveImageMime(filePath: string): string {
  const ext = extensionFromPath(filePath);
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new Error(`Unsupported image format: ${ext || 'unknown'}`);
  }
  return mime;
}

function resolveVideoMime(filePath: string): string {
  const ext = extensionFromPath(filePath);
  const mime = VIDEO_MIME[ext];
  if (!mime) {
    throw new Error(`Unsupported video format: ${ext || 'unknown'}`);
  }
  return mime;
}

async function loadImageBytes(filePath: string): Promise<{ imageBytes: string; mimeType: string }> {
  const mimeType = resolveImageMime(filePath);
  const stats = await getFileStats(filePath);
  if (!stats.isFile) {
    throw new Error(`Not a file: ${filePath}`);
  }
  const content = await readFile(filePath);
  return {
    imageBytes: content.toString('base64'),
    mimeType,
  };
}

async function loadVideoBytes(filePath: string): Promise<{ videoBytes: string; mimeType: string }> {
  const mimeType = resolveVideoMime(filePath);
  const stats = await getFileStats(filePath);
  if (!stats.isFile) {
    throw new Error(`Not a file: ${filePath}`);
  }
  const content = await readFile(filePath);
  return {
    videoBytes: content.toString('base64'),
    mimeType,
  };
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
  apiKey: string
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

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 10,
      windowMs: 60_000,
      keyPrefix: 'veo-generate',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const apiKey = await getGeminiApiKeyFromIntegrations();
    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: 'Gemini API key is missing. Configure GEMINI_API_KEY in /settings.',
        },
        { status: 400 }
      );
    }

    const body = (await request.json()) as GenerateRequestBody;
    const mode: GenerationMode = body.mode || 'text_to_video';
    const prompt = sanitizePrompt(body.prompt || '');
    const model = body.model || 'veo-3.1-fast-generate-preview';
    const aspectRatio = body.aspectRatio || '16:9';
    const resolution = body.resolution || '720p';

    if (!prompt && mode !== 'frames_to_video' && mode !== 'extend_video') {
      return NextResponse.json({ success: false, error: 'Prompt is required.' }, { status: 400 });
    }

    const ai = new GoogleGenAI({ apiKey });
    const payload: Record<string, unknown> = {
      model,
      config: {
        numberOfVideos: 1,
        resolution,
        aspectRatio,
      },
    };

    if (prompt) {
      payload.prompt = prompt;
    }

    if (mode === 'frames_to_video') {
      if (!body.startFramePath) {
        return NextResponse.json({ success: false, error: 'Start frame is required.' }, { status: 400 });
      }

      const startFrame = await loadImageBytes(body.startFramePath);
      payload.image = startFrame;

      const endFramePath = body.isLooping ? body.startFramePath : body.endFramePath;
      if (endFramePath) {
        const endFrame = await loadImageBytes(endFramePath);
        const config = (payload.config || {}) as Record<string, unknown>;
        config.lastFrame = endFrame;
        payload.config = config;
      }
    }

    if (mode === 'references_to_video') {
      const sourcePaths = (body.referenceImagePaths || []).slice(0, MAX_REFERENCE_IMAGES);
      if (!prompt || sourcePaths.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Prompt and at least one reference image are required.' },
          { status: 400 }
        );
      }

      const referenceImages: VideoGenerationReferenceImage[] = [];
      for (const sourcePath of sourcePaths) {
        const image = await loadImageBytes(sourcePath);
        referenceImages.push({
          image,
          referenceType: VideoGenerationReferenceType.ASSET,
        });
      }

      const config = (payload.config || {}) as Record<string, unknown>;
      config.referenceImages = referenceImages;
      payload.config = config;
    }

    if (mode === 'extend_video') {
      if (!body.inputVideoPath) {
        return NextResponse.json(
          { success: false, error: 'Input video is required for extend mode.' },
          { status: 400 }
        );
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

    const fetched = await fetchOperationVideo(operation, apiKey);
    await ensureVeoWorkspace();

    const promptSlug = promptToSlug(prompt);
    const outputFilename = createVeoOutputFilename(fetched.extension);
    const relativeVideoPath = `${VEO_OUTPUT_DIR}/${promptSlug}-${outputFilename}`;
    await writeFile(relativeVideoPath, fetched.bytes);

    const metadataPath = relativeVideoPath.replace(/\.[^.]+$/, '.json');
    await writeFile(
      metadataPath,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          createdBy: session.user.email,
          mode,
          model,
          prompt,
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
        },
        null,
        2
      )
    );

    return NextResponse.json({
      success: true,
      data: {
        path: relativeVideoPath,
        metadataPath,
        mediaUrl: toMediaUrl(relativeVideoPath),
      },
    });
  } catch (error) {
    console.error('[API] veo/generate error:', error);
    const message = error instanceof Error ? error.message : 'Video generation failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
