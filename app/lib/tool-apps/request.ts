import 'server-only';
import { McpAccessError } from '@/app/lib/mcp/access';

/** Bound streaming bodies as well as bodies without Content-Length. */
export async function readBoundedWidgetJson(request: Request, maxBytes = 65536): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new McpAccessError('Expected JSON.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new McpAccessError('Expected a request body.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new McpAccessError('Widget request is too large.', 413); }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof McpAccessError) throw error;
    throw new McpAccessError('Invalid JSON.', 400);
  } finally { reader.releaseLock(); }
}
