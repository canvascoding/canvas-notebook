const NORMAL_CLOSE_CODE = 1000;
const APPLICATION_CLOSE_CODE_MIN = 3000;
const APPLICATION_CLOSE_CODE_MAX = 4999;

export function normalizeBrowserWebSocketCloseCode(code: number): number {
  if (code === NORMAL_CLOSE_CODE) return code;
  if (Number.isInteger(code) && code >= APPLICATION_CLOSE_CODE_MIN && code <= APPLICATION_CLOSE_CODE_MAX) {
    return code;
  }
  return APPLICATION_CLOSE_CODE_MIN;
}

export function closeBrowserWebSocket(
  socket: Pick<WebSocket, 'close'>,
  code: number,
  reason: string,
): void {
  socket.close(normalizeBrowserWebSocketCloseCode(code), reason);
}
