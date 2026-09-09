import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { resolveMcpHttpTarget } from '@/app/lib/mcp/network-policy';

export type McpHttpOptions = {
  purpose?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  streamingIdleTimeoutMs?: number;
};

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readRequestBody(request: Request, maxBytes: number, signal: AbortSignal): Promise<Buffer | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('MCP HTTP request is too large.');
      chunks.push(chunk.value);
    }
  } catch (error) {
    // A producer's cancel hook may itself hang; cancellation must not delay rejection.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** A bounded, DNS-pinned fetch shared by the MCP transport and OAuth discovery. */
export async function fetchMcpHttp(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: McpHttpOptions = {},
): Promise<Response> {
  const request = new Request(input, init);
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let timeout: ReturnType<typeof setTimeout>;
  const resetTimeout = (duration: number) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(new Error('MCP HTTP request timed out.')), duration);
    timeout.unref();
  };
  resetTimeout(options.timeoutMs ?? 30_000);
  const cleanup = () => {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
  };
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  try {
    const body = await readRequestBody(request, maxBytes, controller.signal);
    let url = new URL(request.url);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      controller.signal.throwIfAborted();
      const target = await abortable(resolveMcpHttpTarget(url.toString(), options.purpose ?? 'MCP HTTP URL'), controller.signal);
      controller.signal.throwIfAborted();
      const headers = new Headers(request.headers);
      // Do not allow caller-controlled framing, Host or cookies on backend requests.
      for (const name of ['host', 'connection', 'transfer-encoding', 'content-length', 'cookie']) headers.delete(name);
      headers.set('host', url.host);
      headers.set('accept-encoding', 'identity');
      if (body) headers.set('content-length', String(body.length));
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const send = url.protocol === 'https:' ? https.request : http.request;
        const hostname = url.hostname.replace(/^\[|\]$/gu, '');
        const outgoing = send({
          protocol: url.protocol,
          hostname: target.address,
          family: target.family,
          port: url.port || undefined,
          path: url.pathname + url.search,
          servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
          method: request.method,
          headers: Object.fromEntries(headers),
          signal: controller.signal,
          // A request owns its socket; connections cannot reuse an old DNS decision.
          agent: false,
        }, resolve);
        outgoing.once('error', reject);
        outgoing.end(body);
      });
      const status = response.statusCode ?? 502;
      if ([301, 302, 303, 307, 308].includes(status) && request.redirect !== 'manual') {
        response.destroy();
        if (!['GET', 'HEAD'].includes(request.method) || request.redirect === 'error') {
          throw new Error('MCP HTTP redirects are not allowed for this request.');
        }
        const location = response.headers.location;
        if (!location || hop === maxRedirects) throw new Error('MCP HTTP redirect limit exceeded or location missing.');
        const next = new URL(location, url);
        if (next.origin !== url.origin && Array.from(request.headers.keys()).some((name) => !['accept', 'accept-language', 'user-agent'].includes(name))) {
          throw new Error('MCP HTTP cross-origin redirect with credentials or custom headers is blocked.');
        }
        url = next;
        continue;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy();
        throw new Error('MCP HTTP response is too large.');
      }
      const streaming = responseHeaders.get('content-type')?.split(';')[0].trim() === 'text/event-stream';
      if (streaming) resetTimeout(options.streamingIdleTimeoutMs ?? 300_000);
      response.once('end', cleanup);
      response.once('close', cleanup);
      const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status);
      if (noBody) {
        response.destroy();
        cleanup();
        return new Response(null, { status, headers: responseHeaders });
      }
      const iterator = response[Symbol.asyncIterator]();
      let bytes = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const chunk = await iterator.next();
            if (chunk.done) {
              cleanup();
              streamController.close();
              return;
            }
            bytes += chunk.value.length;
            if (bytes > maxBytes) throw new Error('MCP HTTP response is too large.');
            if (streaming) resetTimeout(options.streamingIdleTimeoutMs ?? 300_000);
            streamController.enqueue(new Uint8Array(chunk.value));
          } catch (error) {
            response.destroy();
            cleanup();
            streamController.error(error);
          }
        },
        cancel() {
          response.destroy();
          cleanup();
        },
      });
      const result = new Response(stream, { status, headers: responseHeaders });
      Object.defineProperty(result, 'url', { value: url.toString() });
      return result;
    }
    throw new Error('MCP HTTP redirect limit exceeded.');
  } catch (error) {
    cleanup();
    throw error;
  }
}
