import { eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';

export async function ensureUserExists(userId: string, userData?: { name?: string; email?: string; image?: string; role?: string }): Promise<void> {
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  if (existing.length > 0) return;

  const now = new Date();
  await db.insert(user).values({
    id: userId,
    name: userData?.name ?? 'User',
    email: userData?.email ?? `${userId}@placeholder`,
    emailVerified: false,
    image: userData?.image ?? null,
    role: userData?.role ?? null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}