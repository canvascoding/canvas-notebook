export const WORKSPACE_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
export const WORKSPACE_UPLOAD_MAX_FILES = 1_000;
export const WORKSPACE_UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const WORKSPACE_UPLOAD_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
export const WORKSPACE_UPLOAD_MAX_RETRIES = 3;

export function assertUploadSelectionWithinLimits(files: Array<{ name: string; size: number }>): void {
  if (files.length > WORKSPACE_UPLOAD_MAX_FILES) throw new Error(`Select at most ${WORKSPACE_UPLOAD_MAX_FILES} files per upload.`);
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > WORKSPACE_UPLOAD_MAX_FILE_BYTES) throw new Error(`File "${file.name}" exceeds the ${formatUploadBytes(WORKSPACE_UPLOAD_MAX_FILE_BYTES)} limit.`);
    totalBytes += file.size;
  }
  if (totalBytes > WORKSPACE_UPLOAD_MAX_TOTAL_BYTES) throw new Error(`The selected files exceed the ${formatUploadBytes(WORKSPACE_UPLOAD_MAX_TOTAL_BYTES)} upload limit.`);
}

export function getWorkspaceUploadChunkRange(
  fileSize: number,
  offset: number,
): { start: number; end: number; size: number } {
  const start = Math.max(0, Math.trunc(offset));
  const end = Math.min(fileSize, start + WORKSPACE_UPLOAD_CHUNK_SIZE);
  return {
    start,
    end,
    size: Math.max(0, end - start),
  };
}

export function formatUploadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value < 10 && unitIndex > 0 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}
