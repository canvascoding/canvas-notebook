export const DEFAULT_AGENT_ID = 'canvas-agent';
export const WEB_CHANNEL_ID = 'web';
export const LEGACY_APP_CHANNEL_ID = 'app';
export const TELEGRAM_CHANNEL_ID = 'telegram';

export function normalizeChannelThreadKey(channelThreadKey?: string | null): string {
  return channelThreadKey?.trim() ?? '';
}

export function normalizeStoredChannelId(channelId: string): string {
  return channelId === LEGACY_APP_CHANNEL_ID ? WEB_CHANNEL_ID : channelId;
}

export function webChannelSessionKey(userId: string): string {
  return `web:user:${userId}`;
}

export function telegramChannelSessionKey(chatId: string): string {
  return chatId.startsWith('telegram:') ? chatId : `telegram:${chatId}`;
}

export function telegramChatIdFromSessionKey(channelSessionKey: string): string {
  return channelSessionKey.replace(/^telegram:/, '');
}
