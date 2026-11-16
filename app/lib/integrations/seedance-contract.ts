/** Supported KIE generation contracts. Draft enhancement is a separate model/API contract. */
export const SEEDANCE_CONTRACTS = {
  'bytedance/seedance-2': { maxDuration: 15, images: 9, videos: 3, audios: 3 },
  'bytedance/seedance-2-5': { maxDuration: 30, images: 30, videos: 10, audios: 10 },
} as const;

export type SeedanceModelId = keyof typeof SEEDANCE_CONTRACTS;

export function getSeedanceContract(model: string) {
  if (!Object.prototype.hasOwnProperty.call(SEEDANCE_CONTRACTS, model)) {
    throw new Error(`Unsupported Seedance model: ${model}. Select bytedance/seedance-2 or bytedance/seedance-2-5.`);
  }
  return SEEDANCE_CONTRACTS[model as SeedanceModelId];
}

export interface SeedanceContractInput {
  model: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  firstFrame?: boolean;
  lastFrame?: boolean;
  images?: number;
  videos?: number;
  audios?: number;
  webSearch?: boolean;
  generateAudio?: boolean;
  nsfwChecker?: boolean;
}

export function validateSeedanceContract(input: SeedanceContractInput): void {
  const contract = getSeedanceContract(input.model);
  for (const flag of ['webSearch', 'generateAudio', 'nsfwChecker'] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new Error(`Seedance ${flag} must be a boolean.`);
  }
  const duration = input.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 4 || duration > contract.maxDuration) {
    throw new Error(`Seedance duration must be an integer from 4 to ${contract.maxDuration} seconds. Automatic duration (-1) is not supported by Canvas billing.`);
  }
  if (!['480p', '720p', '1080p'].includes(input.resolution ?? '720p')) {
    throw new Error('Canvas Seedance supports 480p, 720p or 1080p resolution.');
  }
  if (!['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'adaptive'].includes(input.aspectRatio ?? '16:9')) {
    throw new Error('Unsupported Seedance aspect ratio.');
  }
  for (const kind of ['images', 'videos', 'audios'] as const) {
    if ((input[kind] ?? 0) > contract[kind]) {
      throw new Error(`${input.model} accepts at most ${contract[kind]} reference ${kind}.`);
    }
  }
  if (input.lastFrame && !input.firstFrame) {
    throw new Error('Seedance last frame requires a first frame.');
  }
  const hasReferences = (input.images ?? 0) + (input.videos ?? 0) + (input.audios ?? 0) > 0;
  if ((input.firstFrame || input.lastFrame) && hasReferences) {
    throw new Error('Seedance first/last-frame mode cannot be combined with multimodal references.');
  }
  if (input.model === 'bytedance/seedance-2' && input.webSearch && (input.firstFrame || hasReferences)) {
    throw new Error('Seedance 2 web search is supported for text-to-video only.');
  }
}

export function validateSeedanceMedia(model: string, kind: 'image' | 'video' | 'audio', mimeType: string, bytes: number): void {
  getSeedanceContract(model);
  const modern = model === 'bytedance/seedance-2-5';
  const formats = {
    image: ['image/jpeg', 'image/png', 'image/webp', ...(modern ? [] : ['image/bmp', 'image/tiff', 'image/gif'])],
    video: ['video/mp4', 'video/quicktime', ...(modern ? ['video/x-matroska'] : [])],
    audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', ...(modern ? ['audio/aac', 'audio/ogg'] : [])],
  };
  if (!formats[kind].includes(mimeType)) throw new Error(`Unsupported ${model} ${kind} format: ${mimeType}.`);
  const maxBytes = (kind === 'image' ? 30 : kind === 'audio' ? 15 : modern ? 200 : 50) * 1024 * 1024;
  if (bytes <= 0 || bytes > maxBytes || (kind === 'image' && bytes === maxBytes)) {
    throw new Error(`Seedance ${kind} reference is empty or exceeds the ${maxBytes / 1024 / 1024} MB size limit.`);
  }
}
