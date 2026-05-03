import { create } from 'zustand';
import type { StudioGenerationMode } from '@/app/apps/studio/types/generation';
import type { StudioPreset } from '@/app/apps/studio/types/presets';
import type { VideoResolution, StudioVideoDuration } from '@/app/lib/integrations/image-generation-constants';

export interface ReferenceTag {
  id: string;
  name: string;
  thumbnailPath?: string;
  status?: 'loading' | string;
}

interface StudioGenerationState {
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

  outputFormat: 'png' | 'jpeg' | 'webp';
  setOutputFormat: (format: 'png' | 'jpeg' | 'webp') => void;

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

  startFramePath: string | null;
  setStartFramePath: (path: string | null) => void;

  endFramePath: string | null;
  setEndFramePath: (path: string | null) => void;

  resetAfterGenerate: () => void;
}

export const useStudioGenerationStore = create<StudioGenerationState>((set) => ({
  inspirationCollapsed: typeof window !== 'undefined' ? window.localStorage.getItem('studio-inspiration-collapsed') === 'true' : false,
  setInspirationCollapsed: (collapsed: boolean) => {
    if (typeof window !== 'undefined') window.localStorage.setItem('studio-inspiration-collapsed', String(collapsed));
    set({ inspirationCollapsed: collapsed });
  },

  mode: 'image',
  setMode: (mode) => set({ mode }),

  aspectRatio: '1:1',
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),

  count: 1,
  setCount: (count) => set({ count }),

  provider: 'gemini',
  setProvider: (provider) => set({ provider }),

  model: 'gemini-3.1-flash-image-preview',
  setModel: (model) => set({ model }),

  quality: 'auto',
  setQuality: (quality) => set({ quality }),

  outputFormat: 'png',
  setOutputFormat: (outputFormat) => set({ outputFormat }),

  background: 'auto',
  setBackground: (background) => set({ background }),

  imageSize: '1K',
  setImageSize: (imageSize) => set({ imageSize }),

  showMoreOptions: false,
  setShowMoreOptions: (showMoreOptions) => set({ showMoreOptions }),

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
  setPresetRef: (presetRef) => set({ presetRef }),
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

  startFramePath: null,
  setStartFramePath: (startFramePath) => set({ startFramePath }),

  endFramePath: null,
  setEndFramePath: (endFramePath) => set({ endFramePath }),

  resetAfterGenerate: () =>
    set({
      rawPrompt: '',
      fileRefs: [],
      startFramePath: null,
      endFramePath: null,
    }),
}));