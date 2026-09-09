const pending = new Map<string, Promise<Buffer>>();

/** Share only concurrent identical renders; no stale result survives the job. */
export async function coalescePublicExport(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
  const existing = pending.get(key);
  if (existing) return existing;
  // The renderer's bounded queue still controls admission if all keys differ.
  if (pending.size >= 16) return render();
  const job = Promise.resolve().then(render);
  pending.set(key, job);
  try {
    return await job;
  } finally {
    if (pending.get(key) === job) pending.delete(key);
  }
}
