import { NextRequest, NextResponse } from 'next/server';
import { and, asc, desc, eq } from 'drizzle-orm';

import { auth } from '@/app/lib/auth';
import { isAdminUser } from '@/app/lib/admin-auth';
import { db } from '@/app/lib/db';
import { channelUserBindings, user as usersTable } from '@/app/lib/db/schema';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const TELEGRAM_CHANNEL_ID = 'telegram';
const TELEGRAM_USER_ID_PATTERN = /^\d{1,20}$/;
const MAX_TELEGRAM_USER_NAME_LENGTH = 128;

type TelegramBindingMetadata = {
  chatId?: string;
  telegramFirstName?: string;
  telegramLastName?: string;
  linkedVia?: string;
  linkedAt?: string;
  lastSeenAt?: string;
};

function parseMetadata(value: string | null): TelegramBindingMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as TelegramBindingMetadata : null;
  } catch {
    return null;
  }
}

function normalizeRequiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTelegramUserName(value: unknown): string | null {
  const normalized = normalizeRequiredString(value).replace(/^@+/, '');
  return normalized ? normalized.slice(0, MAX_TELEGRAM_USER_NAME_LENGTH) : null;
}

function forbidden() {
  return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
}

async function requireAdminSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!isAdminUser(session.user)) {
    return { response: forbidden() };
  }
  return { session };
}

export async function GET(request: NextRequest) {
  const authResult = await requireAdminSession(request);
  if ('response' in authResult) return authResult.response;

  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'telegram-bindings-get' });
  if (!limited.ok) return limited.response;

  try {
    const [bindings, users] = await Promise.all([
      db
        .select({
          id: channelUserBindings.id,
          userId: channelUserBindings.userId,
          telegramUserId: channelUserBindings.channelUserId,
          telegramUserName: channelUserBindings.channelUserName,
          metadataJson: channelUserBindings.metadataJson,
          enabled: channelUserBindings.enabled,
          createdAt: channelUserBindings.createdAt,
          userName: usersTable.name,
          userEmail: usersTable.email,
        })
        .from(channelUserBindings)
        .leftJoin(usersTable, eq(channelUserBindings.userId, usersTable.id))
        .where(eq(channelUserBindings.channelId, TELEGRAM_CHANNEL_ID))
        .orderBy(desc(channelUserBindings.createdAt)),
      db
        .select({
          id: usersTable.id,
          name: usersTable.name,
          email: usersTable.email,
          role: usersTable.role,
        })
        .from(usersTable)
        .orderBy(asc(usersTable.email))
        .limit(200),
    ]);

    return NextResponse.json({
      success: true,
      bindings: bindings.map((binding) => ({
        id: binding.id,
        userId: binding.userId,
        userName: binding.userName,
        userEmail: binding.userEmail,
        telegramUserId: binding.telegramUserId,
        telegramUserName: binding.telegramUserName,
        metadata: parseMetadata(binding.metadataJson),
        enabled: binding.enabled,
        createdAt: binding.createdAt,
      })),
      users,
    });
  } catch (error) {
    console.error('[API] channels/telegram/bindings GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load Telegram bindings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireAdminSession(request);
  if ('response' in authResult) return authResult.response;

  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'telegram-bindings-post' });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const telegramUserId = normalizeRequiredString(body?.telegramUserId);
    const userId = normalizeRequiredString(body?.userId);
    const telegramUserName = normalizeTelegramUserName(body?.telegramUserName);

    if (!TELEGRAM_USER_ID_PATTERN.test(telegramUserId)) {
      return NextResponse.json({ success: false, error: 'Telegram user ID is invalid' }, { status: 400 });
    }
    if (!userId) {
      return NextResponse.json({ success: false, error: 'User is required' }, { status: 400 });
    }

    const targetUser = await db.query.user.findFirst({
      where: eq(usersTable.id, userId),
      columns: { id: true },
    });
    if (!targetUser) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    const existing = await db.query.channelUserBindings.findFirst({
      where: and(
        eq(channelUserBindings.channelId, TELEGRAM_CHANNEL_ID),
        eq(channelUserBindings.channelUserId, telegramUserId),
      ),
    });

    if (existing && existing.userId !== userId) {
      return NextResponse.json({
        success: false,
        error: 'Telegram user ID is already linked to another user',
      }, { status: 409 });
    }

    const now = new Date();
    const nextMetadata = {
      ...(parseMetadata(existing?.metadataJson ?? null) ?? {}),
      linkedVia: 'admin_settings',
      linkedAt: now.toISOString(),
    };

    if (existing) {
      await db.update(channelUserBindings)
        .set({
          channelUserName: telegramUserName,
          metadataJson: JSON.stringify(nextMetadata),
          enabled: true,
          createdAt: now,
        })
        .where(eq(channelUserBindings.id, existing.id));
    } else {
      await db.insert(channelUserBindings).values({
        userId,
        channelId: TELEGRAM_CHANNEL_ID,
        channelUserId: telegramUserId,
        channelUserName: telegramUserName,
        metadataJson: JSON.stringify(nextMetadata),
        enabled: true,
        createdAt: now,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] channels/telegram/bindings POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to save Telegram binding' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const authResult = await requireAdminSession(request);
  if ('response' in authResult) return authResult.response;

  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'telegram-bindings-delete' });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const id = typeof body?.id === 'number' && Number.isInteger(body.id) ? body.id : null;
    if (!id || id <= 0) {
      return NextResponse.json({ success: false, error: 'Binding ID is required' }, { status: 400 });
    }

    const deleted = await db.delete(channelUserBindings)
      .where(and(
        eq(channelUserBindings.id, id),
        eq(channelUserBindings.channelId, TELEGRAM_CHANNEL_ID),
      ))
      .returning({ id: channelUserBindings.id });

    if (deleted.length === 0) {
      return NextResponse.json({ success: false, error: 'Binding not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] channels/telegram/bindings DELETE error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete Telegram binding' }, { status: 500 });
  }
}
