import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { deleteToolOutputs, listToolOutputSessionsForOwner, type ToolOutputIdentity } from './tool-output-store';

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const lastSweeps = new Map<string, number>();

async function isSessionPersisted(identity: ToolOutputIdentity): Promise<boolean> {
  const rows = await db.select({ id: piSessions.id }).from(piSessions).where(and(
    eq(piSessions.userId, identity.userId),
    eq(piSessions.sessionId, identity.sessionId),
    identity.organizationId === null ? isNull(piSessions.organizationId) : eq(piSessions.organizationId, identity.organizationId),
  )).limit(1);
  return rows.length > 0;
}

/** Never infer an orphan from a failed database read; errors leave files intact. */
export async function cleanupToolOutputOrphans(
  activeIdentity: ToolOutputIdentity,
  options: { now?: number; isPersisted?: (identity: ToolOutputIdentity) => Promise<boolean> } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const isPersisted = options.isPersisted ?? isSessionPersisted;
  let removed = 0;
  for (const candidate of await listToolOutputSessionsForOwner(activeIdentity)) {
    if (candidate.identity.sessionId === activeIdentity.sessionId || now - candidate.modifiedAt < ORPHAN_GRACE_MS) continue;
    if (await isPersisted(candidate.identity)) continue;
    await deleteToolOutputs(candidate.identity);
    removed += 1;
  }
  return removed;
}

/** Called at the shared tool boundary; only counts are logged, never content. */
export async function maybeCleanupToolOutputOrphans(identity: ToolOutputIdentity): Promise<void> {
  const key = JSON.stringify([identity.organizationId, identity.userId]);
  const now = Date.now();
  if (now - (lastSweeps.get(key) ?? 0) < SWEEP_INTERVAL_MS) return;
  lastSweeps.set(key, now);
  // Bound the process-local throttle in hosts serving many separate workspaces.
  if (lastSweeps.size > 1_000) {
    for (const [owner, timestamp] of lastSweeps) if (now - timestamp >= SWEEP_INTERVAL_MS) lastSweeps.delete(owner);
    if (lastSweeps.size > 1_000) lastSweeps.delete(lastSweeps.keys().next().value!);
  }
  try {
    const removed = await cleanupToolOutputOrphans(identity);
    if (removed > 0) console.info('[ToolOutput] orphan_cleanup', { removed });
  } catch {
    console.warn('[ToolOutput] orphan_cleanup_deferred');
  }
}
