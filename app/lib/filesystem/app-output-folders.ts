const APP_OUTPUT_FOLDER_PATHS = {
  veoVideoGeneration: 'veo-studio/video-generation',
  imageGenerations: 'image-generation/generations',
  nanoBananaLocalizations: 'nano-banana-ad-localizer/localizations',
} as const;

export type AppOutputFolderKind =
  | 'veo-video-generation'
  | 'image-generations'
  | 'nano-banana-localizations';

const APP_OUTPUT_FOLDER_BY_PATH: Record<string, AppOutputFolderKind> = {
  [APP_OUTPUT_FOLDER_PATHS.veoVideoGeneration]: 'veo-video-generation',
  [APP_OUTPUT_FOLDER_PATHS.imageGenerations]: 'image-generations',
  [APP_OUTPUT_FOLDER_PATHS.nanoBananaLocalizations]: 'nano-banana-localizations',
};

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

export function isProtectedAppOutputFolder(inputPath: string): boolean {
  return getAppOutputFolderKind(inputPath) !== null;
}

