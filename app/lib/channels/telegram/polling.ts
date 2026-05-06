export class TelegramPollingSession {
  private bot: import('grammy').Bot;
  private abortSignal: AbortSignal;
  private running = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INITIAL_BACKOFF_MS = 2000;
  private static readonly MAX_BACKOFF_MS = 30000;
  private static readonly BACKOFF_FACTOR = 1.8;
  private static readonly TELEGRAM_API_TIMEOUT_MS = 10_000;
  private static readonly STOP_TIMEOUT_MS = 5_000;

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
      await this.withTimeout(
        this.bot.api.deleteWebhook({ drop_pending_updates: true }),
        TelegramPollingSession.TELEGRAM_API_TIMEOUT_MS,
        'deleteWebhook',
      );
      console.log('[TelegramPolling] Deleted existing webhook');
    } catch (err) {
      console.warn('[TelegramPolling] Could not delete webhook:', err instanceof Error ? err.message : err);
    }

    void this.runWithBackoff().catch((err) => {
      console.error('[TelegramPolling] Polling loop crashed:', err instanceof Error ? err.message : err);
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      await this.withTimeout(
        Promise.resolve(this.bot.stop()),
        TelegramPollingSession.STOP_TIMEOUT_MS,
        'bot.stop',
      );
    } catch (err) {
      if (this.isGetUpdatesConflict(err)) {
        console.warn('[TelegramPolling] Ignoring getUpdates conflict while stopping polling');
      } else {
        console.warn('[TelegramPolling] Error while stopping polling:', err instanceof Error ? err.message : err);
      }
    }
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
        if (this.isGetUpdatesConflict(err)) {
          console.warn('[TelegramPolling] getUpdates conflict detected; another bot instance is polling');
        } else {
          console.error('[TelegramPolling] Bot error:', err instanceof Error ? err.message : err);
        }
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

  private isGetUpdatesConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<string, unknown>;
    const message = error instanceof Error ? error.message : String(record.description ?? '');
    return record.error_code === 409 ||
      record.errorCode === 409 ||
      message.includes('409: Conflict') ||
      message.includes('terminated by other getUpdates request');
  }
}
