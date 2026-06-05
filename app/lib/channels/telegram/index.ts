import type { Bot } from 'grammy';
import type { ChannelId, ChannelPlugin, ChannelStartContext, ChannelStatus, OutboundMessage, DeliveryTarget, DeliveryResult } from '../types';
import { createTelegramBot } from './bot';
import { TelegramPollingSession } from './polling';
import { setupInboundHandler } from './inbound';
import { deliverToTelegram, sendTypingAction } from './outbound';
import { registerTelegramBotCommands } from './commands';
import { getTelegramConfig } from './config';

export class TelegramChannel implements ChannelPlugin {
  id: ChannelId = 'telegram';
  name = 'Telegram';
  capabilities = {
    inboundText: true,
    inboundImages: true,
    inboundVideos: true,
    inboundAudio: true,
    inboundFiles: true,
    outboundText: true,
    outboundImages: true,
    outboundVideos: true,
    outboundAudio: true,
    outboundFiles: true,
    typingIndicator: true,
  };
  private bot: Bot;
  private botToken: string;
  private polling: TelegramPollingSession | null = null;
  private running = false;
  private lastError: string | undefined;

  constructor(botToken: string) {
    this.botToken = botToken;
    this.bot = createTelegramBot(botToken);
  }

  async start(context: ChannelStartContext): Promise<void> {
    try {
      setupInboundHandler(this.bot, context.onInboundMessage);

      this.polling = new TelegramPollingSession(this.bot, context.abortSignal);
      await this.polling.start();
      void registerTelegramBotCommands(this.bot).catch((err) => {
        console.warn('[TelegramChannel] Failed to register bot commands:', err instanceof Error ? err.message : err);
      });
      this.running = true;
      this.lastError = undefined;
      console.log('[TelegramChannel] Started successfully');
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.running = false;
      console.error('[TelegramChannel] Failed to start:', this.lastError);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.polling) {
      await this.polling.stop();
      this.polling = null;
    }
    this.running = false;
    console.log('[TelegramChannel] Stopped');
  }

  async deliver(message: OutboundMessage, target: DeliveryTarget): Promise<DeliveryResult> {
    try {
      const disabledReason = await this.getDisabledDeliveryReason();
      if (disabledReason) {
        this.lastError = disabledReason;
        return { ok: false, error: disabledReason };
      }
      return await deliverToTelegram(this.bot, message, target);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, error: this.lastError };
    }
  }

  async sendTyping(target: DeliveryTarget): Promise<void> {
    const disabledReason = await this.getDisabledDeliveryReason();
    if (disabledReason) return;
    await sendTypingAction(this.bot, target.chatId);
  }

  getStatus(): ChannelStatus {
    return {
      running: this.running,
      connected: this.running,
      lastError: this.lastError,
      mode: 'polling',
    };
  }

  getBot(): Bot {
    return this.bot;
  }

  private async getDisabledDeliveryReason(): Promise<string | null> {
    const config = await getTelegramConfig();
    if (!config.botToken) {
      return 'TELEGRAM_BOT_TOKEN not configured';
    }
    if (!config.channelEnabled) {
      return 'TELEGRAM_CHANNEL_ENABLED is false';
    }
    if (config.botToken !== this.botToken) {
      return 'TELEGRAM_BOT_TOKEN changed; restart Telegram channel before delivery';
    }
    return null;
  }
}

export function createTelegramChannel(botToken: string): TelegramChannel {
  return new TelegramChannel(botToken);
}
