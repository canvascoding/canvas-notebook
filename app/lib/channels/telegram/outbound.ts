import type { Bot } from 'grammy';
import type { DeliveryTarget, DeliveryResult, OutboundMessage } from '../types';
import { markdownToTelegramHtml, chunkTelegramMessage } from './normalize';

const CHUNK_DELAY_MS = 50;
const TOOL_RESULT_MAX_LENGTH = 1000;

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

export async function deliverToTelegram(
  bot: Bot,
  message: OutboundMessage,
  target: DeliveryTarget,
): Promise<DeliveryResult> {
  const rawText = extractAssistantText(message);
  const htmlText = markdownToTelegramHtml(rawText);
  const chunks = chunkTelegramMessage(htmlText);

  try {
    let lastMessageId: number | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = await bot.api.sendMessage(target.chatId, chunk, {
        parse_mode: 'HTML',
      });
      lastMessageId = result.message_id;

      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
      }
    }

    return { ok: true, telegramMessageId: lastMessageId };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Telegram Outbound] Delivery failed:', errorMsg);

    try {
      const plainChunks = chunkTelegramMessage(rawText);
      for (let i = 0; i < plainChunks.length; i++) {
        await bot.api.sendMessage(target.chatId, plainChunks[i]);
        if (i < plainChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
        }
      }
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