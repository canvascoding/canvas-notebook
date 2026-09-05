import { closeBrowserWebSocket } from './client-websocket';

export type BrowserConnectionAttempt = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  attach: (socket: WebSocket) => boolean;
  ready: () => void;
  close: (code?: number, reason?: string) => void;
};

type PendingConnection = {
  controller: AbortController;
  socket: WebSocket | null;
  timeout: ReturnType<typeof setTimeout> | null;
};

export class BrowserViewConnection {
  private current: PendingConnection | null = null;

  begin(onTimeout: () => void, timeoutMs = 15_000): BrowserConnectionAttempt {
    this.close();
    const pending: PendingConnection = {
      controller: new AbortController(), socket: null, timeout: null,
    };
    this.current = pending;
    const isCurrent = () => this.current === pending;
    const close = (code = 1000, reason = 'View closed') => {
      if (isCurrent()) this.close(code, reason);
    };
    pending.timeout = setTimeout(() => {
      if (!isCurrent()) return;
      close(4000, 'Connection timeout');
      onTimeout();
    }, timeoutMs);
    return {
      signal: pending.controller.signal,
      isCurrent,
      attach: (socket) => {
        if (!isCurrent()) {
          closeBrowserWebSocket(socket, 1000, 'Superseded view');
          return false;
        }
        pending.socket = socket;
        return true;
      },
      ready: () => {
        if (!isCurrent()) return;
        if (pending.timeout !== null) clearTimeout(pending.timeout);
        pending.timeout = null;
      },
      close,
    };
  }

  close(code = 1000, reason = 'View closed'): void {
    const pending = this.current;
    this.current = null;
    if (!pending) return;
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.controller.abort();
    if (pending.socket && pending.socket.readyState < 2) {
      closeBrowserWebSocket(pending.socket, code, reason);
    }
  }

  send(message: Record<string, unknown>): boolean {
    const socket = this.current?.socket;
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
}
