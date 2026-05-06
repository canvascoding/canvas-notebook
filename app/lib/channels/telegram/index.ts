import type { Bot } from 'grammy';
import type { ChannelId, ChannelPlugin, ChannelStartContext, ChannelStatus, OutboundMessage, DeliveryTarget, DeliveryResult } from '../types';
import { createTelegramBot } from './bot';
import { TelegramPollingSession } from './polling';
import { setupInboundHandler } from './inbound';
import { deliverToTelegram, sendTypingAction } from './outbound';
import { registerTelegramBotCommands } from './commands';

export class TelegramChannel implements ChannelPlugin {
  id: ChannelId = 'telegram';
  name = 'Telegram';
  private bot: Bot;
  private polling: TelegramPollingSession | null = null;
  private running = false;
  private lastError: string | undefined;

  constructor(botToken: string) {
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
      return await deliverToTelegram(this.bot, message, target);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { ok: false, error: this.lastError };
    }
  }

  async sendTyping(target: DeliveryTarget): Promise<void> {
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
}

export function createTelegramChannel(botToken: string): TelegramChannel {
  return new TelegramChannel(botToken);
}
