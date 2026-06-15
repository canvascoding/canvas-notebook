export const MIGRATION_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

export function getMigrationUploadTotalParts(fileSize: number): number {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return 1;
  return Math.max(1, Math.ceil(fileSize / MIGRATION_UPLOAD_CHUNK_SIZE));
}

export function getMigrationUploadPartRange(
  fileSize: number,
  partIndex: number,
): { start: number; end: number; size: number } {
  const start = partIndex * MIGRATION_UPLOAD_CHUNK_SIZE;
  const end = Math.min(fileSize, start + MIGRATION_UPLOAD_CHUNK_SIZE);
  return {
    start,
    end,
    size: Math.max(0, end - start),
  };
}
