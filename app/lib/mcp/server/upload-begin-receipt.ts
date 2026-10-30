import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAtomicTempPath, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';

export class UploadBeginReceiptError extends Error {
  constructor(readonly code: 'UPLOAD_IDEMPOTENCY_CONFLICT' | 'UPLOAD_STATE_UNCONFIRMED' | 'UPLOAD_INVALID_INPUT', message: string) { super(message); }
}

type Receipt = { version: 1; fingerprint: string; phase: 'prepared' | 'ready'; uploadId?: string };

async function persistReceipt(file: string, value: Receipt): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = createAtomicTempPath(file);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Persist intent before creating a session. A crash between creation and the
 * receipt is deliberately unconfirmed: no automatic second session is allowed. */
export async function withUploadBeginReceipt<T extends { uploadId: string }>(input: {
  workspaceId: string; principalBinding: string; key?: string; request: unknown;
  create: () => Promise<T>; resume: (uploadId: string) => Promise<T>;
}): Promise<T> {
  if (input.key === undefined) return input.create();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.key)) {
    throw new UploadBeginReceiptError('UPLOAD_INVALID_INPUT', 'idempotency_key must contain 8–128 safe characters.');
  }
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const file = path.join(resolveCanvasDataRoot(), 'system', 'mcp-upload-begins', `${hash([input.principalBinding, input.workspaceId, input.key])}.json`);
  const fingerprint = hash(input.request);
  return withWorkspaceMutationLock(input.workspaceId, async () => {
    let previous: Receipt | undefined;
    try { previous = JSON.parse(await fs.readFile(file, 'utf8')) as Receipt; }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw new UploadBeginReceiptError('UPLOAD_STATE_UNCONFIRMED', 'The original upload receipt cannot be read. Inspect it before retrying.');
      }
    }
    if (previous !== undefined) {
      if (!previous || previous.version !== 1 || !/^[a-f0-9]{64}$/u.test(previous.fingerprint) || !['prepared', 'ready'].includes(previous.phase)) {
        throw new UploadBeginReceiptError('UPLOAD_STATE_UNCONFIRMED', 'The original upload receipt is invalid.');
      }
      if (previous.fingerprint !== fingerprint) throw new UploadBeginReceiptError('UPLOAD_IDEMPOTENCY_CONFLICT', 'This idempotency_key belongs to a different upload request.');
      if (previous.phase !== 'ready' || typeof previous.uploadId !== 'string') {
        throw new UploadBeginReceiptError('UPLOAD_STATE_UNCONFIRMED', 'An earlier begin may have created a session. Inspect it; do not automatically use a new key.');
      }
      return input.resume(previous.uploadId);
    }
    await persistReceipt(file, { version: 1, fingerprint, phase: 'prepared' });
    const result = await input.create();
    await persistReceipt(file, { version: 1, fingerprint, phase: 'ready', uploadId: result.uploadId });
    return result;
  });
}
