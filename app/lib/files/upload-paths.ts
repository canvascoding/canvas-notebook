import path from 'path';

function sanitizeUploadPathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._\-\s()]/g, '_');
}

export function sanitizeWorkspaceUploadPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map((segment) => sanitizeUploadPathSegment(path.posix.basename(segment)))
    .filter(Boolean);
  return segments.join('/');
}
