export type AppOutputFolderKind = never;

const APP_OUTPUT_FOLDER_BY_PATH: Record<string, AppOutputFolderKind> = {};

function normalizeRelativePath(inputPath: string): string {
  const normalized = inputPath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');

  return normalized === '.' ? '' : normalized;
}

export function getAppOutputFolderKind(inputPath: string): AppOutputFolderKind | null {
  const normalized = normalizeRelativePath(inputPath);
  return APP_OUTPUT_FOLDER_BY_PATH[normalized] || null;
}

// Protected app folders include both app roots and fixed output directories.
export function isProtectedAppOutputFolder(inputPath: string): boolean {
  return getAppOutputFolderKind(inputPath) !== null;
}
