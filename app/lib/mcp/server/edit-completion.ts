import 'server-only';

/** The write is already durable; only its read-back is waiting for room release. */
export class DirectMcpEditCompletionBusyError extends Error {
  readonly code = 'MCP_EDIT_COMPLETION_BUSY';
  constructor(readonly operationId: string, readonly idempotencyKey: string) {
    super('The edit is durably saved, but its completion read is busy. Retry only with the original idempotency_key.');
    this.name = 'DirectMcpEditCompletionBusyError';
  }
}

/** Never replay a write or bypass ownership. Retry only a bounded read after a
 * confirmed durable operation, with fresh authority before every observation. */
export async function readDirectMcpEditCompletion<T>(input: {
  operationId: string;
  idempotencyKey: string;
  assertCurrent: () => Promise<unknown>;
  read: () => Promise<T>;
}): Promise<T> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    await input.assertCurrent();
    let result: T;
    try {
      result = await input.read();
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ROOM_OWNER_BUSY') throw error;
      if (Date.now() >= deadline) throw new DirectMcpEditCompletionBusyError(input.operationId, input.idempotencyKey);
      await new Promise(resolve => setTimeout(resolve, 50));
      continue;
    }
    await input.assertCurrent();
    return result;
  }
}
