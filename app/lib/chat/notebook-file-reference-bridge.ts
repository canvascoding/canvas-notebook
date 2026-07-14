import { normalizeChatFilePath } from './extract-file-paths';

export const NOTEBOOK_FILE_REFERENCE_MESSAGE_TYPE = 'canvas:notebook-file-reference';
export const NOTEBOOK_FILE_REFERENCE_STORAGE_KEY = 'canvas.notebookPendingFileReference';
export const NOTEBOOK_WINDOW_NAME = 'canvas-notebook';

const PENDING_REFERENCE_MAX_AGE_MS = 30_000;

export type NotebookFileReferenceRequest = {
  blockId: string | null;
  type: typeof NOTEBOOK_FILE_REFERENCE_MESSAGE_TYPE;
  heading: string | null;
  requestId: string;
  path: string;
  createdAt: number;
};

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createNotebookFileReferenceRequest(
  path: string,
  location: { blockId?: string | null; heading?: string | null } = {},
): NotebookFileReferenceRequest | null {
  const normalizedPath = normalizeChatFilePath(path);
  if (!normalizedPath) return null;

  return {
    blockId: location.blockId?.trim() || null,
    type: NOTEBOOK_FILE_REFERENCE_MESSAGE_TYPE,
    heading: location.heading?.trim() || null,
    requestId: createRequestId(),
    path: normalizedPath,
    createdAt: Date.now(),
  };
}

export function parseNotebookFileReferenceRequest(
  value: unknown,
  now: number = Date.now(),
): NotebookFileReferenceRequest | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<NotebookFileReferenceRequest>;
  if (
    candidate.type !== NOTEBOOK_FILE_REFERENCE_MESSAGE_TYPE
    || typeof candidate.requestId !== 'string'
    || !candidate.requestId.trim()
    || typeof candidate.path !== 'string'
    || typeof candidate.createdAt !== 'number'
    || !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }

  const normalizedPath = normalizeChatFilePath(candidate.path);
  const age = now - candidate.createdAt;
  if (!normalizedPath || age < -1_000 || age > PENDING_REFERENCE_MAX_AGE_MS) {
    return null;
  }

  return {
    blockId: typeof candidate.blockId === 'string' && candidate.blockId.trim()
      ? candidate.blockId.trim()
      : null,
    type: NOTEBOOK_FILE_REFERENCE_MESSAGE_TYPE,
    heading: typeof candidate.heading === 'string' && candidate.heading.trim()
      ? candidate.heading.trim()
      : null,
    requestId: candidate.requestId,
    path: normalizedPath,
    createdAt: candidate.createdAt,
  };
}

export function readPendingNotebookFileReference(): NotebookFileReferenceRequest | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(NOTEBOOK_FILE_REFERENCE_STORAGE_KEY);
    return raw ? parseNotebookFileReferenceRequest(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writePendingNotebookFileReference(request: NotebookFileReferenceRequest): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(NOTEBOOK_FILE_REFERENCE_STORAGE_KEY, JSON.stringify(request));
  } catch {
    // The postMessage/query-param path remains functional without localStorage.
  }
}

export function clearPendingNotebookFileReference(requestId: string): void {
  if (typeof window === 'undefined') return;

  try {
    const current = readPendingNotebookFileReference();
    if (!current || current.requestId === requestId) {
      window.localStorage.removeItem(NOTEBOOK_FILE_REFERENCE_STORAGE_KEY);
    }
  } catch {
    // A stale pending request expires automatically after a short interval.
  }
}

export function openOrMessageNotebookWindow(
  notebookPath: string,
  request: NotebookFileReferenceRequest,
): 'opened' | 'messaged' | 'blocked' {
  if (typeof window === 'undefined') return 'blocked';

  writePendingNotebookFileReference(request);
  const targetWindow = window.open('', NOTEBOOK_WINDOW_NAME);
  if (!targetWindow) {
    clearPendingNotebookFileReference(request.requestId);
    return 'blocked';
  }

  let canReceiveMessage = false;
  try {
    canReceiveMessage = targetWindow.location.href !== 'about:blank'
      && targetWindow.location.origin === window.location.origin
      && targetWindow.location.pathname.split('/').filter(Boolean).at(-1) === 'notebook';
  } catch {
    // A named window on another origin must be navigated back to the notebook.
  }

  if (canReceiveMessage) {
    targetWindow.postMessage(request, window.location.origin);
    targetWindow.focus();
    return 'messaged';
  }

  targetWindow.location.replace(notebookPath);
  targetWindow.focus();
  return 'opened';
}
