import 'server-only';

type RequestBodySource = Pick<Request, 'body' | 'headers'>;

/**
 * Returns whether a request carries any payload bytes without buffering an
 * unknown-size body. Some proxies represent an empty POST as an empty stream
 * instead of a null body.
 */
export async function hasRequestPayload(request: RequestBodySource): Promise<boolean> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    return contentLength !== '0';
  }

  const body = request.body;
  if (body === null) return false;

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.byteLength > 0) {
        await reader.cancel().catch(() => undefined);
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
