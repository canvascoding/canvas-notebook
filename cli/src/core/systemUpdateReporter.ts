import { randomUUID } from 'node:crypto';

import {
  SYSTEM_UPDATE_CONTRACT_VERSION,
  validateSystemUpdateEvent,
  type SystemUpdateErrorCode,
  type SystemUpdateEvent,
  type SystemUpdateStage,
  type SystemUpdateStageStatus,
} from './systemUpdateContract';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SystemUpdateEventReporterOptions {
  enabled: boolean;
  operationId?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

export class SystemUpdateEventReporter {
  readonly operationId: string;
  private sequence = 0;
  private readonly enabled: boolean;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: SystemUpdateEventReporterOptions) {
    const operationId = options.operationId || randomUUID();
    if (!UUID_PATTERN.test(operationId)) throw new Error('--operation-id must be a UUID.');
    this.operationId = operationId;
    this.enabled = options.enabled;
    this.write = options.write || ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now || (() => new Date());
  }

  emit(
    stage: SystemUpdateStage,
    status: SystemUpdateStageStatus,
    message: string,
    errorCode?: SystemUpdateErrorCode,
  ): SystemUpdateEvent | null {
    if (!this.enabled) return null;
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
    };
    const validated = validateSystemUpdateEvent(event);
    if (!validated.ok) throw new Error(validated.error);
    this.write(JSON.stringify(validated.value));
    return validated.value;
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
