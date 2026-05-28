'use client';

function getDownloadFilename(response: Response, fallback: string): string {
  return response.headers.get('Content-Disposition')?.match(/filename="?([^"]+)"?/)?.[1] ?? fallback;
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
