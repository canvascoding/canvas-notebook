import type { Bot, Context } from 'grammy';
import path from 'node:path';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { getUserUploadsRoot } from '@/app/lib/runtime-data-paths';
import { getBinding } from './link-token';
import { registerCommands } from './commands';
import { sendTypingAction } from './outbound';
import type { InboundMessage } from '../types';
import { handleInboundChannelMessage } from '@/app/lib/channels/router';
import { TELEGRAM_CHANNEL_ID, telegramChannelSessionKey } from '@/app/lib/channels/constants';
import { transcribeAudio } from '@/app/lib/integrations/audio-transcription-service';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';

const MAX_TELEGRAM_DOWNLOAD_SIZE = 10 * 1024 * 1024;

type SavedTelegramUpload = {
  originalName: string;
  mimeType: string;
  size: number;
  category: string;
  containerFilePath: string;
  image?: { data: string; mimeType: string };
};

type TelegramTranscription = {
  originalName: string;
  mimeType: string;
  size: number;
  containerFilePath: string;
  text: string;
  provider: string;
  model: string;
  durationMs: number;
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

function assertTelegramDownloadSize(buffer: Buffer): void {
  if (buffer.length > MAX_TELEGRAM_DOWNLOAD_SIZE) {
    throw new Error(`Telegram upload too large. Maximum size: ${MAX_TELEGRAM_DOWNLOAD_SIZE / (1024 * 1024)}MB`);
  }
}

async function persistTelegramUpload(
  buffer: Buffer,
  originalName: string,
  providedMimeType?: string,
  includeImagePart = false,
): Promise<SavedTelegramUpload> {
  assertTelegramDownloadSize(buffer);
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

async function saveTelegramUpload(
  bot: Bot,
  fileId: string,
  originalName: string,
  providedMimeType?: string,
  includeImagePart = false,
): Promise<SavedTelegramUpload | null> {
  const buffer = await downloadTelegramFile(bot, fileId);
  if (!buffer) return null;
  return persistTelegramUpload(buffer, originalName, providedMimeType, includeImagePart);
}

async function saveAndTranscribeTelegramAudio(
  bot: Bot,
  fileId: string,
  originalName: string,
  providedMimeType?: string,
): Promise<{ upload: SavedTelegramUpload; transcription: TelegramTranscription } | null> {
  const buffer = await downloadTelegramFile(bot, fileId);
  if (!buffer) return null;

  const upload = await persistTelegramUpload(buffer, originalName, providedMimeType);
  const transcription = await transcribeAudio({
    buffer,
    filename: upload.originalName,
    mimeType: upload.mimeType,
  });

  return {
    upload,
    transcription: {
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.size,
      containerFilePath: upload.containerFilePath,
      text: transcription.text,
      provider: transcription.provider,
      model: transcription.model,
      durationMs: transcription.durationMs,
    },
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

function buildTranscriptionContextText(transcriptions: TelegramTranscription[]): string {
  if (transcriptions.length === 0) return '';

  if (transcriptions.length === 1) {
    return `Voice transcription:\n${transcriptions[0].text}`;
  }

  return transcriptions
    .map((entry, index) => `Voice transcription ${index + 1} (${entry.originalName}):\n${entry.text}`)
    .join('\n\n');
}

function getTranscriptionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
  if (error instanceof IntegrationServiceError && error.statusCode === 400) {
    return message;
  }
  return `Die Sprachnachricht konnte nicht transkribiert werden: ${message}`;
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
    const hasVoice = !!ctx.message?.voice;
    const hasAudio = !!ctx.message?.audio;

    if ((!text && !caption && !hasPhoto && !hasDocument && !hasVoice && !hasAudio) || !from) return;
    if (text.startsWith('/')) return;

    const binding = await getBinding('telegram', chatId);
    if (!binding) {
      await ctx.reply('Bitte verknüpfe zuerst deinen Account: /start TOKEN');
      return;
    }

    void sendTypingAction(bot, chatId);

    const uploads: SavedTelegramUpload[] = [];
    const transcriptions: TelegramTranscription[] = [];
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
        if (document.mime_type?.startsWith('audio/') === true) {
          const audioResult = await saveAndTranscribeTelegramAudio(
            bot,
            document.file_id,
            filename,
            document.mime_type,
          );
          if (audioResult) {
            uploads.push(audioResult.upload);
            transcriptions.push(audioResult.transcription);
          }
        } else {
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
        }
      } catch (err) {
        console.error('[Telegram Inbound] Failed to download document:', err);
        await ctx.reply(document.mime_type?.startsWith('audio/') === true
          ? getTranscriptionErrorMessage(err)
          : 'Die Datei konnte nicht verarbeitet werden.');
        return;
      }
    }

    if (ctx.message?.voice) {
      const voice = ctx.message.voice;
      try {
        if (voice.file_size && voice.file_size > MAX_TELEGRAM_DOWNLOAD_SIZE) {
          await ctx.reply(`Die Sprachnachricht ist zu groß. Maximum: ${MAX_TELEGRAM_DOWNLOAD_SIZE / (1024 * 1024)}MB.`);
          return;
        }

        const audioResult = await saveAndTranscribeTelegramAudio(
          bot,
          voice.file_id,
          `telegram-voice-${ctx.message.message_id}.ogg`,
          voice.mime_type || 'audio/ogg',
        );
        if (audioResult) {
          uploads.push(audioResult.upload);
          transcriptions.push(audioResult.transcription);
        }
      } catch (err) {
        console.error('[Telegram Inbound] Failed to transcribe voice message:', err);
        await ctx.reply(getTranscriptionErrorMessage(err));
        return;
      }
    }

    if (ctx.message?.audio) {
      const audio = ctx.message.audio;
      try {
        if (audio.file_size && audio.file_size > MAX_TELEGRAM_DOWNLOAD_SIZE) {
          await ctx.reply(`Die Audiodatei ist zu groß. Maximum: ${MAX_TELEGRAM_DOWNLOAD_SIZE / (1024 * 1024)}MB.`);
          return;
        }

        const filename = sanitizeTelegramFilename(
          audio.file_name ?? '',
          `telegram-audio-${ctx.message.message_id}.mp3`,
        );
        const audioResult = await saveAndTranscribeTelegramAudio(
          bot,
          audio.file_id,
          filename,
          audio.mime_type || 'audio/mpeg',
        );
        if (audioResult) {
          uploads.push(audioResult.upload);
          transcriptions.push(audioResult.transcription);
        }
      } catch (err) {
        console.error('[Telegram Inbound] Failed to transcribe audio message:', err);
        await ctx.reply(getTranscriptionErrorMessage(err));
        return;
      }
    }

    const userMessage = caption || text;
    const transcriptionContextText = buildTranscriptionContextText(transcriptions);
    const uploadContextText = buildUploadContextText(uploads);
    const messageText = [userMessage, transcriptionContextText, uploadContextText].filter(Boolean).join('\n\n');
    if (!messageText.trim()) {
      await ctx.reply('Die Nachricht konnte nicht verarbeitet werden.');
      return;
    }

    const inbound: InboundMessage = {
      channelId: TELEGRAM_CHANNEL_ID,
      channelSessionKey: telegramChannelSessionKey(chatId),
      userId: binding.userId,
      text: messageText,
      ...(uploads.some((upload) => upload.image) ? { images: uploads.flatMap((upload) => upload.image ? [upload.image] : []) } : {}),
      metadata: {
        telegramChatId: chatId,
        telegramFromId: String(from.id),
        telegramMessageId: ctx.message?.message_id,
        telegramUploads: uploads.map(({ image: _image, ...upload }) => upload),
        telegramTranscriptions: transcriptions,
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
        inbound.contentParts = contentParts;
      } else {
        inbound.contentParts = [{ type: 'text', text: messageText }];
      }

      await handleInboundChannelMessage(inbound, context);
      await onInbound(inbound);
    } catch (error) {
      console.error('[Telegram Inbound] Error sending message:', error);
      await ctx.reply('Fehler bei der Nachrichtenverarbeitung. Bitte versuche es erneut.');
    }
  });
}
