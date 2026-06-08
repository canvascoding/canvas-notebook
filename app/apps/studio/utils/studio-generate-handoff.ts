import type { StudioGeneratePayload } from '../types/generation';

const STUDIO_GENERATE_HANDOFF_STORAGE_KEY = 'canvas.studio.pendingGenerateRequest';
const STUDIO_GENERATE_HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;

export interface StudioGenerateHandoffRequest {
  id: string;
  payload: StudioGeneratePayload;
}

interface StoredStudioGenerateHandoffRequest extends StudioGenerateHandoffRequest {
  createdAt: number;
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isStoredStudioGenerateHandoffRequest(value: unknown): value is StoredStudioGenerateHandoffRequest {
  if (!value || typeof value !== 'object') return false;

  const request = value as Partial<StoredStudioGenerateHandoffRequest>;
  return (
    typeof request.id === 'string' &&
    request.id.length > 0 &&
    typeof request.createdAt === 'number' &&
    Boolean(request.payload) &&
    typeof request.payload === 'object' &&
    typeof request.payload.prompt === 'string'
  );
}

export function persistStudioGenerateHandoff(request: StudioGenerateHandoffRequest) {
  const storage = getSessionStorage();
  if (!storage) return;

  const storedRequest: StoredStudioGenerateHandoffRequest = {
    ...request,
    createdAt: Date.now(),
  };

  try {
    storage.setItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY, JSON.stringify(storedRequest));
  } catch {
    // The in-memory Zustand request remains the primary handoff path.
  }
}

export function clearStudioGenerateHandoff(id?: string | null) {
  const storage = getSessionStorage();
  if (!storage) return;

  try {
    if (id) {
      const raw = storage.getItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (isStoredStudioGenerateHandoffRequest(parsed) && parsed.id !== id) return;
    }
    storage.removeItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
  } catch {
    storage.removeItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
  }
}

export function consumeStudioGenerateHandoff(expectedId?: string | null): StudioGenerateHandoffRequest | null {
  if (!expectedId) return null;

  const storage = getSessionStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredStudioGenerateHandoffRequest(parsed)) {
      storage.removeItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
      return null;
    }

    if (parsed.id !== expectedId || Date.now() - parsed.createdAt > STUDIO_GENERATE_HANDOFF_MAX_AGE_MS) {
      storage.removeItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
      return null;
    }

    storage.removeItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
    return { id: parsed.id, payload: parsed.payload };
  } catch {
    storage.removeItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
    return null;
  }
}
