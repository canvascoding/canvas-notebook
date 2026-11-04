import 'server-only';

/** Strict native document request capture. Size is enforced while streaming;
 * the caller owns authentication, byte policy and its public error family. */
export async function readNativeDocumentRequestJson(request: Request, options: Readonly<{
  maxBytes: number; invalidRequest: () => Error; tooLarge: () => Error;
}>): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw options.invalidRequest();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > options.maxBytes) {
        void reader.cancel().catch(() => undefined); throw options.tooLarge();
      }
      chunks.push(item.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw options.invalidRequest(); }
  } finally { reader.releaseLock(); }
}
