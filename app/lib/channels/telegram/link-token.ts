import crypto from 'crypto';
import { db } from '@/app/lib/db';
import { channelLinkTokens, channelUserBindings } from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';

const TOKEN_EXPIRY_MS = 15 * 60 * 1000;

export async function generateLinkToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();

  await db.insert(channelLinkTokens).values({
    userId,
    channelId: 'telegram',
    token,
    expiresAt: new Date(now.getTime() + TOKEN_EXPIRY_MS),
    createdAt: now,
  });

  return token;
}

export async function validateLinkToken(token: string): Promise<{ userId: string } | null> {
  const now = new Date();

  const record = await db.query.channelLinkTokens.findFirst({
    where: and(
      eq(channelLinkTokens.token, token),
    ),
  });

  if (!record) {
    return null;
  }

  if (record.usedAt) {
    return null;
  }

  if (record.expiresAt.getTime() < now.getTime()) {
    return null;
  }

  await db.update(channelLinkTokens)
    .set({ usedAt: now })
    .where(eq(channelLinkTokens.id, record.id));

  return { userId: record.userId };
}

export async function createBinding(userId: string, channelId: string, channelUserId: string, channelUserName?: string): Promise<void> {
  const existing = await db.query.channelUserBindings.findFirst({
    where: and(
      eq(channelUserBindings.channelId, channelId),
      eq(channelUserBindings.channelUserId, channelUserId),
    ),
  });

  if (existing) {
    await db.update(channelUserBindings)
      .set({ userId, channelUserName: channelUserName ?? null, createdAt: new Date() })
      .where(eq(channelUserBindings.id, existing.id));
    return;
  }

  await db.insert(channelUserBindings).values({
    userId,
    channelId,
    channelUserId,
    channelUserName: channelUserName ?? null,
    createdAt: new Date(),
  });
}

export async function getBinding(channelId: string, channelUserId: string): Promise<{ userId: string; channelUserName: string | null } | null> {
  const record = await db.query.channelUserBindings.findFirst({
    where: and(
      eq(channelUserBindings.channelId, channelId),
      eq(channelUserBindings.channelUserId, channelUserId),
    ),
  });

  if (!record) return null;
  return { userId: record.userId, channelUserName: record.channelUserName };
}

export async function deleteBinding(userId: string, channelId: string): Promise<void> {
  await db.delete(channelUserBindings)
    .where(and(
      eq(channelUserBindings.userId, userId),
      eq(channelUserBindings.channelId, channelId),
    ));
}