import 'server-only';

import { desc, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { licenseCerts } from '@/app/lib/db/schema';
import type { LicenseCert } from './types';

export async function loadStoredLicenseCert(instanceId: string): Promise<string | null> {
  const [row] = await db
    .select({ cert: licenseCerts.cert })
    .from(licenseCerts)
    .where(eq(licenseCerts.instanceId, instanceId))
    .orderBy(desc(licenseCerts.updatedAt))
    .limit(1);
  return row?.cert ?? null;
}

export async function saveLicenseCert(cert: string, payload: LicenseCert): Promise<void> {
  const now = new Date();
  await db.insert(licenseCerts).values({
    cert,
    plan: payload.plan,
    instanceId: payload.sub,
    expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
    createdAt: now,
    updatedAt: now,
  });
}
