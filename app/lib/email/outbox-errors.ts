import type { publicOutboxDraft } from './workspace-inbox-outbox';

export type OutboxFailureCode = 'SEND_POLICY_BLOCKED' | 'SEND_FAILED' | 'SEND_UNCERTAIN';

export class OutboxSendError extends Error {
  readonly status: number;

  constructor(readonly code: OutboxFailureCode, message: string, readonly draft: ReturnType<typeof publicOutboxDraft> | null) {
    super(message);
    this.name = 'OutboxSendError';
    this.status = code === 'SEND_POLICY_BLOCKED' ? 422 : code === 'SEND_UNCERTAIN' ? 409 : 502;
  }
}
