/** This budget belongs to one identity-bound refresh window, including its
 * location lookup and admission rejoin. Hints cannot replenish an open window. */
export type DocumentLocationRetryBudget = { attempts: number; deadline: number; nextAt: number };

export class CollaborationDocumentLocationRequestError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, options: { code: string; status?: number; retryable?: boolean }) {
    super(message);
    this.name = 'CollaborationDocumentLocationRequestError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable === true;
  }
}

export function createDocumentLocationRetryBudget(now = Date.now()): DocumentLocationRetryBudget {
  return { attempts: 0, deadline: now + 20_000, nextAt: now };
}

/** Session failures require the server's clean, pre-owner read marker. A status
 * alone never proves that rollback, connection close and transport disposal ran. */
export function isRetryableDocumentLocationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const status = Object.getOwnPropertyDescriptor(error, 'status')?.value;
  if (Object.getOwnPropertyDescriptor(error, 'retryable')?.value !== true) return false;
  if (status === 409 && (code === 'PRINCIPAL_BUSY' || code === 'NATIVE_SESSION_BUSY')) return true;
  return error instanceof CollaborationDocumentLocationRequestError
    && ((status === 503 && (code === 'FILE_MUTATION_LOCK_TIMEOUT' || code === 'FILE_MUTATION_LOCK_BUSY'))
      || (status === undefined && (code === 'LOCATION_NETWORK_ERROR' || code === 'LOCATION_TIMEOUT')));
}

export function nextDocumentLocationRetryDelay(budget: DocumentLocationRetryBudget, error: unknown, now = Date.now()): number | null {
  if (!isRetryableDocumentLocationFailure(error) || budget.attempts >= 6 || now >= budget.deadline) return null;
  const delay = [1000, 1500, 2500, 4000, 6000][Math.max(0, budget.attempts - 1)];
  if (delay === undefined || now + delay >= budget.deadline) return null;
  budget.nextAt = now + delay;
  return delay;
}
