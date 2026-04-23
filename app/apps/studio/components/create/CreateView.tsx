'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { useStudioGeneration } from '../../hooks/useStudioGeneration';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import { useStudioStyles } from '../../hooks/useStudioStyles';
import type { StudioGenerationMode, StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import type { StudioPreset } from '../../types/presets';
import { SaveToWorkspaceDialog } from './SaveToWorkspaceDialog';
import { StudioPreview } from './StudioPreview';
import { OutputGrid } from './OutputGrid';
import { Badge } from '@/components/ui/badge';
import { PromptBar } from './PromptBar';
import { ControlBar } from './ControlBar';
import { FrameUpload } from './FrameUpload';
import { getDefaultModelForProvider, getAspectRatiosForProvider, getVideoResolutionsForModel, getVideoDurationsForModel, type VideoResolution, type VideoDuration } from '@/app/lib/integrations/image-generation-constants';
import { toMediaUrl } from '@/app/lib/utils/media-url';

const STARTING_POINTS = [
  {
    title: 'Hero product launch',
    description: 'Clean catalog-style product visual with sharp lighting and premium detail.',
  },
  {
    title: 'Lifestyle campaign moment',
    description: 'Warm editorial scene with people, context, and brand atmosphere.',
  },
  {
    title: 'Beauty close-up',
    description: 'Skincare or cosmetics concept with luminous surfaces and elegant gradients.',
  },
  {
    title: 'Short video concept',
    description: 'Start from a still or text prompt and evolve it into a cinematic clip.',
  },
] as const;

function EmptyState() {
  const t = useTranslations('studio');
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-10">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-primary/10 text-primary">
            <Sparkles className="h-10 w-10" />
          </div>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {t('dashboard.emptyState.title')}
          </h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground sm:text-base">
            {t('dashboard.emptyState.subtitle')}
          </p>
        </div>

        <div className="w-full space-y-3">
          <Badge variant="secondary" className="w-fit rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]">
            {t('dashboard.startingPointsTitle')}
          </Badge>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {STARTING_POINTS.map((item) => (
              <div
                key={item.title}
                className="group rounded-3xl border border-border/70 bg-card/80 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
              >
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Sparkles className="h-5 w-5" />
                </div>
                <h3 className="mb-2 text-base font-semibold text-foreground">{item.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CreateView() {
  const searchParams = useSearchParams();
  const generationHook = useStudioGeneration();
  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const stylesHook = useStudioStyles();
  const presetsHook = useStudioPresets();
  const { fetchGenerations, generations } = generationHook;
  const { fetchProducts, products } = productsHook;
  const { fetchPersonas, personas } = personasHook;
  const { fetchStyles, styles } = stylesHook;
  const { fetchPresets, presets } = presetsHook;
  const [mode, setMode] = useState<StudioGenerationMode>('image');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [count, setCount] = useState(1);
  const [provider, setProvider] = useState('gemini');
  const [model, setModel] = useState('gemini-3.1-flash-image-preview');
  const [quality, setQuality] = useState<'low' | 'medium' | 'high' | 'auto'>('auto');
  const [outputFormat, setOutputFormat] = useState<'png' | 'jpeg' | 'webp'>('png');
  const [background, setBackground] = useState<'transparent' | 'opaque' | 'auto'>('auto');
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [videoResolution, setVideoResolution] = useState<VideoResolution>('720p');
  const [videoDuration, setVideoDuration] = useState<VideoDuration>(6);
  const initialPrompt = useMemo(() => searchParams.get('prompt') ?? '', [searchParams]);
  const [rawPrompt, setRawPrompt] = useState(initialPrompt);
  const [productRefs, setProductRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [personaRefs, setPersonaRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [styleRefs, setStyleRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [presetRef, setPresetRef] = useState<StudioPreset | null>(null);
  const [fileRefs, setFileRefs] = useState<Array<{ id: string; name: string; thumbnailPath?: string; status?: 'loading' | string }>>([]);
  const [startFrame, setStartFrame] = useState<File | null>(null);
  const [endFrame, setEndFrame] = useState<File | null>(null);
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  const resolvedSelectedGeneration = selectedGenerationId
    ? generations.find((g) => g.id === selectedGenerationId) ?? null
    : null;
  const resolvedSelectedOutput = resolvedSelectedGeneration && selectedOutputId
    ? resolvedSelectedGeneration.outputs.find((o) => o.id === selectedOutputId) ?? null
    : null;

  const handleToggleOutputSelect = (outputId: string, selected: boolean) => {
    if (selected) {
      setSelectedOutputIds((prev) => [...prev, outputId]);
    } else {
      setSelectedOutputIds((prev) => prev.filter((id) => id !== outputId));
    }
  };

  const handleSaveToWorkspace = () => {
    if (selectedOutputIds.length === 0) return;
    setShowSaveDialog(true);
  };

  const handleSaveSingleToWorkspace = (_g: StudioGeneration, output: StudioGenerationOutput) => {
    setSelectedOutputIds([output.id]);
    setShowSaveDialog(true);
  };

  useEffect(() => {
    void fetchGenerations();
    void fetchProducts();
    void fetchPersonas();
    void fetchStyles();
    void fetchPresets();
  }, [fetchGenerations, fetchProducts, fetchPersonas, fetchPresets, fetchStyles]);

  const canGenerate = useMemo(() => {
    return rawPrompt.trim().length > 0 || productRefs.length > 0 || personaRefs.length > 0 || presetRef !== null || fileRefs.length > 0;
  }, [personaRefs.length, presetRef, productRefs.length, rawPrompt, fileRefs.length]);

  const handleGenerate = async () => {
    const fileUrls = fileRefs.map((ref) => toMediaUrl(ref.id));
    const result = await generationHook.generate({
      prompt: rawPrompt.trim(),
      mode,
      product_ids: productRefs.map((product) => product.id),
      persona_ids: personaRefs.map((persona) => persona.id),
      preset_id: presetRef?.id,
      aspect_ratio: aspectRatio,
      count: mode === 'video' ? 1 : count,
      provider,
      model,
      quality: provider === 'openai' ? quality : undefined,
      output_format: provider === 'openai' ? outputFormat : undefined,
      background: provider === 'openai' ? background : undefined,
      extra_reference_urls: fileUrls,
      video_resolution: mode === 'video' ? videoResolution : undefined,
      video_duration: mode === 'video' ? videoDuration : undefined,
    });

    if (result) {
      setRawPrompt('');
      setFileRefs([]);
      setStartFrame(null);
      setEndFrame(null);
    }
  };;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.12),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.12),_transparent_32%)]">
            {selectedOutputIds.length > 0 && (
              <div className="sticky top-0 z-30 flex items-center justify-between border-b border-border/70 bg-background/90 px-4 py-2 backdrop-blur">
                <div className="text-sm font-medium">
                  {selectedOutputIds.length} ausgewahlt
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent"
                    onClick={() => setSelectedOutputIds([])}
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
                    onClick={handleSaveToWorkspace}
                  >
                    In Workspace speichern
                  </button>
                </div>
              </div>
            )}
            <OutputGrid
              generations={generations}
              emptyState={<EmptyState />}
              selectedOutputIds={selectedOutputIds}
              onToggleSelectOutput={handleToggleOutputSelect}
              onOutputOpen={({ generation, output }) => {
                setSelectedGenerationId(generation.id);
                setSelectedOutputId(output.id);
              }}
              onToggleFavorite={(generation, output) => {
                void generationHook.toggleFavorite(generation.id, output.id, !output.isFavorite);
              }}
              onCreateVariation={(generation, output) => {
                setMode('image');
                setRawPrompt(generation.rawPrompt || generation.prompt || '');
                setProductRefs((generation.product_ids ?? []).map((id) => {
                  const p = products.find((product) => product.id === id);
                  return { id, name: p?.name || id };
                }));
                setPersonaRefs((generation.persona_ids ?? []).map((id) => {
                  const p = personas.find((persona) => persona.id === id);
                  return { id, name: p?.name || id };
                }));
                setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
                setAspectRatio(generation.aspectRatio || '1:1');
                setProvider(generation.provider || 'gemini');
                setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
                if (output.mediaUrl) {
                  setFileRefs((current) =>
                    current.some((item) => item.id === output.mediaUrl!) ? current : [...current, { id: output.mediaUrl!, name: output.mediaUrl!, thumbnailPath: output.mediaUrl || undefined }],
                  );
                }
                setSelectedGenerationId(null);
                setSelectedOutputId(null);
              }}
              onCreateVideo={(generation, output) => {
                setMode('video');
                setRawPrompt(generation.rawPrompt || generation.prompt || '');
                setProductRefs((generation.product_ids ?? []).map((id) => {
                  const p = products.find((product) => product.id === id);
                  return { id, name: p?.name || id };
                }));
                setPersonaRefs((generation.persona_ids ?? []).map((id) => {
                  const p = personas.find((persona) => persona.id === id);
                  return { id, name: p?.name || id };
                }));
                setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
                setAspectRatio(generation.aspectRatio || '1:1');
                setProvider(generation.provider || 'gemini');
                setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
                if (output.mediaUrl) {
                  setFileRefs((current) =>
                    current.some((item) => item.id === output.mediaUrl!) ? current : [...current, { id: output.mediaUrl!, name: output.mediaUrl!, thumbnailPath: output.mediaUrl || undefined }],
                  );
                }
                setSelectedGenerationId(null);
                setSelectedOutputId(null);
              }}
              onDelete={(generation) => {
                void generationHook.deleteGeneration(generation.id);
              }}
              onSaveToWorkspace={handleSaveSingleToWorkspace}
            />
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-border/80 bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
          {mode === 'video' ? (
            <FrameUpload
              startFrame={startFrame}
              endFrame={endFrame}
              onStartFrameChange={setStartFrame}
              onEndFrameChange={setEndFrame}
            />
          ) : null}

          <PromptBar
            value={{
              rawPrompt,
              productRefs,
              personaRefs,
              styleRefs,
              presetRef,
              fileRefs,
            }}
            products={products}
            personas={personas}
            styles={styles}
            presets={presets}
            onRawPromptChange={setRawPrompt}
            onProductAdd={(product) => {
              setProductRefs((current) =>
                current.some((item) => item.id === product.id)
                  ? current
                  : [...current, { id: product.id, name: product.name }],
              );
            }}
            onPersonaAdd={(persona) => {
              setPersonaRefs((current) =>
                current.some((item) => item.id === persona.id)
                  ? current
                  : [...current, { id: persona.id, name: persona.name }],
              );
            }}
            onStyleAdd={(style) => {
              setStyleRefs((current) =>
                current.some((item) => item.id === style.id)
                  ? current
                  : [...current, { id: style.id, name: style.name }],
              );
            }}
            onPresetSelect={setPresetRef}
            onReferenceRemove={(type, id) => {
              if (type === 'product') {
                setProductRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              if (type === 'persona') {
                setPersonaRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              if (type === 'style') {
                setStyleRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              if (type === 'file') {
                setFileRefs((current) => current.filter((item) => item.id !== id));
                return;
              }
              setPresetRef((current) => (current?.id === id ? null : current));
            }}
            onFileAdd={(paths) => {
              setFileRefs((current) => {
                const next = [...current];
                for (const path of paths) {
                  if (!next.some((item) => item.id === path)) {
                    next.push({ id: path, name: path.split('/').pop() || path, thumbnailPath: path });
                  }
                }
                return next;
              });
            }}
          />

          <ControlBar
            mode={mode}
            onModeChange={(nextMode) => {
              setMode(nextMode);
              setCount(1);
              if (nextMode === 'video') {
                setProvider('veo');
                setModel(getDefaultModelForProvider('video', 'veo'));
                setAspectRatio('16:9');
                setVideoResolution('720p');
                setVideoDuration(6);
              } else {
                setProvider('gemini');
                setModel(getDefaultModelForProvider('image', 'gemini'));
                const validRatios = getAspectRatiosForProvider('image', 'gemini');
                if (!validRatios.includes(aspectRatio as never)) {
                  setAspectRatio('1:1');
                }
              }
            }}
            presets={presets}
            selectedPreset={presetRef}
            onPresetChange={setPresetRef}
            aspectRatio={aspectRatio}
            onAspectRatioChange={setAspectRatio}
            count={count}
            onCountChange={setCount}
            provider={provider}
            onProviderChange={(nextProvider) => {
              setProvider(nextProvider);
              setModel(getDefaultModelForProvider(mode, nextProvider));
              const validRatios = getAspectRatiosForProvider(mode, nextProvider);
              if (!validRatios.includes(aspectRatio as never)) {
                setAspectRatio('1:1');
              }
            }}
            model={model}
            onModelChange={(nextModel) => {
              setModel(nextModel);
              if (mode === 'video') {
                const validRes = getVideoResolutionsForModel(nextModel);
                if (!validRes.includes(videoResolution)) {
                  setVideoResolution(validRes[0] as VideoResolution);
                }
                const validDur = getVideoDurationsForModel(nextModel);
                if (!validDur.includes(videoDuration)) {
                  setVideoDuration(validDur.includes(6) ? 6 : validDur[0] as VideoDuration);
                }
              }
            }}
            quality={quality}
            onQualityChange={setQuality}
            outputFormat={outputFormat}
            onOutputFormatChange={setOutputFormat}
            background={background}
            onBackgroundChange={setBackground}
            videoResolution={videoResolution}
            onVideoResolutionChange={(res) => {
              setVideoResolution(res);
              if (res === '1080p' || res === '4k') {
                setVideoDuration(8);
              }
            }}
            videoDuration={videoDuration}
            onVideoDurationChange={setVideoDuration}
            onGenerate={handleGenerate}
            isGenerating={generationHook.loading}
            canGenerate={canGenerate}
            showMoreOptions={showMoreOptions}
            onShowMoreOptionsChange={setShowMoreOptions}
          />

          {generationHook.error ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full border-red-500/40 text-red-700 dark:text-red-300">
                {generationHook.error}
              </Badge>
            </div>
          ) : null}
        </div>
      </div>

      <StudioPreview
        generation={resolvedSelectedGeneration}
        output={resolvedSelectedOutput}
        generations={generations}
        products={products}
        personas={personas}
        styles={styles}
        open={resolvedSelectedGeneration !== null && resolvedSelectedOutput !== null}
        onSelectOutput={({ generation, output }) => {
          setSelectedGenerationId(generation.id);
          setSelectedOutputId(output.id);
        }}
        onToggleFavorite={(generation, output) => {
          void generationHook.toggleFavorite(generation.id, output.id, !output.isFavorite);
        }}
        onCreateVariation={(generation, output) => {
          setMode('image');
          setRawPrompt(generation.rawPrompt || generation.prompt || '');
          setProductRefs((generation.product_ids ?? []).map((id: string) => {
            const p = products.find((product) => product.id === id);
            return { id, name: p?.name || id };
          }));
          setPersonaRefs((generation.persona_ids ?? []).map((id: string) => {
            const p = personas.find((persona) => persona.id === id);
            return { id, name: p?.name || id };
          }));
          setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
          setAspectRatio(generation.aspectRatio || '1:1');
          setProvider(generation.provider || 'gemini');
          setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
          if (output.mediaUrl) {
            setFileRefs((current) =>
              current.some((item) => item.id === output.mediaUrl!) ? current : [...current, { id: output.mediaUrl!, name: output.mediaUrl!, thumbnailPath: output.mediaUrl || undefined }],
            );
          }
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
        onCreateVideo={(generation, output) => {
          setMode('video');
          setRawPrompt(generation.rawPrompt || generation.prompt || '');
          setProductRefs((generation.product_ids ?? []).map((id: string) => {
            const p = products.find((product) => product.id === id);
            return { id, name: p?.name || id };
          }));
          setPersonaRefs((generation.persona_ids ?? []).map((id: string) => {
            const p = personas.find((persona) => persona.id === id);
            return { id, name: p?.name || id };
          }));
          setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
          setAspectRatio(generation.aspectRatio || '1:1');
          setProvider(generation.provider || 'gemini');
          setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
          if (output.mediaUrl) {
            setFileRefs((current) =>
              current.some((item) => item.id === output.mediaUrl!) ? current : [...current, { id: output.mediaUrl!, name: output.mediaUrl!, thumbnailPath: output.mediaUrl || undefined }],
            );
          }
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
        onDelete={(generation) => {
          void generationHook.deleteGeneration(generation.id);
        }}
        onClose={() => {
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
      />
      <SaveToWorkspaceDialog
        open={showSaveDialog}
        onOpenChange={setShowSaveDialog}
        outputIds={selectedOutputIds}
      />
    </div>
  );
}
