'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStudioGeneration } from '../../hooks/useStudioGeneration';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import { useStudioStyles } from '../../hooks/useStudioStyles';
import type { StudioGenerationMode, StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import type { StudioPreset } from '../../types/presets';
import { SaveToWorkspaceDialog } from './SaveToWorkspaceDialog';
import { StudioPreview } from './StudioPreview';
import { OutputGrid, type OutputDateFilter, type OutputMediaFilter, type OutputSortOrder } from './OutputGrid';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from './FilterBar';
import { PromptBar } from './PromptBar';
import { ControlBar } from './ControlBar';
import { ReferencePickerDialog } from './ReferencePickerDialog';
import Image from 'next/image';
import { getDefaultModelForProvider, getAspectRatiosForProvider, getVideoResolutionsForModel, getVideoDurationsForModel, type VideoResolution, type StudioVideoDuration } from '@/app/lib/integrations/image-generation-constants';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { useSetStudioChatContext } from '@/app/apps/studio/context/studio-chat-context';

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

function PreviewChip({ path, kind }: { path: string; kind: 'image' | 'video' }) {
  const name = path.split('/').pop() || path;

  return (
      <div className="flex items-center gap-2 border border-border bg-background px-2 py-1.5 sm:py-1">
        <div className="relative h-12 w-16 sm:h-10 sm:w-14 overflow-hidden bg-muted flex-shrink-0">
          {kind === 'image' ? (
            <Image
              src={toPreviewUrl(path, 200, { preset: 'mini' })}
              alt={name}
              fill
              className="object-cover"
              loading="lazy"
              sizes="64px"
              unoptimized
            />
          ) : (
            <video src={toMediaUrl(path)} className="h-full w-full object-cover" muted />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground hidden sm:block">{path}</p>
        </div>
      </div>
  );
}

function getReferenceRequestValue(ref: { id: string }) {
  if (ref.id.startsWith('/api/studio/media/') || ref.id.startsWith('/api/studio/references/')) {
    return ref.id;
  }

  if (/^https?:\/\//i.test(ref.id)) {
    return ref.id;
  }

  return toMediaUrl(ref.id);
}

function getOutputReference(output: StudioGenerationOutput) {
  if (!output.filePath) return null;

  const name = output.filePath.split('/').pop() || output.filePath;
  const thumbnailPath = output.filePath.startsWith('studio/')
    ? output.filePath
    : `studio/outputs/${output.filePath}`;
  return {
    id: output.filePath,
    name,
    thumbnailPath,
  };
}

function addFileReference(
  setFileRefs: Dispatch<SetStateAction<Array<{ id: string; name: string; thumbnailPath?: string; status?: 'loading' | string }>>>,
  reference: { id: string; name: string; thumbnailPath?: string } | null,
) {
  if (!reference) return;

  setFileRefs((current) =>
    current.some((item) => item.id === reference.id) ? current : [...current, reference],
  );
}

export function CreateView() {
  const t = useTranslations('studio');
  const searchParams = useSearchParams();
  const setChatContext = useSetStudioChatContext();
  const generationHook = useStudioGeneration();
  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const stylesHook = useStudioStyles();
  const presetsHook = useStudioPresets();
  const { fetchGenerations, generations, recentlyCompletedIds } = generationHook;
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
  const [videoDuration, setVideoDuration] = useState<StudioVideoDuration>(6);
  const [videoGenerateAudio, setVideoGenerateAudio] = useState(true);
  const [videoWebSearch, setVideoWebSearch] = useState(false);
  const [videoNsfwChecker, setVideoNsfwChecker] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const initialPrompt = useMemo(() => searchParams.get('prompt') ?? '', [searchParams]);
  const [rawPrompt, setRawPrompt] = useState(initialPrompt);
  const initialRefPath = useMemo(() => searchParams.get('ref'), [searchParams]);
  const [productRefs, setProductRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [personaRefs, setPersonaRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [styleRefs, setStyleRefs] = useState<Array<{ id: string; name: string }>>([]);
  const [presetRef, setPresetRef] = useState<StudioPreset | null>(null);
  const [fileRefs, setFileRefs] = useState<Array<{ id: string; name: string; thumbnailPath?: string; status?: 'loading' | string }>>([]);
  const [startFramePath, setStartFramePath] = useState<string | null>(null);
  const [endFramePath, setEndFramePath] = useState<string | null>(null);

  const hasVideoImageInput = mode === 'video' && (!!startFramePath || productRefs.length > 0 || personaRefs.length > 0 || styleRefs.length > 0 || fileRefs.length > 0);
  const personGeneration = hasVideoImageInput ? 'allow_adult' as const : 'allow_all' as const;
  const [picker, setPicker] = useState<{
    open: boolean;
    target: 'start' | 'end' | 'references';
    maxSelection: number;
  }>({
    open: false,
    target: 'start',
    maxSelection: 1,
  });
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
  const [selectionEnabled, setSelectionEnabled] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<OutputMediaFilter>('all');
  const [dateFilter, setDateFilter] = useState<OutputDateFilter>('all');
  const [sortOrder, setSortOrder] = useState<OutputSortOrder>('newest');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const promptOverlayRef = useRef<HTMLDivElement | null>(null);
  const [promptOverlayHeight, setPromptOverlayHeight] = useState(220);

  const openPicker = (target: 'start' | 'end' | 'references', maxSelection = 1) => {
    setPicker({ open: true, target, maxSelection });
  };

  const handlePickerConfirm = (paths: string[]) => {
    if (picker.target === 'start') {
      setStartFramePath(paths[0] || null);
      if (isLooping) {
        setEndFramePath(null);
      }
      return;
    }
    if (picker.target === 'end') {
      setEndFramePath(paths[0] || null);
      return;
    }
  };

  const resolvedSelectedGeneration = selectedGenerationId
    ? generations.find((g) => g.id === selectedGenerationId) ?? null
    : null;
  const resolvedSelectedOutput = resolvedSelectedGeneration && selectedOutputId
    ? resolvedSelectedGeneration.outputs.find((o) => o.id === selectedOutputId) ?? null
    : null;

  useEffect(() => {
    if (resolvedSelectedGeneration && resolvedSelectedOutput) {
      setChatContext({
        currentPage: '/studio/create',
        studioContext: {
          generationId: resolvedSelectedGeneration.id,
          currentOutputId: resolvedSelectedOutput.id,
          generationPrompt: resolvedSelectedGeneration.prompt || resolvedSelectedGeneration.rawPrompt || null,
          generationPresetId: resolvedSelectedGeneration.studioPresetId,
          generationProductIds: resolvedSelectedGeneration.product_ids ?? [],
          generationPersonaIds: resolvedSelectedGeneration.persona_ids ?? [],
          outputFilePath: resolvedSelectedOutput.filePath,
          outputMediaUrl: resolvedSelectedOutput.mediaUrl,
        },
      });
      return;
    }

    setChatContext({ currentPage: '/studio/create' });
  }, [resolvedSelectedGeneration, resolvedSelectedOutput, setChatContext]);

  const handleToggleOutputSelect = (outputId: string, selected: boolean) => {
    if (selected) {
      setSelectedOutputIds((prev) => (prev.includes(outputId) ? prev : [...prev, outputId]));
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
    setSelectionEnabled(true);
    setShowSaveDialog(true);
  };

  const visibleOutputList = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOfLast7 = startOfToday - 6 * 24 * 60 * 60 * 1000;
    const startOfLast30 = startOfToday - 29 * 24 * 60 * 60 * 1000;

    const matchesDateFilter = (value: string) => {
      if (dateFilter === 'all') return true;
      const time = new Date(value).getTime();
      if (Number.isNaN(time)) return dateFilter === 'older';
      if (dateFilter === 'today') return time >= startOfToday;
      if (dateFilter === 'yesterday') return time >= startOfYesterday && time < startOfToday;
      if (dateFilter === 'last7') return time >= startOfLast7;
      if (dateFilter === 'last30') return time >= startOfLast30;
      return time < startOfLast30;
    };

    const flattened = generations.flatMap((gen) =>
      gen.outputs.map((out) => ({ generation: gen, output: out })),
    );

    return flattened
      .filter((entry) => {
        if (mediaFilter === 'all') return true;
        if (mediaFilter === 'favorites') return entry.output.isFavorite;
        if (mediaFilter === 'image' || mediaFilter === 'video') return entry.output.type === mediaFilter;
        return false;
      })
      .filter((entry) => matchesDateFilter(entry.generation.createdAt))
      .sort((a, b) => {
        const left = new Date(a.generation.createdAt).getTime();
        const right = new Date(b.generation.createdAt).getTime();
        return sortOrder === 'newest' ? right - left : left - right;
      });
  }, [generations, mediaFilter, dateFilter, sortOrder]);

  const handlePreviewNavigate = (generationId: string, outputId: string) => {
    setSelectedGenerationId(generationId);
    setSelectedOutputId(outputId);
  };

  useEffect(() => {
    void fetchGenerations();
    void fetchProducts();
    void fetchPersonas();
    void fetchStyles();
    void fetchPresets();
  }, [fetchGenerations, fetchProducts, fetchPersonas, fetchPresets, fetchStyles]);

  useEffect(() => {
    if (!initialRefPath) return;
    addFileReference(setFileRefs, {
      id: initialRefPath,
      name: initialRefPath.split('/').pop() || initialRefPath,
      thumbnailPath: initialRefPath,
    });
  }, [initialRefPath]);

  useEffect(() => {
    const node = promptOverlayRef.current;
    if (!node) return;

    const updateOverlayHeight = () => {
      setPromptOverlayHeight(Math.ceil(node.getBoundingClientRect().height));
    };

    updateOverlayHeight();
    const observer = new ResizeObserver(updateOverlayHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [mode, showMoreOptions]);

  const canGenerate = useMemo(() => {
    return rawPrompt.trim().length > 0 || productRefs.length > 0 || personaRefs.length > 0 || presetRef !== null || fileRefs.length > 0;
  }, [personaRefs.length, presetRef, productRefs.length, rawPrompt, fileRefs.length]);

  const handleGenerate = async () => {
    const fileUrls = fileRefs.map(getReferenceRequestValue);
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
      start_frame_path: mode === 'video' ? startFramePath : undefined,
      end_frame_path: mode === 'video' ? endFramePath : undefined,
      is_looping: mode === 'video' ? isLooping : undefined,
      person_generation: mode === 'video' ? personGeneration : undefined,
      video_generate_audio: mode === 'video' && provider === 'bytedance' ? videoGenerateAudio : undefined,
      video_web_search: mode === 'video' && provider === 'bytedance' ? videoWebSearch : undefined,
      video_nsfw_checker: mode === 'video' && provider === 'bytedance' ? videoNsfwChecker : undefined,
    });

    if (result) {
      setRawPrompt('');
      setFileRefs([]);
      setStartFramePath(null);
      setEndFramePath(null);
    }
  };;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div
            className="flex-1 min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.12),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.12),_transparent_32%)]"
            style={{ paddingBottom: promptOverlayHeight + 32 }}
          >
            <FilterBar
              mediaFilter={mediaFilter}
              onMediaFilterChange={setMediaFilter}
              dateFilter={dateFilter}
              onDateFilterChange={setDateFilter}
              sortOrder={sortOrder}
              onSortOrderChange={setSortOrder}
              selectionEnabled={selectionEnabled}
              onToggleSelection={() => {
                setSelectionEnabled((current) => {
                  const next = !current;
                  if (!next) setSelectedOutputIds([]);
                  return next;
                });
              }}
              selectedCount={selectedOutputIds.length}
              onCancelSelection={() => {
                setSelectedOutputIds([]);
                setSelectionEnabled(false);
              }}
              onImportToWorkspace={handleSaveToWorkspace}
            />
            <OutputGrid
              generations={generations}
              recentlyCompletedIds={recentlyCompletedIds}
              emptyState={<EmptyState />}
              mediaFilter={mediaFilter}
              dateFilter={dateFilter}
              sortOrder={sortOrder}
              selectionEnabled={selectionEnabled}
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
                addFileReference(setFileRefs, getOutputReference(output));
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
                setAspectRatio(['16:9', '9:16'].includes(generation.aspectRatio) ? generation.aspectRatio : '16:9');
                setProvider('veo');
                setModel(getDefaultModelForProvider('video', 'veo'));
                addFileReference(setFileRefs, getOutputReference(output));
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

      <div
        ref={promptOverlayRef}
        className="absolute inset-x-0 bottom-0 z-40 px-4 py-4 md:px-6"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          {mode === 'video' ? (
            <div className="space-y-2 border border-border bg-background p-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('sections.frames.title')}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" className="w-full sm:w-auto" onClick={() => openPicker('start')}>
                  {t('sections.frames.startFrame')}
                </Button>
                {!isLooping && (
                  <Button variant="outline" className="w-full sm:w-auto" onClick={() => openPicker('end')}>
                    {t('sections.frames.endFrame')}
                  </Button>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isLooping}
                  onChange={(event) => {
                    setIsLooping(event.target.checked);
                    if (event.target.checked) {
                      setEndFramePath(null);
                    }
                  }}
                />
                {t('sections.frames.loopVideo')}
              </label>
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                {startFramePath && <PreviewChip path={startFramePath} kind="image" />}
                {!isLooping && endFramePath && <PreviewChip path={endFramePath} kind="image" />}
              </div>
            </div>
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
                setVideoGenerateAudio(true);
                setVideoWebSearch(false);
                setVideoNsfwChecker(false);
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
                setAspectRatio(mode === 'video' ? '16:9' : '1:1');
              }
              if (mode === 'video') {
                const nextModel = getDefaultModelForProvider(mode, nextProvider);
                const validRes = getVideoResolutionsForModel(nextModel);
                setVideoResolution(validRes.includes(videoResolution) ? videoResolution : validRes[0] as VideoResolution);
                const validDur = getVideoDurationsForModel(nextModel);
                setVideoDuration(validDur.includes(videoDuration) ? videoDuration : validDur.includes(6) ? 6 : validDur[0] as StudioVideoDuration);
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
                  setVideoDuration(validDur.includes(6) ? 6 : validDur[0] as StudioVideoDuration);
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
              if (provider !== 'bytedance' && (res === '1080p' || res === '4k')) {
                setVideoDuration(8);
              }
            }}
            videoDuration={videoDuration}
            onVideoDurationChange={setVideoDuration}
            videoGenerateAudio={videoGenerateAudio}
            onVideoGenerateAudioChange={setVideoGenerateAudio}
            videoWebSearch={videoWebSearch}
            onVideoWebSearchChange={setVideoWebSearch}
            videoNsfwChecker={videoNsfwChecker}
            onVideoNsfwCheckerChange={setVideoNsfwChecker}
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
        products={products}
        personas={personas}
        styles={styles}
        presets={presets}
        open={resolvedSelectedGeneration !== null && resolvedSelectedOutput !== null}
        allVisibleOutputs={visibleOutputList}
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
          addFileReference(setFileRefs, getOutputReference(output));
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
          addFileReference(setFileRefs, getOutputReference(output));
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
        onDelete={(generation) => {
          void generationHook.deleteGeneration(generation.id);
        }}
        onSaveToWorkspace={handleSaveSingleToWorkspace}
        onNavigate={handlePreviewNavigate}
        onClose={() => {
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
      />
      <SaveToWorkspaceDialog
        open={showSaveDialog}
        onOpenChange={setShowSaveDialog}
        outputIds={selectedOutputIds}
        onImported={() => {
          setSelectedOutputIds([]);
          setSelectionEnabled(false);
        }}
      />
      <ReferencePickerDialog
        open={picker.open}
        onOpenChange={(open) => setPicker((current) => ({ ...current, open }))}
        multiple={false}
        maxSelection={picker.maxSelection}
        onConfirm={handlePickerConfirm}
      />
    </div>
  );
}
