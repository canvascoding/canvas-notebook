const APP_ROOT_FOLDER_PATHS = {
  veoStudio: 'veo-studio',
  imageGeneration: 'image-generation',
  nanoBananaAdLocalizer: 'nano-banana-ad-localizer',
  studioOutputs: 'studio-outputs',
} as const;

const APP_OUTPUT_FOLDER_PATHS = {
  veoVideoGeneration: 'veo-studio/video-generation',
  imageGenerations: 'image-generation/generations',
  nanoBananaLocalizations: 'nano-banana-ad-localizer/localizations',
  studioGenerationOutputs: 'studio-outputs',
} as const;

export type AppOutputFolderKind =
  | 'veo-video-generation'
  | 'image-generations'
  | 'nano-banana-localizations'
  | 'studio-outputs';

const APP_OUTPUT_FOLDER_BY_PATH: Record<string, AppOutputFolderKind> = {
  [APP_ROOT_FOLDER_PATHS.veoStudio]: 'veo-video-generation',
  [APP_ROOT_FOLDER_PATHS.imageGeneration]: 'image-generations',
  [APP_ROOT_FOLDER_PATHS.nanoBananaAdLocalizer]: 'nano-banana-localizations',
  [APP_ROOT_FOLDER_PATHS.studioOutputs]: 'studio-outputs',
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

// Protected app folders include both app roots and fixed output directories.
export function isProtectedAppOutputFolder(inputPath: string): boolean {
  return getAppOutputFolderKind(inputPath) !== null;
}
