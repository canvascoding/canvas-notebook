export class TelegramPollingSession {
  private bot: import('grammy').Bot;
  private abortSignal: AbortSignal;
  private running = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateTimestamp = 0;
  private stallCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastReceivedUpdateAt = 0;
  private static readonly INITIAL_BACKOFF_MS = 2000;
  private static readonly MAX_BACKOFF_MS = 30000;
  private static readonly BACKOFF_FACTOR = 1.8;
  private static readonly STALL_THRESHOLD_MS = 120_000;
  private static readonly STALL_CHECK_INTERVAL_MS = 30_000;

  constructor(bot: import('grammy').Bot, abortSignal: AbortSignal) {
    this.bot = bot;
    this.abortSignal = abortSignal;
  }

  async start(): Promise<void> {
    if (this.running) {
      console.log('[TelegramPolling] Already running');
      return;
    }

    console.log('[TelegramPolling] Starting polling...');
    this.running = true;

    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true });
      console.log('[TelegramPolling] Deleted existing webhook');
    } catch (err) {
      console.warn('[TelegramPolling] Could not delete webhook:', err instanceof Error ? err.message : err);
    }

    this.lastReceivedUpdateAt = Date.now();
    this.startStallDetection();
    void this.runWithBackoff().catch((err) => {
      console.error('[TelegramPolling] Polling loop crashed:', err instanceof Error ? err.message : err);
      this.running = false;
    });
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
    }
    try {
      this.bot.stop();
    } catch { /* ignore */ }
    console.log('[TelegramPolling] Stopped');
  }

  private async runWithBackoff(): Promise<void> {
    let backoffMs = TelegramPollingSession.INITIAL_BACKOFF_MS;

    while (this.running && !this.abortSignal.aborted) {
      try {
        await this.bot.start({
          allowed_updates: ['message'],
          onStart: (info) => {
            console.log(`[TelegramPolling] Bot started: @${info.username ?? 'unknown'}`);
            backoffMs = TelegramPollingSession.INITIAL_BACKOFF_MS;
          },
        });

        if (!this.running || this.abortSignal.aborted) {
          break;
        }

        console.warn('[TelegramPolling] Bot stopped unexpectedly, will restart...');
      } catch (err) {
        console.error('[TelegramPolling] Bot error:', err instanceof Error ? err.message : err);
      }

      if (!this.running || this.abortSignal.aborted) {
        break;
      }

      const jitter = backoffMs * 0.25 * Math.random();
      const delay = backoffMs + jitter;
      console.log(`[TelegramPolling] Restarting in ${Math.round(delay)}ms...`);

      await new Promise<void>((resolve) => {
        this.restartTimer = setTimeout(resolve, delay);
        this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });

      backoffMs = Math.min(
        backoffMs * TelegramPollingSession.BACKOFF_FACTOR,
        TelegramPollingSession.MAX_BACKOFF_MS,
      );
    }
  }

  private startStallDetection(): void {
    this.stallCheckInterval = setInterval(() => {
      if (!this.running) return;
      const elapsed = Date.now() - this.lastReceivedUpdateAt;
      if (elapsed > TelegramPollingSession.STALL_THRESHOLD_MS && this.lastReceivedUpdateAt > 0) {
        console.warn('[TelegramPolling] Stall detected — no updates for over 2 minutes, restarting...');
        this.bot.stop();
      }
    }, TelegramPollingSession.STALL_CHECK_INTERVAL_MS);
  }

  notifyUpdateReceived(): void {
    this.lastReceivedUpdateAt = Date.now();
  }
}
