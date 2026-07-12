import 'server-only';

export const MAX_EMAIL_AI_REQUEST_BODY_BYTES = 1024 * 1024;

type EmailAiRequestBodyErrorCode = 'invalid_json' | 'invalid_shape' | 'too_large';

export class EmailAiRequestBodyError extends Error {
  readonly status: 400 | 413;
  readonly code: EmailAiRequestBodyErrorCode;

  constructor(code: EmailAiRequestBodyErrorCode, message: string) {
    super(message);
    this.name = 'EmailAiRequestBodyError';
    this.code = code;
    this.status = code === 'too_large' ? 413 : 400;
  }
}

function advertisedContentLength(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The size error remains authoritative if the peer has already closed.
  }
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const advertisedLength = advertisedContentLength(request);
  if (advertisedLength !== null && advertisedLength > maxBytes) {
    throw new EmailAiRequestBodyError(
      'too_large',
      `Email AI request body exceeds the ${maxBytes}-byte limit.`,
    );
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    if (value.byteLength > maxBytes - totalBytes) {
      await cancelReader(reader);
      throw new EmailAiRequestBodyError(
        'too_large',
        `Email AI request body exceeds the ${maxBytes}-byte limit.`,
      );
    }

    chunks.push(value);
    totalBytes += value.byteLength;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readEmailAiJsonObject(
  request: Request,
  maxBytes = MAX_EMAIL_AI_REQUEST_BODY_BYTES,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Email AI request body limit must be a positive integer.');
  }

  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) return {};

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new EmailAiRequestBodyError('invalid_json', 'Email AI request body must contain valid JSON.');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EmailAiRequestBodyError('invalid_shape', 'Email AI request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

export function emailAiRequestBodyErrorStatus(error: unknown): 400 | 413 | null {
  return error instanceof EmailAiRequestBodyError ? error.status : null;
}
