import type { Bot, Context } from 'grammy';
import { sendMessage } from '@/app/lib/pi/runtime-service';
import { getBinding } from './link-token';
import { resolveTelegramSession } from './session-resolver';
import { registerCommands } from './commands';
import type { InboundMessage } from '../types';

export function setupInboundHandler(bot: Bot, onInbound: (message: InboundMessage) => Promise<void>): void {
  registerCommands(bot);

  bot.on('message', async (ctx: Context) => {
    if (ctx.chat?.type !== 'private') {
      return;
    }

    const chatId = String(ctx.chat?.id);
    const text = ctx.message?.text ?? '';
    const caption = ctx.message?.caption ?? '';
    const from = ctx.from;
    const hasPhoto = Array.isArray(ctx.message?.photo) && ctx.message.photo.length > 0;

    if ((!text && !caption && !hasPhoto) || !from) return;
    if (text.startsWith('/')) return;

    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account: /start TOKEN');
      return;
    }

    const sessionId = await resolveTelegramSession(chatId, binding.userId);

    const images: Array<{ data: string; mimeType: string }> = [];
    if (ctx.message?.photo) {
      const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
      if (largestPhoto) {
        try {
          const file = await bot.api.getFile(largestPhoto.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
          const response = await fetch(fileUrl);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            images.push({
              data: buffer.toString('base64'),
              mimeType: 'image/jpeg',
            });
          }
        } catch (err) {
          console.error('[Telegram Inbound] Failed to download photo:', err);
        }
      }
    }

    const userMessage = caption || text;

    const inbound: InboundMessage = {
      channelId: 'telegram',
      channelSessionKey: `telegram:${chatId}`,
      userId: binding.userId,
      text: userMessage,
      ...(images.length > 0 ? { images } : {}),
      metadata: {
        telegramChatId: chatId,
        telegramFromId: String(from.id),
        telegramMessageId: ctx.message?.message_id,
      },
    };

    try {
      const context = {
        currentTime: new Date().toISOString(),
        userTimeZone: 'UTC',
      };

      if (images.length > 0) {
        type ContentPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
        const contentParts: ContentPart[] = [
          { type: 'text', text: userMessage },
        ];
        for (const img of images) {
          contentParts.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        }
        await sendMessage(sessionId, binding.userId, {
          role: 'user',
          content: contentParts,
          timestamp: Date.now(),
        }, context);
      } else {
        await sendMessage(sessionId, binding.userId, {
          role: 'user',
          content: userMessage,
          timestamp: Date.now(),
        }, context);
      }

      await onInbound(inbound);
    } catch (error) {
      console.error('[Telegram Inbound] Error sending message:', error);
      await ctx.reply('Fehler bei der Nachrichtenverarbeitung. Bitte versuche es erneut.');
    }
  });
}
