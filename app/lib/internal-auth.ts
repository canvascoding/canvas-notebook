import crypto from 'node:crypto';

const DEFAULT_AUTH_SECRET = 'canvas-notebook-local-dev-secret-change-me';

function getBaseSecret(): string {
  return (
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    DEFAULT_AUTH_SECRET
  );
}

export function getCanvasInternalToken(): string {
  return crypto.createHash('sha256').update(`canvas-internal:${getBaseSecret()}`).digest('hex');
}

export function isValidCanvasInternalToken(token: string | null | undefined): boolean {
  return Boolean(token) && token === getCanvasInternalToken();
}
