export type ManualMarkdownCreateCoordinates = {
  requestId: string;
  workspaceId: string;
  targetPath: string;
};

export const MANUAL_MARKDOWN_CREATE_CODES = {
  projection_pending: 'MARKDOWN_CREATE_PROJECTION_PENDING',
  recovery_required: 'MARKDOWN_CREATE_RECOVERY_REQUIRED',
  unavailable: 'MARKDOWN_CREATE_NATIVE_UNAVAILABLE',
} as const;

export type ManualMarkdownCreatePendingStatus = keyof typeof MANUAL_MARKDOWN_CREATE_CODES;
export type ManualMarkdownCreateCompletion = ManualMarkdownCreateCoordinates & (
  | { status: 'completed' }
  | { [Status in ManualMarkdownCreatePendingStatus]: {
      status: Status;
      code: (typeof MANUAL_MARKDOWN_CREATE_CODES)[Status];
    } }[ManualMarkdownCreatePendingStatus]
);
export type ManualMarkdownCreateAttempt = ManualMarkdownCreateCoordinates & {
  status: ManualMarkdownCreatePendingStatus | 'unconfirmed';
};

export function isManualMarkdownCreatePath(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}

export function validManualMarkdownCreateCoordinates(value: unknown): value is ManualMarkdownCreateCoordinates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as ManualMarkdownCreateCoordinates;
  return typeof item.requestId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.requestId)
    && typeof item.workspaceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.workspaceId)
    && typeof item.targetPath === 'string' && item.targetPath.length <= 4096
    && !/[\\\u0000-\u001f\u007f]/u.test(item.targetPath)
    && !item.targetPath.split('/').some(segment => !segment || segment === '.' || segment === '..')
    && isManualMarkdownCreatePath(item.targetPath);
}

/** Public coordinates are lookup data. A caller must also check HTTP status and current auth. */
export function parseManualMarkdownCreateCompletion(
  value: unknown,
  expected: ManualMarkdownCreateCoordinates,
): ManualMarkdownCreateCompletion | null {
  if (!validManualMarkdownCreateCoordinates(value)) return null;
  const item = value as ManualMarkdownCreateCompletion;
  if (item.requestId !== expected.requestId || item.workspaceId !== expected.workspaceId || item.targetPath !== expected.targetPath) return null;
  if (item.status === 'completed') {
    return Object.keys(item).sort().join(',') === 'requestId,status,targetPath,workspaceId' ? { ...item } : null;
  }
  if (typeof item.status !== 'string' || !Object.hasOwn(MANUAL_MARKDOWN_CREATE_CODES, item.status)
    || Object.keys(item).sort().join(',') !== 'code,requestId,status,targetPath,workspaceId'
    || item.code !== MANUAL_MARKDOWN_CREATE_CODES[item.status]) return null;
  return { ...item };
}
