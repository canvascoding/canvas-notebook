import { db } from '@/app/lib/db';
import { onboardingLog } from '@/app/lib/db/schema';

export function isOnboardingEnabled(): boolean {
  return process.env.ONBOARDING === 'true';
}

export async function isOnboardingComplete(): Promise<boolean> {
  try {
    const row = await db.select().from(onboardingLog).limit(1);
    return row.length > 0;
  } catch {
    return false; // fail-open: show wizard if DB not ready yet
  }
}

export async function markOnboardingComplete(opts: {
  completedBy?: string;
  method: 'ui' | 'bootstrap';
  notes?: string;
}): Promise<void> {
  const now = new Date();
  await db.insert(onboardingLog).values({
    completedAt: now,
    completedBy: opts.completedBy ?? null,
    method: opts.method,
    notes: opts.notes ?? null,
    createdAt: now,
  });
}
