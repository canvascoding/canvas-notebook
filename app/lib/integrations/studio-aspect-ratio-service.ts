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

async function renderExtendReference(sourceBytes: Buffer, frame: AspectRatioFrame, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  const scale = targetWidth / frame.width;
  const sx = Math.max(frame.x, 0);
  const sy = Math.max(frame.y, 0);
  const ex = Math.min(frame.x + frame.width, sourceWidth);
  const ey = Math.min(frame.y + frame.height, sourceHeight);
  const visibleWidth = Math.max(1, ex - sx);
  const visibleHeight = Math.max(1, ey - sy);
  const left = Math.round((sx - frame.x) * scale);
  const top = Math.round((sy - frame.y) * scale);
  const width = Math.max(1, Math.round(visibleWidth * scale));
  const height = Math.max(1, Math.round(visibleHeight * scale));

  const cropped = await sharp(sourceBytes, { limitInputPixels: false })
    .rotate()
    .extract({
      left: Math.round(sx),
      top: Math.round(sy),
      width: Math.round(visibleWidth),
      height: Math.round(visibleHeight),
    })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer();

  return sharp({
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
}

function buildExtendPrompt(aspectRatio: string) {
  return [
    `Extend this image to the requested ${aspectRatio} composition.`,
    'The provided reference image is already placed on the final canvas.',
    'Transparent empty areas are the only regions that must be generated.',
    'Preserve the original visible image exactly: do not repaint, reinterpret, crop, distort, or replace it.',
    'Only fill the missing outside areas naturally, continuing perspective, lighting, texture, color, depth of field, and scene logic.',
    'Return one complete image with no labels, no guides, no border, no watermark, and no explanation.',
  ].join(' ');
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

  const referenceCanvas = await renderExtendReference(
    sourceBytes,
    request.frame,
    sourceWidth,
    sourceHeight,
    request.targetWidth,
    request.targetHeight,
  );
  const generated = await provider.generate({
    prompt: buildExtendPrompt(request.aspectRatio),
    model,
    aspectRatio: request.aspectRatio,
    referenceImages: [{ imageBytes: referenceCanvas.toString('base64'), mimeType: 'image/png' }],
    quality: request.quality,
    outputFormat,
    background: request.background,
    imageSize: request.imageSize,
    contextPrompt: 'You are performing image outpainting for an aspect-ratio editor. Treat transparent canvas regions as the missing generated areas and keep the original pixels visually unchanged.',
  });

  const generatedBytes = Buffer.from(generated.imageBytes, 'base64');
  const normalizedOutput = await sharp(generatedBytes, { limitInputPixels: false })
    .resize(request.targetWidth, request.targetHeight, { fit: 'cover' })
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
