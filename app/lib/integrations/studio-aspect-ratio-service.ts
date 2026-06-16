import 'server-only';

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { db } from '@/app/lib/db';
import { studioGenerationOutputs, studioGenerations } from '@/app/lib/db/schema';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
import { getImageGenerationProvider } from '@/app/lib/integrations/image-generation-providers';
import { classifyMediaReference, loadMediaReference } from '@/app/lib/integrations/media-reference-resolver';
import {
  ensureStudioEditsWorkspace,
  ensureStudioOutputsWorkspace,
  getStudioEditsRoot,
  readEditFile,
  writeOutputFile,
  writeEditFile,
} from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';

export type AspectRatioMode = 'crop' | 'ai_extend';
export type AspectRatioProvider = 'openai' | 'gemini';

export interface AspectRatioFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AspectRatioPreviewRequest {
  sourcePath: string;
  frame: AspectRatioFrame;
  mode: AspectRatioMode;
  aspectRatio: string;
  targetWidth: number;
  targetHeight: number;
  provider?: AspectRatioProvider;
  model?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
  imageSize?: string;
}

export interface AspectRatioPreviewResult {
  path: string;
  name: string;
  mediaUrl: string;
  previewUrl: string;
  mode: AspectRatioMode;
  width: number;
  height: number;
  mimeType: string;
}

export type AspectRatioSaveAction = 'copy_workspace' | 'overwrite_original' | 'keep_edit';

export interface AspectRatioSaveRequest {
  previewPath: string;
  action: AspectRatioSaveAction;
  sourcePath?: string;
  aspectRatio?: string;
  mode?: AspectRatioMode;
  provider?: AspectRatioProvider;
  model?: string;
  targetDirectory?: string;
  fileName?: string;
  confirmOverwrite?: boolean;
}

const SUPPORTED_ASPECT_RATIOS = ['1:1', '4:5', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3', 'freeform'];
const MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const;

function trimHyphens(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function sanitizeFileName(input: string | undefined, fallback: string) {
  const raw = (input || fallback).trim();
  const parsed = path.posix.parse(raw);
  const safeBase = trimHyphens((parsed.name || fallback).replace(/[^a-z0-9._-]+/gi, '-'))
    .slice(0, 80) || fallback;
  const ext = parsed.ext.replace(/[^a-z0-9.]/gi, '').toLowerCase();
  return `${safeBase}${ext || '.png'}`;
}

function normalizeFormat(format: unknown): 'png' | 'jpeg' | 'webp' {
  return format === 'jpeg' || format === 'webp' ? format : 'png';
}

function validatePreviewRequest(input: AspectRatioPreviewRequest): AspectRatioPreviewRequest {
  const sourcePath = typeof input.sourcePath === 'string' ? input.sourcePath.trim() : '';
  if (!sourcePath) throw new Error('sourcePath is required');
  if (!SUPPORTED_ASPECT_RATIOS.includes(input.aspectRatio)) {
    throw new Error('Unsupported aspect ratio');
  }

  const frame = {
    x: assertFiniteNumber(input.frame?.x, 'frame.x'),
    y: assertFiniteNumber(input.frame?.y, 'frame.y'),
    width: assertFiniteNumber(input.frame?.width, 'frame.width'),
    height: assertFiniteNumber(input.frame?.height, 'frame.height'),
  };
  if (frame.width <= 1 || frame.height <= 1) {
    throw new Error('Frame is too small');
  }

  const targetWidth = Math.round(assertFiniteNumber(input.targetWidth, 'targetWidth'));
  const targetHeight = Math.round(assertFiniteNumber(input.targetHeight, 'targetHeight'));
  if (targetWidth < 64 || targetHeight < 64 || targetWidth > 4096 || targetHeight > 4096) {
    throw new Error('Target size must be between 64 and 4096 pixels');
  }

  if (input.mode === 'ai_extend' && (!input.provider || !input.model)) {
    throw new Error('Provider and model are required for AI extend');
  }

  return {
    ...input,
    sourcePath,
    frame,
    targetWidth,
    targetHeight,
    outputFormat: normalizeFormat(input.outputFormat),
  };
}

function frameIsInsideImage(frame: AspectRatioFrame, width: number, height: number) {
  return frame.x >= 0 &&
    frame.y >= 0 &&
    frame.x + frame.width <= width &&
    frame.y + frame.height <= height;
}

async function renderCrop(sourceBytes: Buffer, frame: AspectRatioFrame, targetWidth: number, targetHeight: number, format: 'png' | 'jpeg' | 'webp') {
  const left = Math.max(0, Math.round(frame.x));
  const top = Math.max(0, Math.round(frame.y));
  const width = Math.max(1, Math.round(frame.width));
  const height = Math.max(1, Math.round(frame.height));

  let pipeline = sharp(sourceBytes, { limitInputPixels: false })
    .rotate()
    .extract({ left, top, width, height })
    .resize(targetWidth, targetHeight, { fit: 'fill' });

  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 92, mozjpeg: true });
  else if (format === 'webp') pipeline = pipeline.webp({ quality: 92 });
  else pipeline = pipeline.png({ compressionLevel: 6 });

  return pipeline.toBuffer();
}

interface ExtendArtifacts {
  baseCanvas: Buffer;
  geminiGuideCanvas: Buffer;
  openAiMask: Buffer;
  lockedLayer: Buffer;
}

const GEMINI_GUIDE_FILL = { r: 255, g: 0, b: 170, alpha: 1 };

async function renderExtendArtifacts(sourceBytes: Buffer, frame: AspectRatioFrame, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): Promise<ExtendArtifacts> {
  const scaleX = targetWidth / frame.width;
  const scaleY = targetHeight / frame.height;
  const sx = Math.max(frame.x, 0);
  const sy = Math.max(frame.y, 0);
  const ex = Math.min(frame.x + frame.width, sourceWidth);
  const ey = Math.min(frame.y + frame.height, sourceHeight);
  if (ex <= sx || ey <= sy) {
    throw new Error('Frame must overlap the source image for AI extend');
  }

  const visibleWidth = ex - sx;
  const visibleHeight = ey - sy;
  const left = Math.max(0, Math.min(targetWidth - 1, Math.round((sx - frame.x) * scaleX)));
  const top = Math.max(0, Math.min(targetHeight - 1, Math.round((sy - frame.y) * scaleY)));
  const width = Math.max(1, Math.min(targetWidth - left, Math.round(visibleWidth * scaleX)));
  const height = Math.max(1, Math.min(targetHeight - top, Math.round(visibleHeight * scaleY)));
  const sourceLeft = Math.max(0, Math.min(sourceWidth - 1, Math.floor(sx)));
  const sourceTop = Math.max(0, Math.min(sourceHeight - 1, Math.floor(sy)));
  const sourceRight = Math.max(sourceLeft + 1, Math.min(sourceWidth, Math.ceil(ex)));
  const sourceBottom = Math.max(sourceTop + 1, Math.min(sourceHeight, Math.ceil(ey)));

  const cropped = await sharp(sourceBytes, { limitInputPixels: false })
    .rotate()
    .extract({
      left: sourceLeft,
      top: sourceTop,
      width: sourceRight - sourceLeft,
      height: sourceBottom - sourceTop,
    })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer();

  const lockedLayer = await sharp({
    create: {
      width: targetWidth,
      height: targetHeight,
      channels: 4,
      background: { r: 255, g: 0, b: 170, alpha: 0 },
    },
  })
    .composite([{ input: cropped, left, top }])
    .png()
    .toBuffer();

  // Gemini currently gets a visual guide, so the fill area is intentionally loud instead of transparent.
  const geminiGuideCanvas = await sharp({
    create: {
      width: targetWidth,
      height: targetHeight,
      channels: 4,
      background: GEMINI_GUIDE_FILL,
    },
  })
    .composite([{ input: cropped, left, top }])
    .png()
    .toBuffer();

  const preserveMask = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const openAiMask = await sharp({
    create: {
      width: targetWidth,
      height: targetHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: preserveMask, left, top }])
    .png()
    .toBuffer();

  return {
    baseCanvas: lockedLayer,
    geminiGuideCanvas,
    openAiMask,
    lockedLayer,
  };
}

function buildExtendPrompt(aspectRatio: string, providerId: string) {
  if (providerId === 'gemini') {
    return [
      `Extend this image to the requested ${aspectRatio} composition.`,
      'The reference image is a final-canvas layout guide.',
      'Real image pixels are locked context. Bright magenta areas are placeholders for missing content and must be fully replaced.',
      'Do not restore or invent content that was cropped out of the visible context.',
      'Keep the locked context visually unchanged and generate only a natural continuation in the magenta areas.',
      'Return one complete image with no magenta guide color, no labels, no border, no watermark, and no explanation.',
    ].join(' ');
  }

  return [
    `Extend this image to the requested ${aspectRatio} composition.`,
    'The provided reference image is already placed on the final canvas.',
    'The mask marks the only regions that must be generated.',
    'Preserve the original visible image exactly: do not repaint, reinterpret, crop, distort, or replace it.',
    'Only fill the missing outside areas naturally, continuing perspective, lighting, texture, color, depth of field, and scene logic.',
    'Return one complete image with no labels, no guides, no border, no watermark, and no explanation.',
  ].join(' ');
}

function buildExtendContextPrompt(providerId: string) {
  if (providerId === 'gemini') {
    return 'You are performing image outpainting for an aspect-ratio editor. Use the magenta guide areas as the missing generated regions and keep the visible original pixels unchanged.';
  }
  return 'You are performing image outpainting for an aspect-ratio editor. Use the edit mask as the source of truth for missing regions and keep the original pixels visually unchanged.';
}

function buildEditFileName(mode: AspectRatioMode, sourcePath: string, format: string) {
  const base = path.posix.parse(sourcePath.split(/[?#]/, 1)[0] || 'image').name || 'image';
  const safeBase = trimHyphens(base.replace(/[^a-z0-9._-]+/gi, '-')).slice(0, 50) || 'image';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = crypto.randomUUID().slice(0, 8);
  const ext = format === 'jpeg' ? 'jpg' : format;
  return `${safeBase}-${mode}-${timestamp}-${id}.${ext}`;
}

async function writeEditResult(buffer: Buffer, fileName: string, mode: AspectRatioMode, width: number, height: number, mimeType: string): Promise<AspectRatioPreviewResult> {
  await ensureStudioEditsWorkspace();
  await writeEditFile(fileName, buffer);
  const virtualPath = `studio/edits/${fileName}`;
  return {
    path: virtualPath,
    name: fileName,
    mediaUrl: toMediaUrl(virtualPath),
    previewUrl: toPreviewUrl(virtualPath, 960),
    mode,
    width,
    height,
    mimeType,
  };
}

export async function createAspectRatioPreview(input: AspectRatioPreviewRequest): Promise<AspectRatioPreviewResult> {
  const request = validatePreviewRequest(input);
  const source = await loadMediaReference(request.sourcePath, { allowedTypes: ['image'] });
  const sourceBytes = source.bytes;
  const metadata = await sharp(sourceBytes, { limitInputPixels: false }).metadata();
  const sourceWidth = metadata.width || source.width || 0;
  const sourceHeight = metadata.height || source.height || 0;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('Could not read source image dimensions');
  }

  const requestedMode = request.mode;
  const actualMode: AspectRatioMode = frameIsInsideImage(request.frame, sourceWidth, sourceHeight) ? 'crop' : 'ai_extend';
  if (requestedMode === 'crop' && actualMode !== 'crop') {
    throw new Error('Frame extends outside the image. AI extend is required.');
  }
  if (request.aspectRatio === 'freeform' && actualMode === 'ai_extend') {
    throw new Error('Freeform is only available for crop-only edits');
  }

  const outputFormat = normalizeFormat(request.outputFormat);
  if (actualMode === 'crop') {
    const output = await renderCrop(sourceBytes, request.frame, request.targetWidth, request.targetHeight, outputFormat);
    return writeEditResult(
      output,
      buildEditFileName('crop', request.sourcePath, outputFormat),
      'crop',
      request.targetWidth,
      request.targetHeight,
      MIME_BY_FORMAT[outputFormat],
    );
  }

  const provider = getImageGenerationProvider(request.provider || '');
  if (!provider) {
    throw new Error('Unsupported image provider');
  }
  const model = provider.models.some((candidate) => candidate.id === request.model)
    ? request.model!
    : provider.models[0]?.id;
  if (!model) {
    throw new Error('No model available for provider');
  }
  if (!provider.supportedAspectRatios.includes(request.aspectRatio)) {
    const supportedList = provider.supportedAspectRatios.join(', ');
    throw new Error(`Aspect ratio ${request.aspectRatio} is not supported by ${provider.name}. Supported ratios: ${supportedList}.`);
  }

  const extendArtifacts = await renderExtendArtifacts(
    sourceBytes,
    request.frame,
    sourceWidth,
    sourceHeight,
    request.targetWidth,
    request.targetHeight,
  );
  const isGemini = provider.id === 'gemini';
  const generated = await provider.generate({
    prompt: buildExtendPrompt(request.aspectRatio, provider.id),
    model,
    aspectRatio: request.aspectRatio,
    referenceImages: [
      {
        imageBytes: (isGemini ? extendArtifacts.geminiGuideCanvas : extendArtifacts.baseCanvas).toString('base64'),
        mimeType: 'image/png',
        fileName: isGemini ? 'outpaint-layout-guide.png' : 'outpaint-base.png',
      },
    ],
    editMask: isGemini
      ? undefined
      : {
        imageBytes: extendArtifacts.openAiMask.toString('base64'),
        mimeType: 'image/png',
        fileName: 'outpaint-mask.png',
      },
    quality: request.quality,
    outputFormat,
    background: request.background,
    imageSize: request.imageSize,
    contextPrompt: buildExtendContextPrompt(provider.id),
  });

  const generatedBytes = Buffer.from(generated.imageBytes, 'base64');
  // The model may drift on preserved pixels; this pins the exact visible crop back onto the final image.
  const normalizedOutput = await sharp(generatedBytes, { limitInputPixels: false })
    .resize(request.targetWidth, request.targetHeight, { fit: 'cover' })
    .composite([{ input: extendArtifacts.lockedLayer, left: 0, top: 0 }])
    .toFormat(outputFormat === 'jpeg' ? 'jpeg' : outputFormat)
    .toBuffer();

  return writeEditResult(
    normalizedOutput,
    buildEditFileName('ai_extend', request.sourcePath, outputFormat),
    'ai_extend',
    request.targetWidth,
    request.targetHeight,
    MIME_BY_FORMAT[outputFormat],
  );
}

function getEditRelativePath(previewPath: string) {
  const normalized = previewPath.trim().replace(/^\/+/, '');
  if (!normalized.startsWith('studio/edits/')) {
    throw new Error('previewPath must point to studio/edits');
  }
  return normalized.slice('studio/edits/'.length);
}

function joinWorkspacePath(dirPath: string, fileName: string) {
  const cleanDir = dirPath.trim() || '.';
  if (cleanDir === '.' || cleanDir === './') return fileName;
  return `${stripTrailingSlashes(cleanDir)}/${fileName}`;
}

async function keepEditAsStudioOutput(
  input: AspectRatioSaveRequest,
  userId: string,
  editRelativePath: string,
  buffer: Buffer,
): Promise<{ path: string; generationId: string; outputId: string }> {
  await ensureStudioOutputsWorkspace();

  const outputFileName = path.posix.basename(editRelativePath);
  await writeOutputFile(outputFileName, buffer);

  const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
  const now = new Date();
  const generationId = crypto.randomUUID();
  const outputId = crypto.randomUUID();
  const aspectRatio = typeof input.aspectRatio === 'string' && input.aspectRatio.trim()
    ? input.aspectRatio.trim()
    : 'freeform';
  const mode = input.mode === 'ai_extend' ? 'ai_extend' : 'crop';
  const provider = input.provider || 'aspect-ratio';
  const model = typeof input.model === 'string' && input.model.trim()
    ? input.model.trim()
    : mode;
  const outputPath = outputFileName;

  await db.insert(studioGenerations).values({
    id: generationId,
    userId,
    mode: 'image',
    prompt: 'Aspect ratio edit',
    rawPrompt: input.sourcePath || input.previewPath,
    studioPresetId: null,
    aspectRatio,
    provider,
    model,
    bulkJobId: null,
    sourceGenerationId: null,
    metadata: JSON.stringify({
      source: 'studio-aspect-ratio',
      sourcePath: input.sourcePath || null,
      previewPath: input.previewPath,
      editMode: mode,
      expectedCount: 1,
    }),
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(studioGenerationOutputs).values({
    id: outputId,
    generationId,
    variationIndex: 0,
    type: 'image',
    filePath: outputPath,
    fileName: outputFileName,
    mediaUrl: toMediaUrl(outputPath),
    fileSize: buffer.length,
    mimeType: input.previewPath.endsWith('.jpg') || input.previewPath.endsWith('.jpeg')
      ? 'image/jpeg'
      : input.previewPath.endsWith('.webp')
        ? 'image/webp'
        : 'image/png',
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    isFavorite: false,
    metadata: JSON.stringify({
      source: 'studio-aspect-ratio',
      sourcePath: input.sourcePath || null,
      previewPath: input.previewPath,
      editMode: mode,
    }),
    createdAt: now,
  });

  return {
    path: `studio/outputs/${outputPath}`,
    generationId,
    outputId,
  };
}

export async function saveAspectRatioEdit(input: AspectRatioSaveRequest, userId: string): Promise<{ path: string; generationId?: string; outputId?: string }> {
  const editRelativePath = getEditRelativePath(input.previewPath);
  const buffer = await readEditFile(editRelativePath);

  if (input.action === 'keep_edit') {
    return keepEditAsStudioOutput(input, userId, editRelativePath, buffer);
  }

  if (input.action === 'copy_workspace') {
    const targetDirectory = typeof input.targetDirectory === 'string' && input.targetDirectory.trim()
      ? input.targetDirectory.trim()
      : '.';
    const fileName = sanitizeFileName(input.fileName, path.posix.basename(editRelativePath));
    const targetPath = joinWorkspacePath(targetDirectory, fileName);
    await writeFile(targetPath, buffer);
    return { path: targetPath };
  }

  if (input.action === 'overwrite_original') {
    if (!input.confirmOverwrite) {
      throw new Error('Overwrite confirmation is required');
    }
    if (!input.sourcePath || typeof input.sourcePath !== 'string') {
      throw new Error('sourcePath is required for overwrite');
    }
    const ref = classifyMediaReference(input.sourcePath);
    if (!ref?.absolutePath || ref.kind === 'external_url') {
      throw new Error('Only local studio, upload, and workspace images can be overwritten');
    }
    await fs.writeFile(ref.absolutePath, buffer);
    return { path: input.sourcePath };
  }

  throw new Error('Unsupported save action');
}

export async function getAspectRatioEditAbsolutePath(previewPath: string) {
  const relativePath = getEditRelativePath(previewPath);
  return path.join(getStudioEditsRoot(), relativePath);
}

export function getAspectRatioModelOptions() {
  return ['gemini', 'openai'].map((providerId) => {
    const provider = getImageGenerationProvider(providerId);
    if (!provider) return null;
    return {
      id: provider.id,
      name: provider.name,
      models: provider.models,
      aspectRatios: provider.supportedAspectRatios.filter((ratio) => ratio !== 'auto'),
      supportsQuality: provider.supportsQuality,
      supportsOutputFormat: provider.supportsOutputFormat,
      supportsBackground: provider.supportsBackground,
      supportsImageSize: provider.supportsImageSize,
    };
  }).filter(Boolean);
}
