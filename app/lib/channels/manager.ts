import { getChannelRegistry } from './registry';
import { type ChannelStatus } from './types';

const CHANNEL_START_TIMEOUT_MS = 15_000;
const CHANNEL_STOP_TIMEOUT_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class ChannelManager {
  private abortController: AbortController | null = null;
  private started = false;
  private restartPromise: Promise<void> | null = null;

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
        await withTimeout(
          telegramChannel.start({
            abortSignal: this.abortController.signal,
            onInboundMessage: async () => {},
          }),
          CHANNEL_START_TIMEOUT_MS,
          'Telegram channel start',
        );

        console.log('[ChannelManager] Telegram channel started');
      } catch (error) {
        console.error('[ChannelManager] Failed to start Telegram channel:', error);
        getChannelRegistry().unregister('telegram');
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
        await withTimeout(channel.stop(), CHANNEL_STOP_TIMEOUT_MS, `${channel.id} channel stop`);
        registry.unregister(channel.id);
      } catch (error) {
        console.error(`[ChannelManager] Error stopping channel ${channel.id}:`, error);
        registry.unregister(channel.id);
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
    if (this.restartPromise) {
      console.log('[ChannelManager] Restart already in progress');
      return this.restartPromise;
    }

    this.restartPromise = this.restartInternal().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  private async restartInternal(): Promise<void> {
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
