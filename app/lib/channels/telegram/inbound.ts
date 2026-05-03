import type { Bot, Context } from 'grammy';
import path from 'node:path';
import { sendMessage } from '@/app/lib/pi/runtime-service';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { getUserUploadsRoot } from '@/app/lib/runtime-data-paths';
import { getBinding } from './link-token';
import { resolveTelegramSession } from './session-resolver';
import { registerCommands } from './commands';
import type { InboundMessage } from '../types';

const MAX_TELEGRAM_DOWNLOAD_SIZE = 10 * 1024 * 1024;

type SavedTelegramUpload = {
  originalName: string;
  mimeType: string;
  size: number;
  category: string;
  containerFilePath: string;
  image?: { data: string; mimeType: string };
};

function sanitizeTelegramFilename(filename: string, fallback: string): string {
  const basename = path.basename(filename.replace(/\\/g, '/')).trim();
  return basename || fallback;
}

function getUploadedContainerPath(storagePath: string): string {
  return path.join(getUserUploadsRoot(), storagePath);
}

async function downloadTelegramFile(bot: Bot, fileId: string): Promise<Buffer | null> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) return null;

  const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function saveTelegramUpload(
  bot: Bot,
  fileId: string,
  originalName: string,
  providedMimeType?: string,
  includeImagePart = false,
): Promise<SavedTelegramUpload | null> {
  const buffer = await downloadTelegramFile(bot, fileId);
  if (!buffer) return null;
  if (buffer.length > MAX_TELEGRAM_DOWNLOAD_SIZE) {
    throw new Error(`Telegram upload too large. Maximum size: ${MAX_TELEGRAM_DOWNLOAD_SIZE / (1024 * 1024)}MB`);
  }

  const uploaded = await saveUploadBuffer(buffer, originalName, providedMimeType);
  const containerFilePath = getUploadedContainerPath(uploaded.storagePath);

  return {
    originalName: uploaded.originalName,
    mimeType: uploaded.mimeType,
    size: uploaded.size,
    category: uploaded.category,
    containerFilePath,
    ...(includeImagePart && uploaded.category === 'image'
      ? { image: { data: buffer.toString('base64'), mimeType: uploaded.mimeType } }
      : {}),
  };
}

function buildUploadContextText(uploads: SavedTelegramUpload[]): string {
  if (uploads.length === 0) return '';

  const lines = uploads.map((upload, index) => [
    `Upload ${index + 1}:`,
    `- originalName: ${upload.originalName}`,
    `- mimeType: ${upload.mimeType}`,
    `- size: ${upload.size} bytes`,
    `- category: ${upload.category}`,
    `- containerFilePath: ${upload.containerFilePath}`,
  ].join('\n'));

  return [
    'Telegram attachments were saved to the filesystem. Use the containerFilePath values for direct file access.',
    '',
    ...lines,
  ].join('\n');
}

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
    const hasDocument = !!ctx.message?.document;

    if ((!text && !caption && !hasPhoto && !hasDocument) || !from) return;
    if (text.startsWith('/')) return;

    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account: /start TOKEN');
      return;
    }

    const sessionId = await resolveTelegramSession(chatId, binding.userId);

    const uploads: SavedTelegramUpload[] = [];
    if (ctx.message?.photo) {
      const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
      if (largestPhoto) {
        try {
          const upload = await saveTelegramUpload(
            bot,
            largestPhoto.file_id,
            `telegram-photo-${ctx.message.message_id}.jpg`,
            'image/jpeg',
            true,
          );
          if (upload) {
            uploads.push(upload);
          }
        } catch (err) {
          console.error('[Telegram Inbound] Failed to download photo:', err);
        }
      }
    }

    if (ctx.message?.document) {
      const document = ctx.message.document;
      try {
        if (document.file_size && document.file_size > MAX_TELEGRAM_DOWNLOAD_SIZE) {
          await ctx.reply(`Die Datei ist zu groß. Maximum: ${MAX_TELEGRAM_DOWNLOAD_SIZE / (1024 * 1024)}MB.`);
          return;
        }

        const filename = sanitizeTelegramFilename(
          document.file_name ?? '',
          `telegram-document-${ctx.message.message_id}`,
        );
        const upload = await saveTelegramUpload(
          bot,
          document.file_id,
          filename,
          document.mime_type,
          document.mime_type?.startsWith('image/') === true,
        );
        if (upload) {
          uploads.push(upload);
        }
      } catch (err) {
        console.error('[Telegram Inbound] Failed to download document:', err);
        await ctx.reply('Die Datei konnte nicht verarbeitet werden.');
        return;
      }
    }

    const userMessage = caption || text;
    const uploadContextText = buildUploadContextText(uploads);
    const messageText = [userMessage, uploadContextText].filter(Boolean).join('\n\n');

    const inbound: InboundMessage = {
      channelId: 'telegram',
      channelSessionKey: `telegram:${chatId}`,
      userId: binding.userId,
      text: messageText,
      ...(uploads.some((upload) => upload.image) ? { images: uploads.flatMap((upload) => upload.image ? [upload.image] : []) } : {}),
      metadata: {
        telegramChatId: chatId,
        telegramFromId: String(from.id),
        telegramMessageId: ctx.message?.message_id,
        telegramUploads: uploads.map(({ image: _image, ...upload }) => upload),
      },
    };

    try {
      const context = {
        currentTime: new Date().toISOString(),
        userTimeZone: 'UTC',
      };

      const imageParts = uploads.flatMap((upload) => upload.image ? [upload.image] : []);

      if (imageParts.length > 0) {
        type ContentPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
        const contentParts: ContentPart[] = [
          { type: 'text', text: messageText },
        ];
        for (const img of imageParts) {
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
          content: messageText,
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
