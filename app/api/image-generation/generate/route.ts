import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { auth } from '@/app/lib/auth';
import { getFileStats, readFile, writeFile } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { getGeminiApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import {
  IMAGE_GENERATION_OUTPUT_DIR,
  createImageGenerationOutputFilename,
  ensureImageGenerationWorkspace,
} from '@/app/lib/integrations/image-generation-workspace';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const ALLOWED_MODELS = new Set(['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image-preview']);
const ALLOWED_ASPECT_RATIOS = new Set(['16:9', '1:1', '9:16', '4:3', '3:4']);
const MAX_PROMPT_LENGTH = 3_000;
const MAX_IMAGE_COUNT = 4;
const MAX_REFERENCE_IMAGES = 10;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 300;

interface GenerateRequestBody {
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  imageCount?: number;
  referenceImagePaths?: string[];
}

interface GeneratedImageResult {
  index: number;
  path?: string;
  metadataPath?: string;
  mediaUrl?: string;
  error?: string;
}

function extensionFromPath(filePath: string): string {
  const ext = filePath.split('.').pop();
  return ext ? ext.toLowerCase() : '';
}

function resolveImageMime(filePath: string): string {
  const ext = extensionFromPath(filePath);
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new Error(`Unsupported reference image format: ${ext || 'unknown'}`);
  }
  return mime;
}

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_LENGTH);
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Image generation failed';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function resolveAspectRatio(value: string | undefined): string | null {
  if (!value) return '1:1';
  return ALLOWED_ASPECT_RATIOS.has(value) ? value : null;
}

function resolveModel(value: string | undefined): string | null {
  const candidate = (value || 'gemini-3.1-flash-image-preview').trim();
  return ALLOWED_MODELS.has(candidate) ? candidate : null;
}

function resolveImageCount(value: number | undefined): number | null {
  if (value === undefined) return MAX_IMAGE_COUNT;
  if (!Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_IMAGE_COUNT) return null;
  return value;
}

function normalizeReferencePaths(input: string[]): string[] {
  const list: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of input) {
    const filePath = rawPath.trim();
    if (!filePath) {
      continue;
    }

    const normalizedPath = path.posix.normalize(filePath).replace(/^\.?\//, '');
    if (
      !normalizedPath ||
      normalizedPath === '.' ||
      normalizedPath.startsWith('/') ||
      normalizedPath.startsWith('../') ||
      normalizedPath.includes('/../')
    ) {
      continue;
    }

    const extension = extensionFromPath(normalizedPath);
    if (!IMAGE_MIME[extension]) {
      continue;
    }

    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    list.push(normalizedPath);
    if (list.length >= MAX_REFERENCE_IMAGES) {
      break;
    }
  }

  return list;
}

async function loadImageBytes(filePath: string): Promise<{ imageBytes: string; mimeType: string }> {
  const mimeType = resolveImageMime(filePath);
  const stats = await getFileStats(filePath);
  if (!stats.isFile) {
    throw new Error(`Not a file: ${filePath}`);
  }
  if (stats.size <= 0) {
    throw new Error(`Reference image is empty: ${filePath}`);
  }
  if (stats.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image too large: ${filePath}`);
  }

  const content = await readFile(filePath);
  return {
    imageBytes: content.toString('base64'),
    mimeType,
  };
}

function extractInlineImage(response: unknown): { imageBytes: string; mimeType: string } {
  const candidates = (
    response as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
    }
  ).candidates;

  for (const candidate of candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        return {
          imageBytes: part.inlineData.data,
          mimeType: part.inlineData.mimeType || 'image/png',
        };
      }
    }
  }

  const fallback = response as { data?: string };
  if (fallback.data) {
    return { imageBytes: fallback.data, mimeType: 'image/png' };
  }

  throw new Error('No image was returned by the model');
}

function extensionFromMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType] || 'png';
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  const skillsToken = request.headers.get('x-canvas-skills-token');
  const isSkillsCall = !!skillsToken && skillsToken === process.env.CANVAS_SKILLS_TOKEN;
  if (!session && !isSkillsCall) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const callerEmail = session?.user?.email ?? 'skills-cli';

  try {
    const limited = rateLimit(request, {
      limit: 8,
      windowMs: 60_000,
      keyPrefix: 'image-generation-generate',
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

    let body: GenerateRequestBody;
    try {
      body = (await request.json()) as GenerateRequestBody;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON payload.' }, { status: 400 });
    }

    const prompt = sanitizePrompt(body.prompt || '');
    const model = resolveModel(body.model);
    const aspectRatio = resolveAspectRatio(body.aspectRatio);
    const imageCount = resolveImageCount(body.imageCount);
    const referenceImagePaths = normalizeReferencePaths(body.referenceImagePaths || []);

    if (!model) {
      return NextResponse.json({ success: false, error: 'Unsupported model.' }, { status: 400 });
    }
    if (!aspectRatio) {
      return NextResponse.json({ success: false, error: 'Unsupported aspect ratio.' }, { status: 400 });
    }
    if (!imageCount) {
      return NextResponse.json(
        { success: false, error: `imageCount must be between 1 and ${MAX_IMAGE_COUNT}.` },
        { status: 400 }
      );
    }
    if (!prompt && referenceImagePaths.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Prompt or at least one reference image is required.' },
        { status: 400 }
      );
    }

    const referenceImages = await Promise.all(referenceImagePaths.map((filePath) => loadImageBytes(filePath)));

    await ensureImageGenerationWorkspace();
    const ai = new GoogleGenAI({ apiKey });

    const generationJobs = Array.from({ length: imageCount }, async (_, index): Promise<GeneratedImageResult> => {
      try {
        const parts: Array<
          | { inlineData: { data: string; mimeType: string } }
          | { text: string }
        > = [];

        for (const image of referenceImages) {
          parts.push({
            inlineData: {
              data: image.imageBytes,
              mimeType: image.mimeType,
            },
          });
        }

        if (prompt) {
          parts.push({ text: prompt });
        }

        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts,
            },
          ],
          config: {
            responseModalities: ['IMAGE', 'TEXT'],
            imageConfig: {
              aspectRatio,
              imageSize: '1K',
            },
          },
        });

        const generated = extractInlineImage(response);
        const extension = extensionFromMime(generated.mimeType);
        const outputFilename = createImageGenerationOutputFilename(prompt || 'reference', index, extension);
        const outputPath = `${IMAGE_GENERATION_OUTPUT_DIR}/${outputFilename}`;
        const outputBytes = Buffer.from(generated.imageBytes, 'base64');
        await writeFile(outputPath, outputBytes);

        const metadataPath = outputPath.replace(/\.[^.]+$/, '.json');
        await writeFile(
          metadataPath,
          JSON.stringify(
            {
              createdAt: new Date().toISOString(),
              createdBy: callerEmail,
              model,
              aspectRatio,
              prompt,
              referenceImagePaths,
              variationIndex: index,
              output: {
                path: outputPath,
                mimeType: generated.mimeType,
                size: outputBytes.length,
              },
            },
            null,
            2
          )
        );

        return {
          index,
          path: outputPath,
          metadataPath,
          mediaUrl: toMediaUrl(outputPath),
        };
      } catch (error) {
        return {
          index,
          error: sanitizeErrorMessage(error),
        };
      }
    });

    const results = await Promise.all(generationJobs);
    const successCount = results.filter((item) => !item.error).length;
    const failureCount = results.length - successCount;

    if (successCount === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Image generation failed for all requested variations.',
          data: {
            successCount,
            failureCount,
            results,
          },
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        model,
        aspectRatio,
        imageCount,
        outputDir: IMAGE_GENERATION_OUTPUT_DIR,
        successCount,
        failureCount,
        results,
      },
    });
  } catch (error) {
    console.error('[API] image-generation/generate error:', error);
    const message = sanitizeErrorMessage(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
