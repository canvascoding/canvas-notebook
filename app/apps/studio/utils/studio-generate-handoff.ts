import type { StudioGeneratePayload } from '../types/generation';
import type { StudioGenerationMode } from '../types/generation';
import type { StudioPreset } from '../types/presets';
import type { ReferenceTag, StudioGenerationState } from '@/app/store/studio-generation-store';
import type { StudioVideoDuration, VideoResolution } from '@/app/lib/integrations/image-generation-constants';

const STUDIO_GENERATE_HANDOFF_STORAGE_KEY = 'canvas.studio.pendingGenerateRequest';
const STUDIO_GENERATE_HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;
const STUDIO_GENERATE_HANDOFF_VERSION = 1;

export interface StudioGenerateHandoffDraft {
  mode: StudioGenerationMode;
  aspectRatio: string;
  count: number;
  provider: string;
  model: string;
  quality: 'low' | 'medium' | 'high' | 'auto';
  outputFormat: 'png' | 'jpeg' | 'webp' | 'mp3' | 'wav';
  background: 'transparent' | 'opaque' | 'auto';
  imageSize: string;
  showMoreOptions: boolean;
  videoResolution: VideoResolution;
  videoDuration: StudioVideoDuration;
  videoGenerateAudio: boolean;
  videoWebSearch: boolean;
  videoNsfwChecker: boolean;
  isLooping: boolean;
  rawPrompt: string;
  productRefs: ReferenceTag[];
  personaRefs: ReferenceTag[];
  styleRefs: ReferenceTag[];
  presetRef: StudioPreset | null;
  fileRefs: ReferenceTag[];
  videoReferenceRefs: ReferenceTag[];
  audioReferenceRefs: ReferenceTag[];
  videoExtendSourceRef: ReferenceTag | null;
  startFramePath: string | null;
  endFramePath: string | null;
}

export interface StudioGenerateHandoffRequest {
  id: string;
  payload: StudioGeneratePayload;
  workspaceId: string;
  draft?: StudioGenerateHandoffDraft;
}

type StudioGenerateHandoffState = Pick<
  StudioGenerationState,
  | 'mode'
  | 'aspectRatio'
  | 'count'
  | 'provider'
  | 'model'
  | 'quality'
  | 'outputFormat'
  | 'background'
  | 'imageSize'
  | 'showMoreOptions'
  | 'videoResolution'
  | 'videoDuration'
  | 'videoGenerateAudio'
  | 'videoWebSearch'
  | 'videoNsfwChecker'
  | 'isLooping'
  | 'rawPrompt'
  | 'productRefs'
  | 'personaRefs'
  | 'styleRefs'
  | 'presetRef'
  | 'fileRefs'
  | 'videoReferenceRefs'
  | 'audioReferenceRefs'
  | 'videoExtendSourceRef'
  | 'startFramePath'
  | 'endFramePath'
>;

export function createStudioGenerateHandoffDraft(state: StudioGenerateHandoffState): StudioGenerateHandoffDraft {
  return {
    mode: state.mode,
    aspectRatio: state.aspectRatio,
    count: state.count,
    provider: state.provider,
    model: state.model,
    quality: state.quality,
    outputFormat: state.outputFormat,
    background: state.background,
    imageSize: state.imageSize,
    showMoreOptions: state.showMoreOptions,
    videoResolution: state.videoResolution,
    videoDuration: state.videoDuration,
    videoGenerateAudio: state.videoGenerateAudio,
    videoWebSearch: state.videoWebSearch,
    videoNsfwChecker: state.videoNsfwChecker,
    isLooping: state.isLooping,
    rawPrompt: state.rawPrompt,
    productRefs: state.productRefs.map((reference) => ({ ...reference })),
    personaRefs: state.personaRefs.map((reference) => ({ ...reference })),
    styleRefs: state.styleRefs.map((reference) => ({ ...reference })),
    presetRef: state.presetRef ? { ...state.presetRef } : null,
    fileRefs: state.fileRefs.map((reference) => ({ ...reference })),
    videoReferenceRefs: state.videoReferenceRefs.map((reference) => ({ ...reference })),
    audioReferenceRefs: state.audioReferenceRefs.map((reference) => ({ ...reference })),
    videoExtendSourceRef: state.videoExtendSourceRef ? { ...state.videoExtendSourceRef } : null,
    startFramePath: state.startFramePath,
    endFramePath: state.endFramePath,
  };
}

interface StoredStudioGenerateHandoffRequest extends StudioGenerateHandoffRequest {
  version: typeof STUDIO_GENERATE_HANDOFF_VERSION;
  createdAt: number;
  status: 'prepared' | 'claimed';
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
    request.version === STUDIO_GENERATE_HANDOFF_VERSION &&
    typeof request.createdAt === 'number' &&
    typeof request.workspaceId === 'string' &&
    request.workspaceId.length > 0 &&
    (request.status === 'prepared' || request.status === 'claimed') &&
    Boolean(request.payload) &&
    typeof request.payload === 'object' &&
    typeof request.payload.prompt === 'string'
  );
}

export function createStudioGenerateHandoffId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `studio-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function persistStudioGenerateHandoff(request: StudioGenerateHandoffRequest): boolean {
  const storage = getSessionStorage();
  if (!storage) return false;

  const storedRequest: StoredStudioGenerateHandoffRequest = {
    ...request,
    version: STUDIO_GENERATE_HANDOFF_VERSION,
    createdAt: Date.now(),
    status: 'prepared',
  };

  try {
    storage.setItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY, JSON.stringify(storedRequest));
    return true;
  } catch {
    return false;
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

export function consumeStudioGenerateHandoff(
  expectedId?: string | null,
  workspaceId?: string | null,
): StudioGenerateHandoffRequest | null {
  if (!expectedId || !workspaceId) return null;

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

    if (parsed.workspaceId !== workspaceId || parsed.status !== 'prepared') {
      return null;
    }

    storage.setItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY, JSON.stringify({
      ...parsed,
      status: 'claimed',
    } satisfies StoredStudioGenerateHandoffRequest));
    return { id: parsed.id, payload: parsed.payload, workspaceId: parsed.workspaceId };
  } catch {
    try {
      storage.removeItem(STUDIO_GENERATE_HANDOFF_STORAGE_KEY);
    } catch {
      // Storage is unavailable; the caller will not start a handoff without a claim.
    }
    return null;
  }
}
