import { createHash } from 'node:crypto';

/** A redelivery retains its provider identity even after local media processing. */
export function telegramInboundClientMessageId(botId: string, chatId: string, messageId?: number, mediaGroupId?: string): string {
  if (!/^[1-9][0-9]*$/u.test(botId) || !/^-?[1-9][0-9]*$/u.test(chatId)
    || (mediaGroupId === undefined && (!Number.isSafeInteger(messageId) || messageId! < 1))
    || (mediaGroupId !== undefined && (!mediaGroupId || mediaGroupId.length > 256
      || mediaGroupId !== mediaGroupId.trim() || /[\p{Cc}\p{Cf}]/u.test(mediaGroupId)))) {
    throw new Error('The Telegram message has no stable provider identity.');
  }
  return `telegram:${createHash('sha256').update(JSON.stringify([botId, chatId,
    mediaGroupId === undefined ? ['message', messageId] : ['media-group', mediaGroupId]])).digest('hex')}`;
}
