import { randomUUID } from 'node:crypto';

import {
  SYSTEM_UPDATE_CONTRACT_VERSION,
  validateSystemUpdateEvent,
  type SystemUpdateActivity,
  type SystemUpdateErrorCode,
  type SystemUpdateEvent,
  type SystemUpdateStage,
  type SystemUpdateStageStatus,
} from './systemUpdateContract';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const SYSTEM_UPDATE_ACTIVITY_INTERVAL_MS = 5000;

export interface SystemUpdateEventReporterOptions {
  enabled: boolean;
  operationId?: string;
  write?: (line: string) => void;
  now?: () => Date;
  activityIntervalMs?: number;
}

export class SystemUpdateEventReporter {
  readonly operationId: string;
  private sequence = 0;
  private readonly enabled: boolean;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;
  private readonly activityIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private active?: { stage: SystemUpdateStage; message: string; startedAt: number; lastHealthAt?: number };

  constructor(options: SystemUpdateEventReporterOptions) {
    const operationId = options.operationId || randomUUID();
    if (!UUID_PATTERN.test(operationId)) throw new Error('--operation-id must be a UUID.');
    this.operationId = operationId;
    this.enabled = options.enabled;
    this.write = options.write || ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now || (() => new Date());
    this.activityIntervalMs = options.activityIntervalMs ?? SYSTEM_UPDATE_ACTIVITY_INTERVAL_MS;
    if (!Number.isSafeInteger(this.activityIntervalMs) || this.activityIntervalMs < 1) {
      throw new Error('Update activity interval must be a positive integer.');
    }
  }

  emit(
    stage: SystemUpdateStage,
    status: SystemUpdateStageStatus,
    message: string,
    errorCode?: SystemUpdateErrorCode,
    rollbackImageVerified?: true,
    activity?: SystemUpdateActivity,
  ): SystemUpdateEvent | null {
    if (!this.enabled) return null;
    if (!activity) this.dispose();
    const normalizedMessage = message.replace(/[\0\r\n]+/gu, ' ').trim().slice(0, 2048) || 'Update status changed.';
    const event: SystemUpdateEvent = {
      contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
      eventId: randomUUID(),
      sequence: ++this.sequence,
      operationId: this.operationId,
      stage,
      status,
      message: normalizedMessage,
      occurredAt: this.now().toISOString(),
      ...(errorCode ? { errorCode } : {}),
      ...(activity ? { activity } : {}),
      ...(rollbackImageVerified ? { rollbackImageVerified } : {}),
    };
    const validated = validateSystemUpdateEvent(event);
    if (!validated.ok) throw new Error(validated.error);
    this.write(JSON.stringify(validated.value));
    if (status === 'running' && !activity) {
      this.active = { stage, message: normalizedMessage, startedAt: performance.now() };
      this.timer = setInterval(() => {
        const active = this.active;
        if (!active) return;
        this.emit(active.stage, 'running', active.message, undefined, undefined, {
          kind: 'keepalive',
          elapsedMs: Math.max(0, Math.floor(performance.now() - active.startedAt)),
        });
      }, this.activityIntervalMs);
      this.timer.unref();
    }
    return validated.value;
  }

  /** Stop activity on success, failure, rollback transitions, and exceptional exits. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.active = undefined;
  }

  healthCheck(details: Omit<SystemUpdateActivity, 'kind'>): void {
    const active = this.active;
    if (!active) return;
    const now = performance.now();
    if (!details.healthy && details.attempt !== details.maxAttempts
      && active.lastHealthAt !== undefined && now - active.lastHealthAt < this.activityIntervalMs) return;
    active.lastHealthAt = now;
    this.emit(active.stage, 'running', details.healthy ? 'Canvas Notebook health check passed.' : 'Waiting for Canvas Notebook health.',
      undefined, undefined, { ...details, kind: 'health_check' });
  }

  running(stage: SystemUpdateStage, message: string): SystemUpdateEvent | null {
    return this.emit(stage, 'running', message);
  }

  succeeded(stage: SystemUpdateStage, message: string): SystemUpdateEvent | null {
    return this.emit(stage, 'succeeded', message);
  }

  skipped(stage: SystemUpdateStage, message: string): SystemUpdateEvent | null {
    return this.emit(stage, 'skipped', message);
  }

  failed(stage: SystemUpdateStage, message: string, errorCode: SystemUpdateErrorCode): SystemUpdateEvent | null {
    return this.emit(stage, 'failed', message, errorCode);
  }
}
