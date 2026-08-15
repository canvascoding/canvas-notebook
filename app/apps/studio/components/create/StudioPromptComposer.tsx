'use client';

import { useMemo } from 'react';

import type { StudioGenerationState, ReferenceTag } from '@/app/store/studio-generation-store';
import {
  getAspectRatiosForProvider,
  getDefaultModelForProvider,
  getImageSizesForModel,
  getVideoDurationsForModel,
  getVideoResolutionsForModel,
  type StudioVideoDuration,
  type VideoResolution,
} from '@/app/lib/integrations/image-generation-constants';
import type { StudioGenerationMode } from '../../types/generation';
import type { StudioProduct, StudioPersona, StudioStyle } from '../../types/models';
import type { StudioPreset } from '../../types/presets';
import { getFileReferenceLimitForMode, getVideoImageReferenceBudget } from '../../utils/video-reference-limits';
import { ControlBar } from './ControlBar';
import { PromptBar } from './PromptBar';

type StudioReferenceModel = {
  id: string;
  name: string;
  thumbnailPath?: string | null;
  imageCount?: number;
  images?: { filePath?: string | null }[];
};

function getModelReferenceImageCount(model: StudioReferenceModel): number {
  if (typeof model.imageCount === 'number' && Number.isFinite(model.imageCount)) {
    return Math.max(0, Math.floor(model.imageCount));
  }

  if (Array.isArray(model.images) && model.images.length > 0) {
    return model.images.filter((image) => Boolean(image.filePath)).length;
  }

  return model.thumbnailPath ? 1 : 0;
}

function createModelReferenceTag(model: StudioReferenceModel): ReferenceTag {
  return {
    id: model.id,
    name: model.name,
    thumbnailPath: model.thumbnailPath ?? undefined,
    imageCount: getModelReferenceImageCount(model),
  };
}

function upsertReferenceTag(refs: ReferenceTag[], ref: ReferenceTag): ReferenceTag[] {
  if (!refs.some((item) => item.id === ref.id)) {
    return [...refs, ref];
  }

  return refs.map((item) => (item.id === ref.id ? { ...item, ...ref } : item));
}

export function canGenerateWithStudioState(state: Pick<
  StudioGenerationState,
  | 'audioReferenceRefs'
  | 'fileRefs'
  | 'mode'
  | 'personaRefs'
  | 'presetRef'
  | 'productRefs'
  | 'provider'
  | 'rawPrompt'
  | 'videoExtendSourceRef'
  | 'videoReferenceRefs'
>): boolean {
  const hasVeoExtendSource = state.mode === 'video'
    && state.provider === 'veo'
    && state.videoExtendSourceRef !== null;

  return state.rawPrompt.trim().length > 0
    || state.productRefs.length > 0
    || state.personaRefs.length > 0
    || state.presetRef !== null
    || state.fileRefs.length > 0
    || state.videoReferenceRefs.length > 0
    || state.audioReferenceRefs.length > 0
    || hasVeoExtendSource;
}

interface StudioPromptComposerProps {
  state: StudioGenerationState;
  products: StudioProduct[];
  personas: StudioPersona[];
  styles: StudioStyle[];
  presets: StudioPreset[];
  productsLoading: boolean;
  personasLoading: boolean;
  stylesLoading: boolean;
  fetchProducts: () => Promise<void>;
  fetchPersonas: () => Promise<void>;
  fetchStyles: () => Promise<void>;
  onGenerate: () => void;
  isGenerating: boolean;
  canGenerate: boolean;
  onPasteImage?: (file: File) => void;
}

export function StudioPromptComposer({
  state,
  products,
  personas,
  styles,
  presets,
  productsLoading,
  personasLoading,
  stylesLoading,
  fetchProducts,
  fetchPersonas,
  fetchStyles,
  onGenerate,
  isGenerating,
  canGenerate,
  onPasteImage,
}: StudioPromptComposerProps) {
  const trimFileRefsToVideoBudget = (overrides: {
    mode?: StudioGenerationMode;
    provider?: string;
    productRefs?: ReferenceTag[];
    personaRefs?: ReferenceTag[];
    styleRefs?: ReferenceTag[];
    fileRefs?: ReferenceTag[];
  } = {}) => {
    const mode = overrides.mode ?? state.mode;
    const provider = overrides.provider ?? state.provider;
    if (mode !== 'video') return;

    const fileRefs = overrides.fileRefs ?? state.fileRefs;
    const budget = getVideoImageReferenceBudget({
      mode,
      provider,
      productRefs: overrides.productRefs ?? state.productRefs,
      personaRefs: overrides.personaRefs ?? state.personaRefs,
      styleRefs: overrides.styleRefs ?? state.styleRefs,
      fileRefs,
    });
    const trimmed = fileRefs.slice(0, budget.acceptedFileCount);

    if (trimmed.length !== fileRefs.length) {
      state.setFileRefs(trimmed);
    }
  };

  const promptBarValue = useMemo(() => ({
    rawPrompt: state.rawPrompt,
    productRefs: state.productRefs,
    personaRefs: state.personaRefs,
    styleRefs: state.styleRefs,
    presetRef: state.presetRef,
    fileRefs: state.fileRefs,
  }), [state.fileRefs, state.personaRefs, state.presetRef, state.productRefs, state.rawPrompt, state.styleRefs]);

  return (
    <>
      <PromptBar
        value={promptBarValue}
        mode={state.mode}
        provider={state.provider}
        videoReferenceRefs={state.videoReferenceRefs}
        audioReferenceRefs={state.audioReferenceRefs}
        videoExtendSourceRef={state.videoExtendSourceRef}
        products={products}
        personas={personas}
        styles={styles}
        productsLoading={productsLoading}
        personasLoading={personasLoading}
        stylesLoading={stylesLoading}
        presets={presets}
        fetchProducts={fetchProducts}
        fetchPersonas={fetchPersonas}
        fetchStyles={fetchStyles}
        onRawPromptChange={state.setRawPrompt}
        onProductAdd={(product) => {
          const productRefs = upsertReferenceTag(state.productRefs, createModelReferenceTag(product));
          state.setProductRefs(productRefs);
          trimFileRefsToVideoBudget({ productRefs });
        }}
        onPersonaAdd={(persona) => {
          const personaRefs = upsertReferenceTag(state.personaRefs, createModelReferenceTag(persona));
          state.setPersonaRefs(personaRefs);
          trimFileRefsToVideoBudget({ personaRefs });
        }}
        onStyleAdd={(style) => {
          const styleRefs = upsertReferenceTag(state.styleRefs, createModelReferenceTag(style));
          state.setStyleRefs(styleRefs);
          trimFileRefsToVideoBudget({ styleRefs });
        }}
        onPresetSelect={state.setPresetRef}
        onReferenceRemove={(type, id) => {
          if (type === 'product') state.removeProductRef(id);
          else if (type === 'persona') state.removePersonaRef(id);
          else if (type === 'style') state.removeStyleRef(id);
          else if (type === 'file') state.removeFileRef(id);
          else if (type === 'videoReference') state.removeVideoReferenceRef(id);
          else if (type === 'audioReference') state.removeAudioReferenceRef(id);
          else if (type === 'videoExtendSource') state.removeVideoExtendSourceRef();
          else if (type === 'preset') state.removePresetRef();
        }}
        onFileAdd={(paths) => {
          if (state.mode === 'video') {
            const budget = getVideoImageReferenceBudget({
              mode: state.mode,
              provider: state.provider,
              productRefs: state.productRefs,
              personaRefs: state.personaRefs,
              styleRefs: state.styleRefs,
              fileRefs: state.fileRefs,
            });
            for (const path of paths.slice(0, budget.remaining)) {
              state.addFileRef({ id: path, name: path.split('/').pop() || path, thumbnailPath: path });
            }
            return;
          }

          const limit = getFileReferenceLimitForMode(state.mode, state.provider);
          const allowedPaths = typeof limit === 'number'
            ? paths.slice(0, Math.max(limit - state.fileRefs.length, 0))
            : paths;
          for (const path of allowedPaths) {
            state.addFileRef({ id: path, name: path.split('/').pop() || path, thumbnailPath: path });
          }
        }}
        onVideoReferenceAdd={(paths) => {
          for (const path of paths) {
            state.addVideoReferenceRef({ id: path, name: path.split('/').pop() || path, mediaKind: 'video' });
          }
        }}
        onAudioReferenceAdd={(paths) => {
          for (const path of paths) {
            state.addAudioReferenceRef({ id: path, name: path.split('/').pop() || path, mediaKind: 'audio' });
          }
        }}
        onVideoExtendSourceAdd={(paths) => {
          const path = paths[0];
          if (path) {
            state.setVideoExtendSourceRef({ id: path, name: path.split('/').pop() || path, mediaKind: 'video' });
          }
        }}
        onPasteImage={onPasteImage}
      />

      <ControlBar
        mode={state.mode}
        onModeChange={(nextMode) => {
          state.setMode(nextMode);
          state.setCount(1);
          if (nextMode === 'video') {
            state.setProvider('veo');
            state.setModel(getDefaultModelForProvider('video', 'veo'));
            state.setAspectRatio('16:9');
            state.setVideoResolution('720p');
            state.setVideoDuration(6);
            state.setVideoGenerateAudio(true);
            state.setVideoWebSearch(false);
            state.setVideoNsfwChecker(false);
            trimFileRefsToVideoBudget({ mode: 'video', provider: 'veo' });
          } else if (nextMode === 'sound') {
            state.setProvider('gemini');
            state.setModel(getDefaultModelForProvider('sound', 'gemini'));
            state.setOutputFormat('mp3');
          } else {
            state.setProvider('gemini');
            state.setModel(getDefaultModelForProvider('image', 'gemini'));
            if (state.outputFormat === 'mp3' || state.outputFormat === 'wav') {
              state.setOutputFormat('png');
            }
            const validRatios = getAspectRatiosForProvider('image', 'gemini');
            if (!validRatios.includes(state.aspectRatio as never)) {
              state.setAspectRatio('1:1');
            }
          }
        }}
        presets={presets}
        selectedPreset={state.presetRef}
        onPresetChange={state.setPresetRef}
        aspectRatio={state.aspectRatio}
        onAspectRatioChange={state.setAspectRatio}
        count={state.count}
        onCountChange={state.setCount}
        provider={state.provider}
        onProviderChange={(nextProvider) => {
          state.setProvider(nextProvider);
          state.setModel(getDefaultModelForProvider(state.mode, nextProvider));
          const validRatios = getAspectRatiosForProvider(state.mode, nextProvider);
          if (!validRatios.includes(state.aspectRatio as never)) {
            state.setAspectRatio(state.mode === 'video' ? '16:9' : '1:1');
          }
          if (state.mode === 'video') {
            const nextModel = getDefaultModelForProvider(state.mode, nextProvider);
            const validRes = getVideoResolutionsForModel(nextModel);
            state.setVideoResolution(validRes.includes(state.videoResolution) ? state.videoResolution : validRes[0] as VideoResolution);
            const validDur = getVideoDurationsForModel(nextModel);
            state.setVideoDuration(validDur.includes(state.videoDuration) ? state.videoDuration : validDur.includes(6) ? 6 : validDur[0] as StudioVideoDuration);
            trimFileRefsToVideoBudget({ provider: nextProvider });
          }
          if (state.mode === 'sound') {
            state.setOutputFormat('mp3');
          }
        }}
        model={state.model}
        onModelChange={(nextModel) => {
          state.setModel(nextModel);
          const validSizes = getImageSizesForModel(nextModel);
          if (validSizes.length > 0 && !validSizes.includes(state.imageSize)) {
            state.setImageSize(validSizes[0]);
          }
          if (state.mode === 'video') {
            const validRes = getVideoResolutionsForModel(nextModel);
            if (!validRes.includes(state.videoResolution)) {
              state.setVideoResolution(validRes[0] as VideoResolution);
            }
            const validDur = getVideoDurationsForModel(nextModel);
            if (!validDur.includes(state.videoDuration)) {
              state.setVideoDuration(validDur.includes(6) ? 6 : validDur[0] as StudioVideoDuration);
            }
          }
          if (state.mode === 'sound' && nextModel !== 'lyria-3-pro-preview') {
            state.setOutputFormat('mp3');
          }
        }}
        quality={state.quality}
        onQualityChange={state.setQuality}
        outputFormat={state.outputFormat}
        onOutputFormatChange={state.setOutputFormat}
        background={state.background}
        onBackgroundChange={state.setBackground}
        imageSize={state.imageSize}
        onImageSizeChange={state.setImageSize}
        videoResolution={state.videoResolution}
        onVideoResolutionChange={(resolution) => {
          state.setVideoResolution(resolution);
          if (state.provider !== 'bytedance' && (resolution === '1080p' || resolution === '4k')) {
            state.setVideoDuration(8);
          }
        }}
        videoDuration={state.videoDuration}
        onVideoDurationChange={state.setVideoDuration}
        videoGenerateAudio={state.videoGenerateAudio}
        onVideoGenerateAudioChange={state.setVideoGenerateAudio}
        videoWebSearch={state.videoWebSearch}
        onVideoWebSearchChange={state.setVideoWebSearch}
        videoNsfwChecker={state.videoNsfwChecker}
        onVideoNsfwCheckerChange={state.setVideoNsfwChecker}
        onGenerate={onGenerate}
        isGenerating={isGenerating}
        canGenerate={canGenerate}
        showMoreOptions={state.showMoreOptions}
        onShowMoreOptionsChange={state.setShowMoreOptions}
      />
    </>
  );
}
