'use client';

import type { StudioGenerationOutput } from '../types/generation';
import { shareFileFromUrl } from '@/app/lib/files/native-file-share';

function getDownloadFilename(response: Response, fallback: string): string {
  const header = response.headers.get('Content-Disposition');
  if (!header) return fallback;

  const encodedMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }

  return header.match(/filename="?([^";]+)"?/)?.[1] ?? fallback;
}

function getOutputFileName(output: Pick<StudioGenerationOutput, 'fileName' | 'filePath'>, fallback: string) {
  return output.fileName || output.filePath.split('/').pop() || fallback;
}

function canTryNativeFileShare(output: Pick<StudioGenerationOutput, 'type' | 'mediaUrl' | 'mimeType'>) {
  if (output.type !== 'image' || !output.mediaUrl) return false;
  if (output.mimeType && !output.mimeType.startsWith('image/')) return false;
  return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && typeof navigator.share === 'function';
}

async function shareStudioImageOutput(output: StudioGenerationOutput): Promise<'shared' | 'cancelled' | 'unsupported' | 'failed'> {
  if (!canTryNativeFileShare(output)) return 'unsupported';
  return shareFileFromUrl({
    url: output.mediaUrl!,
    fileName: getOutputFileName(output, 'studio-output.png'),
    mimeType: output.mimeType,
    fallbackMimeType: 'image/png',
  });
}

export async function downloadStudioOutputs(outputIds: string[]): Promise<boolean> {
  if (outputIds.length === 0) return false;

  try {
    const response = await fetch('/api/studio/outputs/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputIds }),
    });

    if (!response.ok) {
      throw new Error('Download failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const filename = getDownloadFilename(response, outputIds.length === 1 ? 'studio-output' : 'studio-outputs.zip');

    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    return true;
  } catch {
    return false;
  }
}

export function downloadStudioOutput(outputId: string): Promise<boolean> {
  return downloadStudioOutputs([outputId]);
}

export async function shareOrDownloadStudioOutput(output: StudioGenerationOutput): Promise<boolean> {
  const shareResult = await shareStudioImageOutput(output);
  if (shareResult === 'shared' || shareResult === 'cancelled') return true;

  return downloadStudioOutput(output.id);
}
