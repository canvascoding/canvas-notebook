import { getChannelRegistry } from './registry';
import { type ChannelStatus } from './types';

class ChannelManager {
  private abortController: AbortController | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) {
      console.log('[ChannelManager] Already started');
      return;
    }

    console.log('[ChannelManager] Starting channels...');

    const { getTelegramConfigFromIntegrations } = await import('@/app/lib/integrations/env-config');
    const config = await getTelegramConfigFromIntegrations();

    if (!config.botToken) {
      console.log('[ChannelManager] TELEGRAM_BOT_TOKEN not configured — skipping Telegram channel');
    } else if (!config.channelEnabled) {
      console.log('[ChannelManager] TELEGRAM_CHANNEL_ENABLED is false — skipping Telegram channel');
    } else {
      try {
        const { createTelegramChannel } = await import('./telegram');
        const telegramChannel = createTelegramChannel(config.botToken);
        const registry = getChannelRegistry();
        registry.register(telegramChannel);

        this.abortController = new AbortController();
        await telegramChannel.start({
          abortSignal: this.abortController.signal,
          onInboundMessage: async () => {},
        });

        console.log('[ChannelManager] Telegram channel started');
      } catch (error) {
        console.error('[ChannelManager] Failed to start Telegram channel:', error);
      }
    }

    this.started = true;
    console.log('[ChannelManager] All channels initialized');
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    console.log('[ChannelManager] Stopping channels...');

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    const registry = getChannelRegistry();
    for (const channel of registry.getAll()) {
      try {
        await channel.stop();
        registry.unregister(channel.id);
      } catch (error) {
        console.error(`[ChannelManager] Error stopping channel ${channel.id}:`, error);
      }
    }

    this.started = false;
    console.log('[ChannelManager] All channels stopped');
  }

  getChannelStatuses(): Record<string, ChannelStatus> {
    const registry = getChannelRegistry();
    const statuses: Record<string, ChannelStatus> = {};
    for (const channel of registry.getAll()) {
      statuses[channel.id] = channel.getStatus();
    }
    return statuses;
  }

  async restart(): Promise<void> {
    if (!this.started) {
      console.log('[ChannelManager] Not started yet, calling start()');
      return this.start();
    }

    console.log('[ChannelManager] Restarting channels...');
    await this.stop();
    await this.start();
    console.log('[ChannelManager] Restart complete');
  }
}

const globalManager = globalThis as typeof globalThis & {
  __channelManager?: ChannelManager;
};

export function getChannelManager(): ChannelManager {
  if (!globalManager.__channelManager) {
    globalManager.__channelManager = new ChannelManager();
  }
  return globalManager.__channelManager;
}