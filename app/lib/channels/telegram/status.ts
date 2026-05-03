import type { ChannelStatus } from '../types';
import { getTelegramConfig } from './config';

export async function getTelegramChannelStatus(): Promise<ChannelStatus> {
  const config = await getTelegramConfig();

  if (!config.botToken) {
    return { running: false, connected: false, lastError: 'TELEGRAM_BOT_TOKEN not configured' };
  }

  if (!config.channelEnabled) {
    return { running: false, connected: false, lastError: 'TELEGRAM_CHANNEL_ENABLED is false' };
  }

  return {
    running: false,
    connected: false,
    mode: 'polling',
  };
}