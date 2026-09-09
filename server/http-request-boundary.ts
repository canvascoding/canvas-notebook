import type { IncomingMessage, ServerResponse } from 'node:http';

/** Keep disconnects and rejected route promises inside the current request. */
export function handleHttpRequestSafely(
  request: IncomingMessage,
  response: ServerResponse,
  run: () => unknown | Promise<unknown>,
): void {
  const fail = (error: unknown) => {
    if (request.aborted || response.destroyed) return;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'REQUEST_FAILED';
    console.error('[HTTP] Request failed:', code);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ success: false, error: 'Request failed' }));
  };
  request.on('error', fail);
  response.on('error', fail);
  // Next's middleware body clone replaces IncomingMessage._events. Restore
  // the request listener when the response finishes/closes, before Node emits
  // a queued socket-abort error against that replaced stream.
  const restoreRequestErrorHandler = () => {
    if (!request.listeners('error').includes(fail)) request.on('error', fail);
  };
  response.once('finish', restoreRequestErrorHandler);
  response.once('close', restoreRequestErrorHandler);
  void Promise.resolve().then(run).catch(fail).finally(restoreRequestErrorHandler);
}
