import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { auth } from '@/app/lib/auth';
import { getFileStats, readFile, writeFile } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { getGeminiApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import {
  NANO_BANANA_ROOT_DIR,
  NANO_BANANA_OUTPUT_DIR,
  createNanoBananaOutputFilename,
  ensureNanoBananaWorkspace,
} from '@/app/lib/integrations/nano-banana-workspace';

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

const ALLOWED_MODELS = new Set(['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']);
const ALLOWED_ASPECT_RATIOS = new Set(['16:9', '1:1', '9:16', '4:3', '3:4']);
const MAX_TARGET_MARKETS = 12;
const MAX_MARKET_LENGTH = 80;
const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 2_000;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 300;

interface LocalizeRequestBody {
  referenceImagePath?: string;
  targetMarkets?: string[];
  aspectRatio?: string;
  model?: string;
  customInstructions?: string;
}

interface LocalizedImageResult {
  market: string;
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

function normalizeMarkets(input: string[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of input) {
    const market = item.trim().replace(/\s+/g, ' ').slice(0, MAX_MARKET_LENGTH);
    if (!market) continue;
    const key = market.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(market);
    if (list.length >= MAX_TARGET_MARKETS) {
      break;
    }
  }
  return list;
}

function resolveAspectRatio(value: string | undefined): string | null {
  if (!value) return '16:9';
  return ALLOWED_ASPECT_RATIOS.has(value) ? value : null;
}

function resolveModel(value: string | undefined): string | null {
  const candidate = (value || 'gemini-3.1-flash-image-preview').trim();
  return ALLOWED_MODELS.has(candidate) ? candidate : null;
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Localization failed';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function validateReferencePath(referenceImagePath: string): boolean {
  return referenceImagePath.startsWith(`${NANO_BANANA_ROOT_DIR}/`);
}

function localizerPrompt(market: string, customInstructions: string): string {
  const basePrompt =
    `Translate all text in this advertisement image to the primary language used in ${market}. ` +
    'Keep the original layout, typography style, visual hierarchy, brand look, imagery, composition, color palette, and overall design unchanged. ' +
    'Only replace the textual content and keep the text natural and idiomatic for the target market. ' +
    'Do not add flags, national symbols, or culturally stereotypical visual elements. ' +
    'Preserve logos and product visuals exactly.';

  if (!customInstructions) {
    return basePrompt;
  }

  return `${basePrompt}\n\nAdditional instructions:\n${customInstructions}`;
}

async function loadImageBytes(filePath: string): Promise<{ imageBytes: string; mimeType: string }> {
  const mimeType = resolveImageMime(filePath);
  const stats = await getFileStats(filePath);
  if (!stats.isFile) {
    throw new Error(`Not a file: ${filePath}`);
  }
  if (stats.size <= 0) {
    throw new Error('Reference image is empty');
  }
  if (stats.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image is too large (max ${Math.floor(MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024))}MB)`);
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

  const fromData = response as { data?: string };
  const dataFromGetter = fromData.data;
  if (dataFromGetter) {
    return { imageBytes: dataFromGetter, mimeType: 'image/png' };
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
      limit: 6,
      windowMs: 60_000,
      keyPrefix: 'nano-banana-localize',
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

    let body: LocalizeRequestBody;
    try {
      body = (await request.json()) as LocalizeRequestBody;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON payload.' }, { status: 400 });
    }
    const referenceImagePath = body.referenceImagePath?.trim();
    const targetMarkets = normalizeMarkets(body.targetMarkets || []);
    const aspectRatio = resolveAspectRatio(body.aspectRatio);
    const model = resolveModel(body.model);
    const customInstructions = (body.customInstructions || '').trim().slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);

    if (!referenceImagePath) {
      return NextResponse.json({ success: false, error: 'Reference image path is required.' }, { status: 400 });
    }
    if (!validateReferencePath(referenceImagePath)) {
      return NextResponse.json(
        { success: false, error: `Reference image must be in ${NANO_BANANA_ROOT_DIR}.` },
        { status: 400 }
      );
    }
    if (targetMarkets.length === 0) {
      return NextResponse.json(
        { success: false, error: 'At least one target market is required.' },
        { status: 400 }
      );
    }
    if (!model) {
      return NextResponse.json({ success: false, error: 'Unsupported model.' }, { status: 400 });
    }
    if (!aspectRatio) {
      return NextResponse.json({ success: false, error: 'Unsupported aspect ratio.' }, { status: 400 });
    }

    const referenceImage = await loadImageBytes(referenceImagePath);
    await ensureNanoBananaWorkspace();

    const ai = new GoogleGenAI({ apiKey });
    const results: LocalizedImageResult[] = [];

    for (const market of targetMarkets) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    data: referenceImage.imageBytes,
                    mimeType: referenceImage.mimeType,
                  },
                },
                {
                  text: localizerPrompt(market, customInstructions),
                },
              ],
            },
          ],
          config: {
            responseModalities: ['IMAGE', 'TEXT'],
            imageConfig: { aspectRatio },
          },
        });

        const localized = extractInlineImage(response);
        const extension = extensionFromMime(localized.mimeType);
        const outputFilename = createNanoBananaOutputFilename(market, extension);
        const outputPath = `${NANO_BANANA_OUTPUT_DIR}/${outputFilename}`;
        const outputBytes = Buffer.from(localized.imageBytes, 'base64');
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
              market,
              referenceImagePath,
              customInstructions,
              output: {
                path: outputPath,
                mimeType: localized.mimeType,
                size: outputBytes.length,
              },
            },
            null,
            2
          )
        );

        results.push({
          market,
          path: outputPath,
          metadataPath,
          mediaUrl: toMediaUrl(outputPath),
        });
      } catch (error) {
        const message = sanitizeErrorMessage(error);
        results.push({
          market,
          error: message,
        });
      }
    }

    const successCount = results.filter((item) => !item.error).length;
    const failureCount = results.length - successCount;

    if (successCount === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Localization failed for all target markets.',
          data: {
            results,
            successCount,
            failureCount,
          },
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        referenceImagePath,
        model,
        aspectRatio,
        outputDir: NANO_BANANA_OUTPUT_DIR,
        successCount,
        failureCount,
        results,
      },
    });
  } catch (error) {
    console.error('[API] nano-banana/localize error:', error);
    const message = sanitizeErrorMessage(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
