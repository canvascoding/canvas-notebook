import { NextResponse } from 'next/server';

/** Bounds streamed bodies too; Content-Length alone is not an enforceable cap. */
export async function readBoundedJson(request: Request, maxBytes = 16 * 1024): Promise<
  { body: unknown; response: null } | { body: null; response: NextResponse }
> {
  const tooLarge = () => ({ body: null, response: NextResponse.json({ success: false, error: 'Request body is too large' }, { status: 413 }) });
  if (Number(request.headers.get('content-length')) > maxBytes) return tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return { body: null, response: null };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      chunks.push(next.value);
    }
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), response: null };
  } catch {
    return { body: null, response: null };
  } finally {
    reader.releaseLock();
  }
}
