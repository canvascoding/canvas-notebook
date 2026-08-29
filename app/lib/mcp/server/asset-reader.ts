import 'server-only';

import path from 'node:path';

import {
  extractPdfTextForRead,
  imageContentForBuffer,
} from '@/app/lib/pi/tool-runtime-helpers';

export const DIRECT_MCP_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const DIRECT_MCP_ASSET_DEFAULT_MAX_CHARACTERS = 24_000;
export const DIRECT_MCP_ASSET_MAX_CHARACTERS = 24_000;
export const DIRECT_MCP_ASSET_DEFAULT_MAX_PDF_TEXT_PAGES = 20;
export const DIRECT_MCP_ASSET_MAX_PDF_TEXT_PAGES = 40;
export const DIRECT_MCP_ASSET_DEFAULT_MAX_PDF_IMAGES = 2;
export const DIRECT_MCP_ASSET_MAX_PDF_IMAGES = 5;

type DirectMcpAssetContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

type DirectMcpAssetImage = {
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

type DirectMcpAssetPdf = {
  type: 'pdf';
  mimeType: 'application/pdf';
};

export type DirectMcpAssetKind = DirectMcpAssetImage | DirectMcpAssetPdf;

export type DirectMcpAssetReadOptions = {
  maxCharacters: number;
  maxPdfTextPages: number;
  pdfTextPages?: number[];
  includePdfImages?: boolean;
  pdfImagePages?: number[];
  maxPdfImages: number;
};

export type DirectMcpAssetReadResult = {
  kind: DirectMcpAssetKind;
  content: DirectMcpAssetContent[];
  pages?: number;
  textPagesRead?: number[];
  textPageLimited?: boolean;
  truncated?: boolean;
  images?: Array<{ pageNumber: number; bytes: number; width: number; height: number }>;
  skippedImageCount?: number;
};

export class DirectMcpAssetReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectMcpAssetReadError';
  }
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
}

function isPng(buffer: Buffer): boolean {
  return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function isJpeg(buffer: Buffer): boolean {
  return startsWith(buffer, [0xff, 0xd8, 0xff]);
}

function isGif(buffer: Buffer): boolean {
  return buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
    || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function identifyDirectMcpAsset(filePath: string, buffer: Buffer): DirectMcpAssetKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png' && isPng(buffer)) return { type: 'image', mimeType: 'image/png' };
  if ((extension === '.jpg' || extension === '.jpeg') && isJpeg(buffer)) {
    return { type: 'image', mimeType: 'image/jpeg' };
  }
  if (extension === '.gif' && isGif(buffer)) return { type: 'image', mimeType: 'image/gif' };
  if (extension === '.webp' && isWebp(buffer)) return { type: 'image', mimeType: 'image/webp' };
  if (extension === '.pdf' && isPdf(buffer)) return { type: 'pdf', mimeType: 'application/pdf' };

  if (extension === '.pdf') {
    throw new DirectMcpAssetReadError('The requested PDF does not have a valid PDF signature.');
  }
  throw new DirectMcpAssetReadError(
    'Only PNG, JPEG, GIF, WebP images, and PDF documents can be read as MCP assets.',
  );
}

export async function readDirectMcpAsset(input: {
  path: string;
  buffer: Buffer;
  options: DirectMcpAssetReadOptions;
}): Promise<DirectMcpAssetReadResult> {
  if (input.buffer.length > DIRECT_MCP_ASSET_MAX_BYTES) {
    throw new DirectMcpAssetReadError(
      `The requested asset is larger than the ${DIRECT_MCP_ASSET_MAX_BYTES / (1024 * 1024)} MB MCP asset limit.`,
    );
  }

  const kind = identifyDirectMcpAsset(input.path, input.buffer);
  if (kind.type === 'image') {
    try {
      const image = await imageContentForBuffer(input.path, input.buffer);
      if (!image) {
        throw new Error('No image content was produced.');
      }
      return {
        kind,
        content: [
          { type: 'text', text: 'Image content is included for visual analysis.' },
          { type: 'image', data: image.data, mimeType: image.mimeType },
        ],
      };
    } catch {
      throw new DirectMcpAssetReadError('The requested image could not be prepared for MCP visual context.');
    }
  }

  try {
    const pdf = await extractPdfTextForRead(input.path, input.buffer, {
      maxChars: input.options.maxCharacters,
      maxTextPages: input.options.maxPdfTextPages,
      textPages: input.options.pdfTextPages,
      includeImages: input.options.includePdfImages,
      includeImagesExplicit: typeof input.options.includePdfImages === 'boolean',
      imagePages: input.options.pdfImagePages,
      maxImages: input.options.maxPdfImages,
    });
    const content: DirectMcpAssetContent[] = pdf.content.map((part) => (
      part.type === 'image'
        ? { type: 'image', data: part.data, mimeType: part.mimeType }
        : { type: 'text', text: part.text }
    ));
    return {
      kind,
      content,
      pages: pdf.details.pages,
      textPagesRead: pdf.details.textPagesRead,
      textPageLimited: pdf.details.textPageLimited,
      truncated: pdf.details.truncated,
      images: pdf.details.images,
      skippedImageCount: pdf.details.skippedImages.length,
    };
  } catch (error) {
    if (error instanceof DirectMcpAssetReadError) throw error;
    throw new DirectMcpAssetReadError('The requested PDF could not be parsed safely.');
  }
}
