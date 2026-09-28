import net from 'node:net';
import path from 'node:path';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const GENERIC_FAILURE = 'Local agent tool call failed.';

function failure(): Error {
  return new Error(GENERIC_FAILURE);
}

/** Exchanges one JSONL request and response over an absolute Unix-domain socket path. */
export async function runLocalAgentTool(
  input: unknown,
  socketPath: string,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!path.isAbsolute(socketPath) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw failure();
  }

  let request: Buffer;
  try {
    request = Buffer.from(`${JSON.stringify({ input })}\n`, 'utf8');
  } catch {
    throw failure();
  }
  if (request.byteLength > MAX_REQUEST_BYTES) throw failure();

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => finishFailure(), timeoutMs);

    const finishFailure = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(failure());
    };
    const finishSuccess = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    socket.once('connect', () => {
      socket.write(request, (error) => {
        if (error) finishFailure();
      });
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      response = Buffer.concat([response, chunk]);
      if (response.byteLength > MAX_RESPONSE_BYTES) {
        finishFailure();
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== response.byteLength - 1) {
        finishFailure();
        return;
      }

      let record: unknown;
      try {
        const end = response[newline - 1] === 0x0d ? newline - 1 : newline;
        record = JSON.parse(response.subarray(0, end).toString('utf8')) as unknown;
      } catch {
        finishFailure();
        return;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        finishFailure();
        return;
      }
      const keys = Object.keys(record);
      if (keys.length !== 1) {
        finishFailure();
        return;
      }
      if (keys[0] === 'error' && typeof (record as { error?: unknown }).error === 'string') {
        finishFailure();
        return;
      }
      if (keys[0] !== 'result') {
        finishFailure();
        return;
      }
      finishSuccess((record as { result: unknown }).result);
    });
    socket.once('error', finishFailure);
    socket.once('end', finishFailure);
    socket.once('close', finishFailure);
  });
}
