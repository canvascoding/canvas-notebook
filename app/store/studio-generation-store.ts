import { create } from 'zustand';
import type { StudioGeneratePayload, StudioGenerationMode } from '@/app/apps/studio/types/generation';
import type { StudioPreset } from '@/app/apps/studio/types/presets';
import {
  BACKGROUND_OPTIONS,
  OUTPUT_FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  getAspectRatiosForProvider,
  getDefaultModelForProvider,
  getImageSizesForModel,
  getModelsForProvider,
  getProvidersForMode,
  getVideoDurationsForModel,
  getVideoResolutionsForModel,
  type VideoResolution,
  type StudioVideoDuration,
} from '@/app/lib/integrations/image-generation-constants';

const STUDIO_INSPIRATION_COLLAPSED_STORAGE_KEY = 'studio-inspiration-collapsed';
const STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY = 'studio-show-more-options';
const STUDIO_GENERATION_OPTIONS_STORAGE_KEY = 'studio-generation-options';

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

type PersistedStudioGenerationOptions = Pick<
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
>;

type StoredStudioGenerationOptions = Partial<PersistedStudioGenerationOptions>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOption<T extends readonly unknown[]>(options: T, value: unknown): value is T[number] {
  return options.includes(value as never);
}

function isGenerationMode(value: unknown): value is StudioGenerationMode {
  return value === 'image' || value === 'video' || value === 'sound';
}

function getDefaultProviderForMode(mode: StudioGenerationMode) {
  return getProvidersForMode(mode)[0]?.id ?? 'gemini';
}

function readStoredGenerationOptions(): StoredStudioGenerationOptions {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(STUDIO_GENERATION_OPTIONS_STORAGE_KEY);
    if (!raw) {
      return {
        showMoreOptions: readStoredBoolean(STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY),
      };
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const options: StoredStudioGenerationOptions = {};

    if (isGenerationMode(parsed.mode)) {
      options.mode = parsed.mode;
    }
    const mode = options.mode ?? 'image';

    const providers = getProvidersForMode(mode);
    if (typeof parsed.provider === 'string' && providers.some((provider) => provider.id === parsed.provider)) {
      options.provider = parsed.provider;
    }
    const provider = options.provider ?? getDefaultProviderForMode(mode);

    const models = getModelsForProvider(mode, provider);
    if (typeof parsed.model === 'string' && models.some((model) => model.id === parsed.model)) {
      options.model = parsed.model;
    }
    const model = options.model ?? getDefaultModelForProvider(mode, provider);

    const aspectRatios = getAspectRatiosForProvider(mode, provider);
    if (typeof parsed.aspectRatio === 'string' && aspectRatios.includes(parsed.aspectRatio as never)) {
      options.aspectRatio = parsed.aspectRatio;
    }

    if (typeof parsed.count === 'number' && Number.isInteger(parsed.count) && parsed.count >= 1 && parsed.count <= 4) {
      options.count = parsed.count;
    }

    if (hasOption(QUALITY_OPTIONS, parsed.quality)) {
      options.quality = parsed.quality;
    }

    const imageOutputFormats = OUTPUT_FORMAT_OPTIONS as readonly unknown[];
    const soundOutputFormats = ['mp3', 'wav'] as const;
    if (mode === 'sound') {
      if (hasOption(soundOutputFormats, parsed.outputFormat)) {
        options.outputFormat = model === 'lyria-3-pro-preview' ? parsed.outputFormat : 'mp3';
      }
    } else if (hasOption(imageOutputFormats, parsed.outputFormat)) {
      options.outputFormat = parsed.outputFormat as PersistedStudioGenerationOptions['outputFormat'];
    }

    if (hasOption(BACKGROUND_OPTIONS, parsed.background)) {
      options.background = parsed.background;
    }

    const imageSizes = getImageSizesForModel(model);
    if (typeof parsed.imageSize === 'string' && imageSizes.includes(parsed.imageSize)) {
      options.imageSize = parsed.imageSize;
    }

    if (typeof parsed.showMoreOptions === 'boolean') {
      options.showMoreOptions = parsed.showMoreOptions;
    } else {
      options.showMoreOptions = readStoredBoolean(STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY);
    }

    const videoResolutions = getVideoResolutionsForModel(model);
    if (typeof parsed.videoResolution === 'string' && videoResolutions.includes(parsed.videoResolution as VideoResolution)) {
      options.videoResolution = parsed.videoResolution as VideoResolution;
    }

    const videoDurations = getVideoDurationsForModel(model);
    if (typeof parsed.videoDuration === 'number' && videoDurations.includes(parsed.videoDuration as StudioVideoDuration)) {
      options.videoDuration = parsed.videoDuration as StudioVideoDuration;
    }

    if (typeof parsed.videoGenerateAudio === 'boolean') {
      options.videoGenerateAudio = parsed.videoGenerateAudio;
    }
    if (typeof parsed.videoWebSearch === 'boolean') {
      options.videoWebSearch = parsed.videoWebSearch;
    }
    if (typeof parsed.videoNsfwChecker === 'boolean') {
      options.videoNsfwChecker = parsed.videoNsfwChecker;
    }

    return options;
  } catch {
    return {
      showMoreOptions: readStoredBoolean(STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY),
    };
  }
}

function writeStoredGenerationOptions(state: PersistedStudioGenerationOptions | StudioGenerationState) {
  if (typeof window === 'undefined') return;

  try {
    const options: PersistedStudioGenerationOptions = {
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
    };
    window.localStorage.setItem(STUDIO_GENERATION_OPTIONS_STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Studio controls should still work for the current session if storage is blocked.
  }
}

function persistGenerationOptionPatch(
  state: StudioGenerationState,
  patch: Partial<PersistedStudioGenerationOptions>,
) {
  writeStoredGenerationOptions({ ...state, ...patch });
  return patch;
}

export const useStudioGenerationStore = create<StudioGenerationState>((set) => {
  const storedOptions = readStoredGenerationOptions();
  const initialMode = storedOptions.mode ?? 'image';
  const initialProvider = storedOptions.provider ?? getDefaultProviderForMode(initialMode);
  const initialModel = storedOptions.model ?? getDefaultModelForProvider(initialMode, initialProvider);
  const initialAspectRatio = storedOptions.aspectRatio ?? (initialMode === 'video' ? '16:9' : '1:1');
  const initialOutputFormat = storedOptions.outputFormat ?? (initialMode === 'sound' ? 'mp3' : 'png');

  return {
  inspirationCollapsed: readStoredBoolean(STUDIO_INSPIRATION_COLLAPSED_STORAGE_KEY),
  setInspirationCollapsed: (collapsed: boolean) => {
    writeStoredBoolean(STUDIO_INSPIRATION_COLLAPSED_STORAGE_KEY, collapsed);
    set({ inspirationCollapsed: collapsed });
  },

  mode: initialMode,
  setMode: (mode) => set((state) => (
    mode === 'sound' && state.presetRef
      ? { ...persistGenerationOptionPatch(state, { mode }), presetRef: null }
      : persistGenerationOptionPatch(state, { mode })
  )),

  aspectRatio: initialAspectRatio,
  setAspectRatio: (aspectRatio) => set((state) => persistGenerationOptionPatch(state, { aspectRatio })),

  count: storedOptions.count ?? 1,
  setCount: (count) => set((state) => persistGenerationOptionPatch(state, { count })),

  provider: initialProvider,
  setProvider: (provider) => set((state) => persistGenerationOptionPatch(state, { provider })),

  model: initialModel,
  setModel: (model) => set((state) => persistGenerationOptionPatch(state, { model })),

  quality: storedOptions.quality ?? 'auto',
  setQuality: (quality) => set((state) => persistGenerationOptionPatch(state, { quality })),

  outputFormat: initialOutputFormat,
  setOutputFormat: (outputFormat) => set((state) => persistGenerationOptionPatch(state, { outputFormat })),

  background: storedOptions.background ?? 'auto',
  setBackground: (background) => set((state) => persistGenerationOptionPatch(state, { background })),

  imageSize: storedOptions.imageSize ?? '1K',
  setImageSize: (imageSize) => set((state) => persistGenerationOptionPatch(state, { imageSize })),

  showMoreOptions: storedOptions.showMoreOptions ?? readStoredBoolean(STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY),
  setShowMoreOptions: (showMoreOptions) => {
    writeStoredBoolean(STUDIO_SHOW_MORE_OPTIONS_STORAGE_KEY, showMoreOptions);
    set((state) => persistGenerationOptionPatch(state, { showMoreOptions }));
  },

  videoResolution: storedOptions.videoResolution ?? '720p',
  setVideoResolution: (videoResolution) => set((state) => persistGenerationOptionPatch(state, { videoResolution })),

  videoDuration: storedOptions.videoDuration ?? 6,
  setVideoDuration: (videoDuration) => set((state) => persistGenerationOptionPatch(state, { videoDuration })),

  videoGenerateAudio: storedOptions.videoGenerateAudio ?? true,
  setVideoGenerateAudio: (videoGenerateAudio) => set((state) => persistGenerationOptionPatch(state, { videoGenerateAudio })),

  videoWebSearch: storedOptions.videoWebSearch ?? false,
  setVideoWebSearch: (videoWebSearch) => set((state) => persistGenerationOptionPatch(state, { videoWebSearch })),

  videoNsfwChecker: storedOptions.videoNsfwChecker ?? false,
  setVideoNsfwChecker: (videoNsfwChecker) => set((state) => persistGenerationOptionPatch(state, { videoNsfwChecker })),

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
  };
});
