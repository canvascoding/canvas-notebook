import { create } from 'zustand';
import type { StudioGeneratePayload, StudioGenerationMode } from '@/app/apps/studio/types/generation';
import type { StudioPreset } from '@/app/apps/studio/types/presets';
import {
  GEMINI_FLASH_IMAGE_MODEL_ID,
  type VideoResolution,
  type StudioVideoDuration,
} from '@/app/lib/integrations/image-generation-constants';

const STUDIO_INSPIRATION_COLLAPSED_STORAGE_KEY = 'studio-inspiration-collapsed';
const STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY = 'studio-show-more-options';

export interface ReferenceTag {
  id: string;
  name: string;
  thumbnailPath?: string;
  status?: 'loading' | string;
  mediaKind?: 'image' | 'video' | 'audio';
  imageCount?: number;
}

export interface PendingStudioGenerateRequest {
  id: string;
  payload: StudioGeneratePayload;
}

export interface StudioGenerationState {
  inspirationCollapsed: boolean;
  setInspirationCollapsed: (collapsed: boolean) => void;

  mode: StudioGenerationMode;
  setMode: (mode: StudioGenerationMode) => void;

  aspectRatio: string;
  setAspectRatio: (ratio: string) => void;

  count: number;
  setCount: (count: number) => void;

  provider: string;
  setProvider: (provider: string) => void;

  model: string;
  setModel: (model: string) => void;

  quality: 'low' | 'medium' | 'high' | 'auto';
  setQuality: (quality: 'low' | 'medium' | 'high' | 'auto') => void;

  outputFormat: 'png' | 'jpeg' | 'webp' | 'mp3' | 'wav';
  setOutputFormat: (format: 'png' | 'jpeg' | 'webp' | 'mp3' | 'wav') => void;

  background: 'transparent' | 'opaque' | 'auto';
  setBackground: (bg: 'transparent' | 'opaque' | 'auto') => void;

  imageSize: string;
  setImageSize: (size: string) => void;

  showMoreOptions: boolean;
  setShowMoreOptions: (show: boolean) => void;

  videoResolution: VideoResolution;
  setVideoResolution: (res: VideoResolution) => void;

  videoDuration: StudioVideoDuration;
  setVideoDuration: (duration: StudioVideoDuration) => void;

  videoGenerateAudio: boolean;
  setVideoGenerateAudio: (enabled: boolean) => void;

  videoWebSearch: boolean;
  setVideoWebSearch: (enabled: boolean) => void;

  videoNsfwChecker: boolean;
  setVideoNsfwChecker: (enabled: boolean) => void;

  isLooping: boolean;
  setIsLooping: (looping: boolean) => void;

  rawPrompt: string;
  setRawPrompt: (prompt: string) => void;

  productRefs: ReferenceTag[];
  addProductRef: (product: ReferenceTag) => void;
  removeProductRef: (id: string) => void;
  setProductRefs: (refs: ReferenceTag[]) => void;

  personaRefs: ReferenceTag[];
  addPersonaRef: (persona: ReferenceTag) => void;
  removePersonaRef: (id: string) => void;
  setPersonaRefs: (refs: ReferenceTag[]) => void;

  styleRefs: ReferenceTag[];
  addStyleRef: (style: ReferenceTag) => void;
  removeStyleRef: (id: string) => void;
  setStyleRefs: (refs: ReferenceTag[]) => void;

  presetRef: StudioPreset | null;
  setPresetRef: (preset: StudioPreset | null) => void;
  removePresetRef: () => void;

  fileRefs: ReferenceTag[];
  addFileRef: (file: ReferenceTag) => void;
  removeFileRef: (id: string) => void;
  setFileRefs: (refs: ReferenceTag[]) => void;

  videoReferenceRefs: ReferenceTag[];
  addVideoReferenceRef: (file: ReferenceTag) => void;
  removeVideoReferenceRef: (id: string) => void;
  setVideoReferenceRefs: (refs: ReferenceTag[]) => void;

  audioReferenceRefs: ReferenceTag[];
  addAudioReferenceRef: (file: ReferenceTag) => void;
  removeAudioReferenceRef: (id: string) => void;
  setAudioReferenceRefs: (refs: ReferenceTag[]) => void;

  videoExtendSourceRef: ReferenceTag | null;
  setVideoExtendSourceRef: (file: ReferenceTag | null) => void;
  removeVideoExtendSourceRef: () => void;

  startFramePath: string | null;
  setStartFramePath: (path: string | null) => void;

  endFramePath: string | null;
  setEndFramePath: (path: string | null) => void;

  pendingGenerateRequest: PendingStudioGenerateRequest | null;
  queueGenerateRequest: (payload: StudioGeneratePayload) => string;
  clearGenerateRequest: (id?: string) => void;

  resetAfterGenerate: () => void;
}

function createPendingGenerateRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `studio-generate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readStoredBoolean(key: string, fallback = false) {
  if (typeof window === 'undefined') return fallback;
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return fallback;
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Keep the in-memory toggle usable when localStorage is unavailable.
  }
}

export const useStudioGenerationStore = create<StudioGenerationState>((set) => ({
  inspirationCollapsed: readStoredBoolean(STUDIO_INSPIRATION_COLLAPSED_STORAGE_KEY),
  setInspirationCollapsed: (collapsed: boolean) => {
    writeStoredBoolean(STUDIO_INSPIRATION_COLLAPSED_STORAGE_KEY, collapsed);
    set({ inspirationCollapsed: collapsed });
  },

  mode: 'image',
  setMode: (mode) => set((state) => (
    mode === 'sound' && state.presetRef ? { mode, presetRef: null } : { mode }
  )),

  aspectRatio: '1:1',
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),

  count: 1,
  setCount: (count) => set({ count }),

  provider: 'gemini',
  setProvider: (provider) => set({ provider }),

  model: GEMINI_FLASH_IMAGE_MODEL_ID,
  setModel: (model) => set({ model }),

  quality: 'auto',
  setQuality: (quality) => set({ quality }),

  outputFormat: 'png',
  setOutputFormat: (outputFormat) => set({ outputFormat }),

  background: 'auto',
  setBackground: (background) => set({ background }),

  imageSize: '1K',
  setImageSize: (imageSize) => set({ imageSize }),

  showMoreOptions: readStoredBoolean(STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY),
  setShowMoreOptions: (showMoreOptions) => {
    writeStoredBoolean(STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY, showMoreOptions);
    set({ showMoreOptions });
  },

  videoResolution: '720p',
  setVideoResolution: (videoResolution) => set({ videoResolution }),

  videoDuration: 6,
  setVideoDuration: (videoDuration) => set({ videoDuration }),

  videoGenerateAudio: true,
  setVideoGenerateAudio: (videoGenerateAudio) => set({ videoGenerateAudio }),

  videoWebSearch: false,
  setVideoWebSearch: (videoWebSearch) => set({ videoWebSearch }),

  videoNsfwChecker: false,
  setVideoNsfwChecker: (videoNsfwChecker) => set({ videoNsfwChecker }),

  isLooping: false,
  setIsLooping: (isLooping) => set({ isLooping }),

  rawPrompt: '',
  setRawPrompt: (rawPrompt) => set({ rawPrompt }),

  productRefs: [],
  addProductRef: (product) =>
    set((state) =>
      state.productRefs.some((r) => r.id === product.id)
        ? state
        : { productRefs: [...state.productRefs, product] },
    ),
  removeProductRef: (id) =>
    set((state) => ({ productRefs: state.productRefs.filter((r) => r.id !== id) })),
  setProductRefs: (productRefs) => set({ productRefs }),

  personaRefs: [],
  addPersonaRef: (persona) =>
    set((state) =>
      state.personaRefs.some((r) => r.id === persona.id)
        ? state
        : { personaRefs: [...state.personaRefs, persona] },
    ),
  removePersonaRef: (id) =>
    set((state) => ({ personaRefs: state.personaRefs.filter((r) => r.id !== id) })),
  setPersonaRefs: (personaRefs) => set({ personaRefs }),

  styleRefs: [],
  addStyleRef: (style) =>
    set((state) =>
      state.styleRefs.some((r) => r.id === style.id)
        ? state
        : { styleRefs: [...state.styleRefs, style] },
    ),
  removeStyleRef: (id) =>
    set((state) => ({ styleRefs: state.styleRefs.filter((r) => r.id !== id) })),
  setStyleRefs: (styleRefs) => set({ styleRefs }),

  presetRef: null,
  setPresetRef: (presetRef) => set((state) => (
    state.mode === 'sound' ? { presetRef: null } : { presetRef }
  )),
  removePresetRef: () => set({ presetRef: null }),

  fileRefs: [],
  addFileRef: (file) =>
    set((state) =>
      state.fileRefs.some((r) => r.id === file.id)
        ? state
        : { fileRefs: [...state.fileRefs, file] },
    ),
  removeFileRef: (id) =>
    set((state) => ({ fileRefs: state.fileRefs.filter((r) => r.id !== id) })),
  setFileRefs: (fileRefs) => set({ fileRefs }),

  videoReferenceRefs: [],
  addVideoReferenceRef: (file) =>
    set((state) =>
      state.videoReferenceRefs.some((r) => r.id === file.id)
        ? state
        : { videoReferenceRefs: [...state.videoReferenceRefs, file] },
    ),
  removeVideoReferenceRef: (id) =>
    set((state) => ({ videoReferenceRefs: state.videoReferenceRefs.filter((r) => r.id !== id) })),
  setVideoReferenceRefs: (videoReferenceRefs) => set({ videoReferenceRefs }),

  audioReferenceRefs: [],
  addAudioReferenceRef: (file) =>
    set((state) =>
      state.audioReferenceRefs.some((r) => r.id === file.id)
        ? state
        : { audioReferenceRefs: [...state.audioReferenceRefs, file] },
    ),
  removeAudioReferenceRef: (id) =>
    set((state) => ({ audioReferenceRefs: state.audioReferenceRefs.filter((r) => r.id !== id) })),
  setAudioReferenceRefs: (audioReferenceRefs) => set({ audioReferenceRefs }),

  videoExtendSourceRef: null,
  setVideoExtendSourceRef: (videoExtendSourceRef) => set({ videoExtendSourceRef }),
  removeVideoExtendSourceRef: () => set({ videoExtendSourceRef: null }),

  startFramePath: null,
  setStartFramePath: (startFramePath) => set({ startFramePath }),

  endFramePath: null,
  setEndFramePath: (endFramePath) => set({ endFramePath }),

  pendingGenerateRequest: null,
  queueGenerateRequest: (payload) => {
    const id = createPendingGenerateRequestId();
    set({ pendingGenerateRequest: { id, payload } });
    return id;
  },
  clearGenerateRequest: (id) =>
    set((state) => {
      if (id && state.pendingGenerateRequest?.id !== id) return state;
      return { pendingGenerateRequest: null };
    }),

  resetAfterGenerate: () =>
    set({
      rawPrompt: '',
      fileRefs: [],
      videoReferenceRefs: [],
      audioReferenceRefs: [],
      videoExtendSourceRef: null,
      startFramePath: null,
      endFramePath: null,
    }),
}));
