export interface TerminalTransportConfig {
  socketPath: string;
  tcpHost: string;
  tcpPort: number;
  useUnixSocket: boolean;
}

interface TerminalEnv extends Record<string, string | undefined> {
  CANVAS_RUNTIME_ENV?: string;
  CANVAS_TERMINAL_PORT?: string;
  CANVAS_TERMINAL_SOCKET?: string;
  CANVAS_TERMINAL_USE_UNIX_SOCKET?: string;
}

const DEFAULT_SOCKET_PATH = '/tmp/canvas-terminal.sock';
const DEFAULT_TCP_HOST = '127.0.0.1';
const DEFAULT_TCP_PORT = 3457;

function parseBooleanFlag(value: string | undefined): boolean | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return null;
}

function parseTcpPort(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_TCP_PORT;
}

export function resolveTerminalTransport(env: TerminalEnv = process.env): TerminalTransportConfig {
  const explicitUnixSocket = parseBooleanFlag(env.CANVAS_TERMINAL_USE_UNIX_SOCKET);
  const useUnixSocket =
    explicitUnixSocket !== null
      ? explicitUnixSocket
      : env.CANVAS_RUNTIME_ENV === 'docker';

  return {
    socketPath: env.CANVAS_TERMINAL_SOCKET || DEFAULT_SOCKET_PATH,
    tcpHost: DEFAULT_TCP_HOST,
    tcpPort: parseTcpPort(env.CANVAS_TERMINAL_PORT),
    useUnixSocket,
  };
}
