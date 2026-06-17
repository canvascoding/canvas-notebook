'use client';

import { shareFileFromUrl, type NativeFileShareResult } from './native-file-share';

const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function getFileExtension(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

export function isWorkspaceImageFileName(fileName: string) {
  return getFileExtension(fileName) in IMAGE_MIME_TYPES;
}

export function getWorkspaceImageMimeType(fileName: string) {
  return IMAGE_MIME_TYPES[getFileExtension(fileName)] || 'image/png';
}

export function shareWorkspaceImageFile(params: {
  path: string;
  fileName: string;
}): Promise<NativeFileShareResult> {
  return shareFileFromUrl({
    url: `/api/files/download?path=${encodeURIComponent(params.path)}`,
    fileName: params.fileName,
    mimeType: getWorkspaceImageMimeType(params.fileName),
    fallbackMimeType: 'image/png',
  });
}
