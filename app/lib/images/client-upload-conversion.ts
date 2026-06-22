'use client';

import { isHeicUploadFile, isImageUploadFile } from '@/app/lib/images/client-preprocess';

export interface ClientUploadConvertParams {
  format: 'jpg' | 'webp' | 'png';
  quality: number;
  maxDimension?: number;
}

export interface PreparedImageUpload {
  files: File[];
  convertParams?: (ClientUploadConvertParams | null)[];
  clientConvertedCount: number;
  serverFallbackCount: number;
}

export type ClientUploadPreparationStatus =
  | 'queued'
  | 'processing'
  | 'prepared'
  | 'server-fallback'
  | 'error';

export interface ClientUploadPreparationProgress {
  index: number;
  file: File;
  status: ClientUploadPreparationStatus;
  detail?: string;
}

export interface PrepareImageFilesForUploadOptions {
  onProgress?: (progress: ClientUploadPreparationProgress) => void;
}

const MIME_BY_FORMAT: Record<ClientUploadConvertParams['format'], string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const EXT_BY_FORMAT: Record<ClientUploadConvertParams['format'], string> = {
  jpg: '.jpg',
  png: '.png',
  webp: '.webp',
};

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
};

function replaceExtension(filename: string, nextExtension: string): string {
  const slashIndex = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex > slashIndex) {
    return `${filename.slice(0, dotIndex)}${nextExtension}`;
  }
  return `${filename}${nextExtension}`;
}

function getCanvasSize(width: number, height: number, maxDimension?: number): { width: number; height: number } {
  if (!maxDimension || maxDimension <= 0 || (width <= maxDimension && height <= maxDimension)) {
    return { width, height };
  }

  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeBrowserImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  if (typeof document === 'undefined') {
    throw new Error('Browser image conversion is not available');
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image could not be decoded in the browser'));
      img.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Browser image conversion produced no output'));
        }
      },
      mimeType,
      quality / 100,
    );
  });
}

async function convertImageFileInBrowser(
  file: File,
  params: ClientUploadConvertParams,
): Promise<File> {
  if (typeof document === 'undefined') {
    throw new Error('Browser image conversion is not available');
  }

  const decoded = await decodeBrowserImage(file);
  try {
    const size = getCanvasSize(decoded.width, decoded.height, params.maxDimension);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas context is not available');
    }

    if (params.format === 'jpg') {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, size.width, size.height);
    }

    context.drawImage(decoded.source, 0, 0, size.width, size.height);

    const mimeType = MIME_BY_FORMAT[params.format];
    const blob = await canvasToBlob(canvas, mimeType, params.quality);
    return new File([blob], replaceExtension(file.name, EXT_BY_FORMAT[params.format]), {
      type: mimeType,
      lastModified: file.lastModified || Date.now(),
    });
  } finally {
    decoded.close?.();
  }
}

export async function prepareImageFilesForUpload(
  files: File[],
  convertParams?: (ClientUploadConvertParams | null)[],
  options: PrepareImageFilesForUploadOptions = {},
): Promise<PreparedImageUpload> {
  if (!convertParams || convertParams.length !== files.length) {
    return {
      files,
      convertParams,
      clientConvertedCount: 0,
      serverFallbackCount: 0,
    };
  }

  const preparedFiles: File[] = [];
  const preparedParams: (ClientUploadConvertParams | null)[] = [];
  let clientConvertedCount = 0;
  let serverFallbackCount = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const params = convertParams[index] ?? null;

    if (!params || isHeicUploadFile(file) || !isImageUploadFile(file)) {
      preparedFiles.push(file);
      preparedParams.push(params);
      options.onProgress?.({ index, file, status: 'prepared' });
      continue;
    }

    try {
      options.onProgress?.({ index, file, status: 'processing' });
      const converted = await convertImageFileInBrowser(file, params);
      preparedFiles.push(converted);
      preparedParams.push(null);
      clientConvertedCount += 1;
      options.onProgress?.({ index, file: converted, status: 'prepared' });
    } catch (error) {
      console.warn('[ImageUpload] Browser image conversion failed; falling back to server conversion', {
        fileName: file.name,
        error,
      });
      preparedFiles.push(file);
      preparedParams.push(params);
      serverFallbackCount += 1;
      options.onProgress?.({
        index,
        file,
        status: 'server-fallback',
        detail: error instanceof Error ? error.message : 'Browser conversion failed',
      });
    }
  }

  return {
    files: preparedFiles,
    convertParams: preparedParams,
    clientConvertedCount,
    serverFallbackCount,
  };
}

export function serializeUploadConvertParams(
  convertParams?: (ClientUploadConvertParams | null)[],
): string | null {
  if (!convertParams || !convertParams.some(Boolean)) {
    return null;
  }

  return JSON.stringify(convertParams.map((params) => (
    params
      ? {
          format: params.format,
          quality: params.quality,
          maxDimension: params.maxDimension,
        }
      : null
  )));
}
