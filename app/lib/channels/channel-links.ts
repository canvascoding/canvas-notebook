import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { sessionChannelLinks } from '@/app/lib/db/schema';
import { normalizeChannelThreadKey } from './constants';

export type DeliveryPolicy = 'last_active' | 'broadcast' | 'muted';

export type ChannelLinkInput = {
  sessionId: string;
  userId: string;
  channelId: string;
  channelSessionKey: string;
  channelThreadKey?: string | null;
  displayName?: string | null;
  isPrimary?: boolean;
  deliveryPolicy?: DeliveryPolicy;
  inboundAt?: Date | null;
  outboundAt?: Date | null;
};

export async function ensureSessionChannelLink(input: ChannelLinkInput): Promise<void> {
  const now = new Date();
  const channelThreadKey = normalizeChannelThreadKey(input.channelThreadKey);
  const existing = await db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.sessionId, input.sessionId),
      eq(sessionChannelLinks.channelId, input.channelId),
      eq(sessionChannelLinks.channelSessionKey, input.channelSessionKey),
      eq(sessionChannelLinks.channelThreadKey, channelThreadKey),
    ),
    columns: { id: true },
  });

  if (existing) {
    await db.update(sessionChannelLinks)
      .set({
        displayName: input.displayName ?? undefined,
        isPrimary: input.isPrimary ?? undefined,
        deliveryPolicy: input.deliveryPolicy ?? undefined,
        lastInboundAt: input.inboundAt ?? undefined,
        lastOutboundAt: input.outboundAt ?? undefined,
        updatedAt: now,
      })
      .where(eq(sessionChannelLinks.id, existing.id));
    return;
  }

  await db.insert(sessionChannelLinks).values({
    sessionId: input.sessionId,
    userId: input.userId,
    channelId: input.channelId,
    channelSessionKey: input.channelSessionKey,
    channelThreadKey,
    displayName: input.displayName ?? null,
    isPrimary: input.isPrimary ?? false,
    deliveryPolicy: input.deliveryPolicy ?? 'last_active',
    lastInboundAt: input.inboundAt ?? null,
    lastOutboundAt: input.outboundAt ?? null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}

export async function markChannelLinkInbound(input: ChannelLinkInput): Promise<void> {
  await ensureSessionChannelLink({ ...input, inboundAt: input.inboundAt ?? new Date() });
}

export async function markChannelLinkOutbound(input: ChannelLinkInput): Promise<void> {
  await ensureSessionChannelLink({ ...input, outboundAt: input.outboundAt ?? new Date() });
}

export async function listSessionChannelLinks(sessionId: string) {
  return db.query.sessionChannelLinks.findMany({
    where: eq(sessionChannelLinks.sessionId, sessionId),
    orderBy: [desc(sessionChannelLinks.lastInboundAt), desc(sessionChannelLinks.updatedAt)],
  });
}

export async function findLastActiveExternalLink(sessionId: string, webChannelId: string) {
  return db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.sessionId, sessionId),
      ne(sessionChannelLinks.channelId, webChannelId),
      ne(sessionChannelLinks.deliveryPolicy, 'muted'),
    ),
    orderBy: [desc(sessionChannelLinks.lastInboundAt), desc(sessionChannelLinks.updatedAt)],
  });
}
