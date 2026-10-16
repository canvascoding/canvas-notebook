import type { StudioGenerationOutput } from '../types/generation';

export function hasStudioOutputMedia(output: Pick<StudioGenerationOutput, 'filePath' | 'mediaUrl'>) {
  return Boolean(output.filePath || output.mediaUrl);
}
