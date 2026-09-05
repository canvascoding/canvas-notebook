export type MemoryReviewWorkerAvailability = {
  available: boolean;
  reason: 'available' | 'production_build' | 'environment_disabled';
};

/** Resolves the server-wide kill switch without changing a user's preference. */
export function memoryReviewWorkerAvailability(): MemoryReviewWorkerAvailability {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { available: false, reason: 'production_build' };
  }
  if (process.env.CANVAS_MEMORY_REVIEW_WORKER_ENABLED?.trim().toLowerCase() === 'false') {
    return { available: false, reason: 'environment_disabled' };
  }
  return { available: true, reason: 'available' };
}
