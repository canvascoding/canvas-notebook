import 'server-only';

import { and, count, inArray, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { studioGenerations } from '@/app/lib/db/schema';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { runStudioGeneration } from '@/app/lib/integrations/studio-generation-service';

const DEFAULT_STUDIO_GENERATION_QUEUE_LIMIT = 8;

interface QueuedStudioGeneration {
  generationId: string;
}

type StudioGenerationQueueStore = {
  queue: QueuedStudioGeneration[];
  queuedGenerationIds: Set<string>;
  activeGenerationIds: Set<string>;
  draining: boolean;
};

const globalQueueStore = globalThis as typeof globalThis & {
  __canvasStudioGenerationQueue?: StudioGenerationQueueStore;
};

function getQueueStore(): StudioGenerationQueueStore {
  if (!globalQueueStore.__canvasStudioGenerationQueue) {
    globalQueueStore.__canvasStudioGenerationQueue = {
      queue: [],
      queuedGenerationIds: new Set(),
      activeGenerationIds: new Set(),
      draining: false,
    };
  }
  return globalQueueStore.__canvasStudioGenerationQueue;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getStudioGenerationQueueLimit(): number {
  return parsePositiveInteger(process.env.STUDIO_GENERATION_QUEUE_LIMIT, DEFAULT_STUDIO_GENERATION_QUEUE_LIMIT);
}

export async function assertStudioGenerationQueueCapacity(userId: string): Promise<void> {
  const limit = getStudioGenerationQueueLimit();
  const result = await db.select({ count: count() })
    .from(studioGenerations)
    .where(and(
      eq(studioGenerations.userId, userId),
      inArray(studioGenerations.status, ['pending', 'generating']),
    ));

  const activeCount = result[0]?.count ?? 0;
  if (activeCount >= limit) {
    throw new StudioServiceError(
      'Studio generation queue limit reached',
      `You already have ${activeCount} active Studio generation${activeCount === 1 ? '' : 's'}. Please wait for at least one to complete before starting a new one. Limit: ${limit}.`,
      'RATE_LIMIT',
    );
  }
}

export function enqueueStudioGeneration(generationId: string): { queuePosition: number; queueLength: number } {
  const store = getQueueStore();
  if (store.queuedGenerationIds.has(generationId) || store.activeGenerationIds.has(generationId)) {
    const existingIndex = store.queue.findIndex((item) => item.generationId === generationId);
    return {
      queuePosition: existingIndex >= 0 ? existingIndex + 1 : 0,
      queueLength: store.queue.length + store.activeGenerationIds.size,
    };
  }

  store.queuedGenerationIds.add(generationId);
  store.queue.push({ generationId });
  const queuePosition = store.activeGenerationIds.size + store.queue.length;
  const queueLength = queuePosition;
  void drainStudioGenerationQueue();

  return {
    queuePosition,
    queueLength,
  };
}

async function drainStudioGenerationQueue(): Promise<void> {
  const store = getQueueStore();
  if (store.draining) return;
  store.draining = true;

  try {
    while (store.queue.length > 0) {
      const job = store.queue.shift();
      if (!job) continue;
      store.queuedGenerationIds.delete(job.generationId);
      store.activeGenerationIds.add(job.generationId);

      void runStudioGeneration(job.generationId)
        .catch((error) => {
          console.error(`[Studio Generation Queue] Job failed: id=${job.generationId}`, error);
        })
        .finally(() => {
          store.activeGenerationIds.delete(job.generationId);
          void drainStudioGenerationQueue();
        });
    }
  } finally {
    store.draining = false;
    if (store.queue.length > 0) {
      void drainStudioGenerationQueue();
    }
  }
}
