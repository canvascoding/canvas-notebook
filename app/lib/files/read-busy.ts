/** The read endpoint alone publishes this temporary, retryable availability contract. */
export const FILE_READ_BUSY_CODE = 'ROOM_OWNER_BUSY';

/** Server-reader and Next bundles may contain different error class identities. */
export function isFileReadBusyError(error: unknown): error is Error & { code: typeof FILE_READ_BUSY_CODE } {
  return error instanceof Error && error.name === 'CollaborationRoomOwnerError'
    && 'code' in error && error.code === FILE_READ_BUSY_CODE;
}

async function isBusyResponse(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const payload: unknown = await response.clone().json();
    return Boolean(payload && typeof payload === 'object' && 'success' in payload && payload.success === false
      && 'code' in payload && payload.code === FILE_READ_BUSY_CODE);
  } catch { return false; }
}

function waitForReadRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Share this inside the document query, not per consumer. Every retry is a new
 * HTTP request after the preceding read fence has closed. Two seconds bounds
 * further starts after the first Busy, not the duration of an in-flight fetch. */
export async function revalidateBusyFileRead(request: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  const delays = [100, 250, 500] as const;
  let deadline: number | undefined;
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    const response = await request();
    const receivedAt = performance.now();
    if (!await isBusyResponse(response)) return response;
    deadline ??= receivedAt + 2_000;
    const delay = delays[retry];
    if (delay === undefined || performance.now() + delay >= deadline) return response;
    await waitForReadRetry(delay, signal);
    signal.throwIfAborted();
    if (performance.now() >= deadline) return response;
  }
}
