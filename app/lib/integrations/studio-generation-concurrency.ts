import { AsyncSemaphore } from '@/app/lib/utils/async-semaphore';

export type StudioGenerationMediaType = 'image' | 'video' | 'sound';

const DEFAULT_IMAGE_GENERATION_CONCURRENCY = 5;
const DEFAULT_VIDEO_GENERATION_CONCURRENCY = 2;
const DEFAULT_SOUND_GENERATION_CONCURRENCY = 1;

type StudioGenerationConcurrencyStore = {
  image: { limit: number; semaphore: AsyncSemaphore } | null;
  video: { limit: number; semaphore: AsyncSemaphore } | null;
  sound: { limit: number; semaphore: AsyncSemaphore } | null;
};

const globalConcurrencyStore = globalThis as typeof globalThis & {
  __canvasStudioGenerationConcurrency?: StudioGenerationConcurrencyStore;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getStudioGenerationConcurrencyLimit(mediaType: StudioGenerationMediaType): number {
  if (mediaType === 'image') {
    return parsePositiveInteger(process.env.STUDIO_IMAGE_GENERATION_CONCURRENCY, DEFAULT_IMAGE_GENERATION_CONCURRENCY);
  }
  if (mediaType === 'video') {
    return parsePositiveInteger(process.env.STUDIO_VIDEO_GENERATION_CONCURRENCY, DEFAULT_VIDEO_GENERATION_CONCURRENCY);
  }
  return parsePositiveInteger(process.env.STUDIO_SOUND_GENERATION_CONCURRENCY, DEFAULT_SOUND_GENERATION_CONCURRENCY);
}

function getConcurrencyStore(): StudioGenerationConcurrencyStore {
  if (!globalConcurrencyStore.__canvasStudioGenerationConcurrency) {
    globalConcurrencyStore.__canvasStudioGenerationConcurrency = { image: null, video: null, sound: null };
  }
  return globalConcurrencyStore.__canvasStudioGenerationConcurrency;
}

function getSemaphore(mediaType: StudioGenerationMediaType): AsyncSemaphore {
  const store = getConcurrencyStore();
  const limit = getStudioGenerationConcurrencyLimit(mediaType);
  const current = store[mediaType];
  if (current?.limit === limit) return current.semaphore;

  const next = { limit, semaphore: new AsyncSemaphore(limit) };
  store[mediaType] = next;
  return next.semaphore;
}

/**
 * Shares Studio provider capacity across UI requests, bulk jobs, users, and agent runtimes.
 * The store lives on globalThis so Next.js module reloads do not create competing limiters.
 */
export async function withStudioGenerationConcurrency<T>(
  mediaType: StudioGenerationMediaType,
  operation: () => Promise<T>,
): Promise<T> {
  return getSemaphore(mediaType).run(operation);
}
