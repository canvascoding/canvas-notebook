import type { Readable } from 'node:stream';

export async function consumeBoundedJsonLines(input: Readable, onLine: (line: string) => Promise<void>, maxLineBytes = 16 * 1024): Promise<void> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const deliver = async () => {
    const bytes = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r$/u, '');
    await onLine(line);
  };
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const fragment = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (pendingBytes + fragment.length > maxLineBytes) throw new Error('Canvas CLI update event exceeded the size limit.');
      pending.push(fragment);
      pendingBytes += fragment.length;
      if (end < 0) break;
      await deliver();
      offset = end + 1;
    }
  }
  if (pendingBytes > 0) await deliver();
}
