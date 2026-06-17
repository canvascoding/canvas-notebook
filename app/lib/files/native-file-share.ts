'use client';

export type NativeFileShareResult = 'shared' | 'cancelled' | 'unsupported' | 'failed';

interface ShareFileFromUrlParams {
  url: string;
  fileName: string;
  mimeType?: string | null;
  fallbackMimeType?: string;
  credentials?: RequestCredentials;
}

function isShareCancellation(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function canTryNativeFileShare() {
  return typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function';
}

export async function shareFileFromUrl({
  url,
  fileName,
  mimeType,
  fallbackMimeType = 'application/octet-stream',
  credentials = 'include',
}: ShareFileFromUrlParams): Promise<NativeFileShareResult> {
  if (!canTryNativeFileShare()) return 'unsupported';

  try {
    const response = await fetch(url, { credentials });
    if (!response.ok) throw new Error('Failed to load file for sharing');

    const blob = await response.blob();
    const resolvedMimeType = mimeType || blob.type || fallbackMimeType;
    const file = new File([blob], fileName, { type: resolvedMimeType });
    const shareData: ShareData = { files: [file] };

    if (!navigator.canShare(shareData)) return 'unsupported';

    await navigator.share(shareData);
    return 'shared';
  } catch (error) {
    if (isShareCancellation(error)) return 'cancelled';
    return 'failed';
  }
}
