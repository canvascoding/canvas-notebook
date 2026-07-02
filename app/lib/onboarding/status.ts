import { eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { onboardingLog } from '@/app/lib/db/schema';

export type OnboardingCompletionStatus = {
  complete: boolean;
  source: 'database' | 'fallback';
  error?: unknown;
};

export function isOnboardingEnabled(): boolean {
  return process.env.ONBOARDING?.trim().toLowerCase() !== 'false';
}

export function isOnboardingHintsEnabled(): boolean {
  return process.env.ONBOARDING_HINTS?.trim().toLowerCase() === 'true';
}

export async function readIsOnboardingComplete(): Promise<boolean> {
  const row = await db.select({ method: onboardingLog.method }).from(onboardingLog).where(eq(onboardingLog.method, 'ui')).limit(1);
  return row.length > 0;
}

export async function getOnboardingCompletionStatus(logPrefix = '[onboarding/status]'): Promise<OnboardingCompletionStatus> {
  try {
    return {
      complete: await readIsOnboardingComplete(),
      source: 'database',
    };
  } catch (error) {
    console.warn(`${logPrefix} Failed to read onboarding completion status; treating onboarding as incomplete.`, error);
    return {
      complete: false,
      source: 'fallback',
      error,
    };
  }
}

export async function isOnboardingComplete(): Promise<boolean> {
  return (await getOnboardingCompletionStatus()).complete; // fail-open: show wizard if DB not ready yet
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
