import { InputFile, type Bot } from 'grammy';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { DeliveryTarget, DeliveryResult, OutboundMessage } from '../types';
import { markdownToTelegramHtml, chunkTelegramMessage } from './normalize';
import {
  isSafeMediaAttachment,
  parseMediaDirectives,
  validateMediaDirectivePath,
  type SafeMediaAttachment,
  type UnsafeMediaDirective,
} from '../media-directives';

const CHUNK_DELAY_MS = 50;
const TOOL_RESULT_MAX_LENGTH = 1000;
const MAX_TELEGRAM_OUTBOUND_UPLOAD_SIZE = 50 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const GIF_EXTENSIONS = new Set(['.gif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.3gp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.ogg', '.opus', '.wav', '.flac', '.aac']);
const TELEGRAM_SEND_AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a']);
const TELEGRAM_SEND_VOICE_EXTENSIONS = new Set(['.ogg', '.opus']);

type TelegramMediaHints = {
  audioAsVoice: boolean;
  asDocument: boolean;
};

function extractAssistantText(message: OutboundMessage): string {
  if (message.role === 'toolResult') {
    const text = typeof message.content === 'string' ? message.content : String(message.content);
    if (text.length > TOOL_RESULT_MAX_LENGTH) {
      return text.slice(0, TOOL_RESULT_MAX_LENGTH) + '…\n_(vollständig im App-Chat sichtbar)_';
    }
    return text;
  }

  return typeof message.content === 'string' ? message.content : String(message.content);
}

function getThreadOptions(target: DeliveryTarget): Record<string, number> {
  const rawThreadId = target.threadId ?? target.channelThreadKey;
  if (!rawThreadId) return {};
  const threadId = Number(rawThreadId);
  return Number.isInteger(threadId) ? { message_thread_id: threadId } : {};
}

function getMimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.opus') return 'audio/opus';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function getMediaKind(filePath: string, mimeType: string): 'image' | 'gif' | 'video' | 'audio' | 'document' {
  const ext = path.extname(filePath).toLowerCase();
  if (GIF_EXTENSIONS.has(ext) || mimeType === 'image/gif') return 'gif';
  if (IMAGE_EXTENSIONS.has(ext) || mimeType.startsWith('image/')) return 'image';
  if (VIDEO_EXTENSIONS.has(ext) || mimeType.startsWith('video/')) return 'video';
  if (AUDIO_EXTENSIONS.has(ext) || mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

async function sendTelegramTextChunks(
  bot: Bot,
  target: DeliveryTarget,
  rawText: string,
): Promise<number | undefined> {
  if (!rawText.trim()) return undefined;

  const htmlText = markdownToTelegramHtml(rawText);
  const chunks = chunkTelegramMessage(htmlText);
  const threadOptions = getThreadOptions(target);
  let lastMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.trim()) continue;
    const result = await bot.api.sendMessage(target.chatId, chunk, {
      parse_mode: 'HTML',
      ...threadOptions,
    });
    lastMessageId = result.message_id;

    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
    }
  }

  return lastMessageId;
}

async function sendPlainTextFallback(bot: Bot, target: DeliveryTarget, rawText: string): Promise<number | undefined> {
  if (!rawText.trim()) return undefined;

  const plainChunks = chunkTelegramMessage(rawText);
  const threadOptions = getThreadOptions(target);
  let lastMessageId: number | undefined;

  for (let i = 0; i < plainChunks.length; i++) {
    const chunk = plainChunks[i];
    if (!chunk.trim()) continue;
    const result = await bot.api.sendMessage(target.chatId, chunk, threadOptions);
    lastMessageId = result.message_id;
    if (i < plainChunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
    }
  }

  return lastMessageId;
}

async function sendTelegramDocument(
  bot: Bot,
  target: DeliveryTarget,
  attachment: SafeMediaAttachment,
  buffer: Buffer,
): Promise<number> {
  const result = await bot.api.sendDocument(
    target.chatId,
    new InputFile(buffer, path.basename(attachment.path)),
    {
      ...getThreadOptions(target),
    },
  );
  return result.message_id;
}

async function sendTelegramMediaAttachment(
  bot: Bot,
  target: DeliveryTarget,
  attachment: SafeMediaAttachment,
  hints: TelegramMediaHints,
): Promise<number> {
  const buffer = await fs.readFile(attachment.path);
  const detectedType = await fileTypeFromBuffer(buffer);
  const mimeType = detectedType?.mime ?? getMimeFromExtension(attachment.path);
  const kind = getMediaKind(attachment.path, mimeType);
  const inputFile = () => new InputFile(buffer, path.basename(attachment.path));
  const threadOptions = getThreadOptions(target);

  if (!hints.asDocument && kind === 'gif') {
    try {
      const result = await bot.api.sendAnimation(target.chatId, inputFile(), threadOptions);
      return result.message_id;
    } catch (error) {
      console.warn('[Telegram Outbound] sendAnimation failed; falling back to document:', error);
      return sendTelegramDocument(bot, target, attachment, buffer);
    }
  }

  if (!hints.asDocument && kind === 'image') {
    try {
      const result = await bot.api.sendPhoto(target.chatId, inputFile(), threadOptions);
      return result.message_id;
    } catch (error) {
      console.warn('[Telegram Outbound] sendPhoto failed; falling back to document:', error);
      return sendTelegramDocument(bot, target, attachment, buffer);
    }
  }

  if (!hints.asDocument && kind === 'video') {
    try {
      const result = await bot.api.sendVideo(target.chatId, inputFile(), threadOptions);
      return result.message_id;
    } catch (error) {
      console.warn('[Telegram Outbound] sendVideo failed; falling back to document:', error);
      return sendTelegramDocument(bot, target, attachment, buffer);
    }
  }

  if (!hints.asDocument && kind === 'audio') {
    const ext = path.extname(attachment.path).toLowerCase();
    if (hints.audioAsVoice && TELEGRAM_SEND_VOICE_EXTENSIONS.has(ext)) {
      try {
        const result = await bot.api.sendVoice(target.chatId, inputFile(), threadOptions);
        return result.message_id;
      } catch (error) {
        console.warn('[Telegram Outbound] sendVoice failed; falling back to audio/document:', error);
      }
    }

    if (TELEGRAM_SEND_AUDIO_EXTENSIONS.has(ext)) {
      try {
        const result = await bot.api.sendAudio(target.chatId, inputFile(), threadOptions);
        return result.message_id;
      } catch (error) {
        console.warn('[Telegram Outbound] sendAudio failed; falling back to document:', error);
      }
    }

    return sendTelegramDocument(bot, target, attachment, buffer);
  }

  return sendTelegramDocument(bot, target, attachment, buffer);
}

export async function deliverToTelegram(
  bot: Bot,
  message: OutboundMessage,
  target: DeliveryTarget,
): Promise<DeliveryResult> {
  const rawText = extractAssistantText(message);
  const parsed = parseMediaDirectives(rawText);
  const validationResults = await Promise.all(
    parsed.media.map((media) => validateMediaDirectivePath(media.rawPath, { maxBytes: MAX_TELEGRAM_OUTBOUND_UPLOAD_SIZE })),
  );
  const safeMedia = validationResults.filter(isSafeMediaAttachment);
  const unsafeMedia = validationResults.filter((result): result is UnsafeMediaDirective => !isSafeMediaAttachment(result));
  if (unsafeMedia.length > 0) {
    console.warn('[Telegram Outbound] Skipped unsafe MEDIA directives:', unsafeMedia.map((entry) => entry.reason));
  }

  try {
    let lastMessageId: number | undefined;
    const fallbackNotice = parsed.media.length > 0 && safeMedia.length === 0 && !parsed.text.trim()
      ? 'Die angeforderte Datei konnte nicht sicher per Telegram gesendet werden.'
      : '';
    const textToSend = parsed.text || fallbackNotice;

    try {
      lastMessageId = await sendTelegramTextChunks(bot, target, textToSend);
    } catch (textError) {
      console.warn('[Telegram Outbound] HTML delivery failed; falling back to plain text:', textError);
      lastMessageId = await sendPlainTextFallback(bot, target, textToSend);
    }

    for (let i = 0; i < safeMedia.length; i++) {
      const mediaMessageId = await sendTelegramMediaAttachment(bot, target, safeMedia[i], {
        audioAsVoice: parsed.audioAsVoice,
        asDocument: parsed.asDocument,
      });
      lastMessageId = mediaMessageId;
      if (i < safeMedia.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
      }
    }

    if (!lastMessageId && !parsed.hadDirective) {
      return { ok: false, error: 'No Telegram content to deliver' };
    }

    return { ok: true, telegramMessageId: lastMessageId };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Telegram Outbound] Delivery failed:', errorMsg);

    try {
      await sendPlainTextFallback(bot, target, parsed.text || rawText);
      return { ok: true };
    } catch (fallbackError) {
      return { ok: false, error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) };
    }
  }
}

export async function sendTypingAction(bot: Bot, chatId: string): Promise<void> {
  try {
    await bot.api.sendChatAction(chatId, 'typing');
  } catch { /* ignore rate limits */ }
}
