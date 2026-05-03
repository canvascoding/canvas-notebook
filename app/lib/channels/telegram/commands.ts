import type { Bot, Context } from 'grammy';
import { control, getStatus } from '@/app/lib/pi/runtime-service';
import { getBinding, validateLinkToken, createBinding } from './link-token';
import { createTelegramSession, resolveTelegramSession, switchTelegramSession, listTelegramSessions } from './session-resolver';

const COMMANDS_LIST = [
  '/new — Neue Session erstellen',
  '/stop — Aktuellen Agent-Lauf abbrechen',
  '/compact — Context komprimieren',
  '/sessions — Sessions auflisten',
  '/switch ID — Zu einer Session wechseln',
  '/status — Aktuelle Session und Agent-Status',
];

export function registerCommands(bot: Bot): void {
  bot.command('start', handleStartCommand);
  bot.command('new', handleNewCommand);
  bot.command('stop', handleStopCommand);
  bot.command('compact', handleCompactCommand);
  bot.command('sessions', handleSessionsCommand);
  bot.command('switch', handleSwitchCommand);
  bot.command('status', handleStatusCommand);
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

async function rejectNonPrivateChat(ctx: Context): Promise<boolean> {
  if (isPrivateChat(ctx)) return false;
  await ctx.reply('Telegram ist nur in direkten Chats mit dem Bot verfügbar.');
  return true;
}

async function replyCommandError(ctx: Context, error: unknown): Promise<void> {
  console.error('[Telegram Commands] Command failed:', error);
  await ctx.reply(`Fehler bei der Verarbeitung: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`);
}

async function handleStartCommand(ctx: Context): Promise<void> {
  try {
    if (await rejectNonPrivateChat(ctx)) return;

    const chatId = String(ctx.chat?.id);
    const token = typeof ctx.match === 'string' ? ctx.match.trim() : ctx.match?.[0]?.trim();

    if (!token) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account. Öffne in der App: Settings → Channels → Telegram → Verknüpfen.');
      return;
    }

    const result = await validateLinkToken(token);
    if (!result) {
      await ctx.reply('Ungültiger oder abgelaufener Token. Bitte generiere einen neuen in den App-Settings.');
      return;
    }

    const userName = ctx.from?.username ?? ctx.from?.first_name ?? undefined;
    await createBinding(result.userId, 'telegram', chatId, userName);

    const sessionId = await resolveTelegramSession(chatId, result.userId);
    await ctx.reply(`Willkommen! Dein Account ist jetzt verknüpft. Session: ${sessionId.slice(0, 12)}…\n\nVerfügbare Commands:\n${COMMANDS_LIST.join('\n')}`);
  } catch (error) {
    await replyCommandError(ctx, error);
  }
}

async function handleNewCommand(ctx: Context): Promise<void> {
  try {
    if (await rejectNonPrivateChat(ctx)) return;

    const chatId = String(ctx.chat?.id);
    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account mit /start TOKEN');
      return;
    }

    const sessionId = await createTelegramSession(chatId, binding.userId);
    await ctx.reply(`Neue Session erstellt: ${sessionId.slice(0, 12)}…`);
  } catch (error) {
    await replyCommandError(ctx, error);
  }
}

async function handleStopCommand(ctx: Context): Promise<void> {
  try {
    if (await rejectNonPrivateChat(ctx)) return;

    const chatId = String(ctx.chat?.id);
    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account mit /start TOKEN');
      return;
    }

    const sessionId = await resolveTelegramSession(chatId, binding.userId);
    await control(sessionId, binding.userId, 'abort');
    await ctx.reply('Lauf abgebrochen.');
  } catch (error) {
    await replyCommandError(ctx, error);
  }
}

async function handleCompactCommand(ctx: Context): Promise<void> {
  try {
    if (await rejectNonPrivateChat(ctx)) return;

    const chatId = String(ctx.chat?.id);
    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account mit /start TOKEN');
      return;
    }

    const sessionId = await resolveTelegramSession(chatId, binding.userId);
    await control(sessionId, binding.userId, 'compact');
    await ctx.reply('Compacting ausgelöst.');
  } catch (error) {
    await replyCommandError(ctx, error);
  }
}

async function handleSessionsCommand(ctx: Context): Promise<void> {
  try {
    if (await rejectNonPrivateChat(ctx)) return;

    const chatId = String(ctx.chat?.id);
    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account mit /start TOKEN');
      return;
    }

    const sessions = await listTelegramSessions(binding.userId);
    if (sessions.length === 0) {
      await ctx.reply('Keine Telegram-Sessions vorhanden.');
      return;
    }

    const lines = sessions.map((s) => {
      const title = s.title ?? '(ohne Titel)';
      return `• ${s.sessionId.slice(0, 12)}… — ${title}`;
    });
    await ctx.reply(`Deine Sessions:\n${lines.join('\n')}\n\nMit /switch SESSION_ID wechseln.`);
  } catch (error) {
    await replyCommandError(ctx, error);
  }
}

async function handleSwitchCommand(ctx: Context): Promise<void> {
  try {
    if (await rejectNonPrivateChat(ctx)) return;

    const chatId = String(ctx.chat?.id);
    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account mit /start TOKEN');
      return;
    }

    const targetSessionId = typeof ctx.match === 'string' ? ctx.match.trim() : ctx.match?.[0]?.trim();
    if (!targetSessionId) {
      await ctx.reply('Bitte gib die Session-ID an. Beispiel: /switch sess-1234567890-abcdef12');
      return;
    }

    const success = await switchTelegramSession(chatId, binding.userId, targetSessionId);
    if (success) {
      await ctx.reply(`Gewechselt zu Session: ${targetSessionId.slice(0, 12)}…`);
    } else {
      await ctx.reply('Session nicht gefunden oder gehört dir nicht.');
    }
  } catch (error) {
    await replyCommandError(ctx, error);
  }
}

async function handleStatusCommand(ctx: Context): Promise<void> {
  try {
    if (await rejectNonPrivateChat(ctx)) return;

    const chatId = String(ctx.chat?.id);
    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account mit /start TOKEN');
      return;
    }

    const sessionId = await resolveTelegramSession(chatId, binding.userId);
    const status = await getStatus(sessionId, binding.userId);
    if (!status) {
      await ctx.reply(`Aktive Session: ${sessionId.slice(0, 12)}…\nStatus: Keine Runtime aktiv.`);
      return;
    }
    await ctx.reply(`Aktive Session: ${sessionId.slice(0, 12)}…\nPhase: ${status.phase}\nContext: ${status.contextWindow ?? 'N/A'}`);
  } catch (error) {
    await replyCommandError(ctx, error);
  }
}

export function getCommandList(): string[] {
  return COMMANDS_LIST;
}
