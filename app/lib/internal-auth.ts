import crypto from 'node:crypto';

function getInternalApiKey(): string {
  return process.env.CANVAS_INTERNAL_API_KEY?.trim() || '';
}

export function getCanvasInternalToken(): string {
  return getInternalApiKey();
}

export function isValidCanvasInternalToken(token: string | null | undefined): boolean {
  const expected = getInternalApiKey();
  if (!token || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(token, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
