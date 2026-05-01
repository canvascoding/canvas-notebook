'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import {
  getDefaultModelForProvider,
  getAspectRatiosForProvider,
  getVideoResolutionsForModel,
  getVideoDurationsForModel,
  type VideoResolution,
  type StudioVideoDuration,
} from '@/app/lib/integrations/image-generation-constants';
import { useStudioGeneration } from '../hooks/useStudioGeneration';
import { useStudioPersonas } from '../hooks/useStudioPersonas';
import { useStudioPresets } from '../hooks/useStudioPresets';
import { useStudioProducts } from '../hooks/useStudioProducts';
import { useStudioStyles } from '../hooks/useStudioStyles';
import type { StudioGeneration, StudioGenerationOutput } from '../types/generation';
import type { StudioPreset } from '../types/presets';
import { PromptBar } from './create/PromptBar';
import { SaveToWorkspaceDialog } from './create/SaveToWorkspaceDialog';
import { StudioPreview } from './create/StudioPreview';
import { ReferencePickerDialog } from './create/ReferencePickerDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sparkles, ImagePlus, Play, Layers, LayoutGrid, ArrowRight, Camera, Cpu, Home, Car, UtensilsCrossed, Sun, Package } from 'lucide-react';
import { useStudioGenerationStore } from '@/app/store/studio-generation-store';

interface StartingPoint {
  id: string;
  title: string;
  description: string;
  category: string;
  prompt: string;
  presetId: string | null;
}

const CATEGORY_ICONS: Record<string, typeof Sparkles> = {
  Fashion: Camera,
  Product: ImagePlus,
  Lifestyle: Sun,
  Beauty: Sparkles,
  Food: UtensilsCrossed,
  Architecture: LayoutGrid,
  Video: Play,
  Abstract: Layers,
  Tech: Cpu,
  Interior: Home,
  Automotive: Car,
};

const CATEGORY_COLORS: Record<string, string> = {
  Fashion: 'from-pink-500/20 to-purple-500/20 border-pink-500/30',
  Product: 'from-blue-500/20 to-cyan-500/20 border-blue-500/30',
  Lifestyle: 'from-amber-500/20 to-orange-500/20 border-amber-500/30',
  Beauty: 'from-rose-500/20 to-pink-500/20 border-rose-500/30',
  Food: 'from-green-500/20 to-emerald-500/20 border-green-500/30',
  Architecture: 'from-slate-500/20 to-gray-500/20 border-slate-500/30',
  Video: 'from-violet-500/20 to-purple-500/20 border-violet-500/30',
  Abstract: 'from-indigo-500/20 to-blue-500/20 border-indigo-500/30',
  Tech: 'from-cyan-500/20 to-sky-500/20 border-cyan-500/30',
  Interior: 'from-yellow-500/20 to-amber-500/20 border-yellow-500/30',
  Automotive: 'from-red-500/20 to-orange-500/20 border-red-500/30',
};

function getOutputReference(output: StudioGenerationOutput) {
  if (!output.filePath) return null;
  const name = output.filePath.split('/').pop() || output.filePath;
  const thumbnailPath = output.filePath.startsWith('studio/')
    ? output.filePath
    : `studio/outputs/${output.filePath}`;
  return { id: output.filePath, name, thumbnailPath };
}

function getReferenceRequestValue(ref: { id: string }) {
  if (ref.id.startsWith('/api/studio/media/') || ref.id.startsWith('/api/studio/references/')) return ref.id;
  if (/^https?:\/\//i.test(ref.id)) return ref.id;
  return toMediaUrl(ref.id);
}

export function StudioDashboard() {
  const t = useTranslations('studio');
  const router = useRouter();
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

  const store = useStudioGenerationStore();

  const [startingPoints, setStartingPoints] = useState<StartingPoint[]>([]);
  const [startingPointsLoading, setStartingPointsLoading] = useState(true);
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
  const [selectionEnabled, setSelectionEnabled] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<'start' | 'end' | 'references'>('references');

  useEffect(() => {
    void fetchGenerations();
    void fetchProducts();
    void fetchPersonas();
    void fetchStyles();
    void fetchPresets();
  }, [fetchGenerations, fetchProducts, fetchPersonas, fetchPresets, fetchStyles]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/studio/starting-points');
        const data = await res.json();
        if (!cancelled && data.success) {
          setStartingPoints(data.startingPoints);
        }
      } catch {
        // Keep empty starting points on error
      } finally {
        if (!cancelled) setStartingPointsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const resolvedSelectedGeneration = selectedGenerationId
    ? generations.find((g) => g.id === selectedGenerationId) ?? null
    : null;
  const resolvedSelectedOutput = resolvedSelectedGeneration && selectedOutputId
    ? resolvedSelectedGeneration.outputs.find((o) => o.id === selectedOutputId) ?? null
    : null;

  const canGenerate = useMemo(() => {
    return (
      store.rawPrompt.trim().length > 0 ||
      store.productRefs.length > 0 ||
      store.personaRefs.length > 0 ||
      store.presetRef !== null ||
      store.fileRefs.length > 0
    );
  }, [store.rawPrompt, store.productRefs.length, store.personaRefs.length, store.presetRef, store.fileRefs.length]);

  const hasVideoImageInput = store.mode === 'video' && (
    !!store.startFramePath ||
    store.productRefs.length > 0 ||
    store.personaRefs.length > 0 ||
    store.styleRefs.length > 0 ||
    store.fileRefs.length > 0
  );
  const personGeneration = hasVideoImageInput ? 'allow_adult' as const : 'allow_all' as const;

  const handleGenerate = useCallback(async () => {
    const fileUrls = store.fileRefs.map(getReferenceRequestValue);
    const result = await generationHook.generate({
      prompt: store.rawPrompt.trim(),
      mode: store.mode,
      product_ids: store.productRefs.map((p) => p.id),
      persona_ids: store.personaRefs.map((p) => p.id),
      preset_id: store.presetRef?.id,
      aspect_ratio: store.aspectRatio,
      count: store.mode === 'video' ? 1 : store.count,
      provider: store.provider,
      model: store.model,
      quality: store.provider === 'openai' ? store.quality : undefined,
      output_format: store.provider === 'openai' ? store.outputFormat : undefined,
      background: store.provider === 'openai' ? store.background : undefined,
      extra_reference_urls: fileUrls,
      video_resolution: store.mode === 'video' ? store.videoResolution : undefined,
      video_duration: store.mode === 'video' ? store.videoDuration : undefined,
      start_frame_path: store.mode === 'video' ? store.startFramePath : undefined,
      end_frame_path: store.mode === 'video' ? store.endFramePath : undefined,
      is_looping: store.mode === 'video' ? store.isLooping : undefined,
      person_generation: store.mode === 'video' ? personGeneration : undefined,
      video_generate_audio: store.mode === 'video' && store.provider === 'bytedance' ? store.videoGenerateAudio : undefined,
      video_web_search: store.mode === 'video' && store.provider === 'bytedance' ? store.videoWebSearch : undefined,
      video_nsfw_checker: store.mode === 'video' && store.provider === 'bytedance' ? store.videoNsfwChecker : undefined,
    });

    if (result) {
      store.resetAfterGenerate();
    }
  }, [store, generationHook, personGeneration]);

  const handleStartingPoint = useCallback((sp: StartingPoint) => {
    store.setRawPrompt(sp.prompt);
    if (sp.presetId) {
      const preset = presets.find((p) => p.id === sp.presetId);
      if (preset) store.setPresetRef(preset);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [store, presets]);

  const recentCompleted = generations
    .filter((g) => g.status === 'completed' && g.outputs.some((o) => o.mediaUrl))
    .slice(0, 8);

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

  const handlePickerConfirm = (paths: string[]) => {
    if (pickerTarget === 'start') {
      store.setStartFramePath(paths[0] || null);
      if (store.isLooping) store.setEndFramePath(null);
    } else if (pickerTarget === 'end') {
      store.setEndFramePath(paths[0] || null);
    } else {
      store.setFileRefs([
        ...store.fileRefs,
        ...paths
          .filter((p) => !store.fileRefs.some((f) => f.id === p))
          .map((p) => ({ id: p, name: p.split('/').pop() || p, thumbnailPath: p })),
      ]);
    }
    setPickerOpen(false);
  };

  const promptBarValue = useMemo(() => ({
    rawPrompt: store.rawPrompt,
    productRefs: store.productRefs,
    personaRefs: store.personaRefs,
    styleRefs: store.styleRefs,
    presetRef: store.presetRef,
    fileRefs: store.fileRefs,
  }), [store.rawPrompt, store.productRefs, store.personaRefs, store.styleRefs, store.presetRef, store.fileRefs]);

  const aspectRatios = getAspectRatiosForProvider(store.mode, store.provider);

  return (
    <div className="flex flex-col gap-8">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <div className="max-w-2xl space-y-2">
          <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]">
            {t('dashboard.startingPointsBadge')}
          </Badge>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {t('dashboard.headline')}
          </h2>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
            {t('dashboard.subheadline')}
          </p>
        </div>

        <PromptBar
          value={promptBarValue}
          products={products}
          personas={personas}
          styles={styles}
          presets={presets}
          onRawPromptChange={store.setRawPrompt}
          onProductAdd={(product) => store.addProductRef({ id: product.id, name: product.name })}
          onPersonaAdd={(persona) => store.addPersonaRef({ id: persona.id, name: persona.name })}
          onStyleAdd={(style) => store.addStyleRef({ id: style.id, name: style.name })}
          onPresetSelect={store.setPresetRef}
          onReferenceRemove={(type, id) => {
            if (type === 'product') store.removeProductRef(id);
            else if (type === 'persona') store.removePersonaRef(id);
            else if (type === 'style') store.removeStyleRef(id);
            else if (type === 'file') store.removeFileRef(id);
            else if (type === 'preset') store.removePresetRef();
          }}
          onFileAdd={(paths) => {
            for (const path of paths) {
              store.addFileRef({ id: path, name: path.split('/').pop() || path, thumbnailPath: path });
            }
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-full border border-border/70 bg-card/90 px-1 py-0.5">
            <button
              type="button"
              onClick={() => {
                store.setMode('image');
                store.setCount(1);
                store.setProvider('gemini');
                store.setModel(getDefaultModelForProvider('image', 'gemini'));
                const validRatios = getAspectRatiosForProvider('image', 'gemini');
                if (!validRatios.includes(store.aspectRatio as never)) store.setAspectRatio('1:1');
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                store.mode === 'image'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <ImagePlus className="mr-1 inline h-3 w-3" />
              Image
            </button>
            <button
              type="button"
              onClick={() => {
                store.setMode('video');
                store.setCount(1);
                store.setProvider('veo');
                store.setModel(getDefaultModelForProvider('video', 'veo'));
                store.setAspectRatio('16:9');
                store.setVideoResolution('720p');
                store.setVideoDuration(6);
                store.setVideoGenerateAudio(true);
                store.setVideoWebSearch(false);
                store.setVideoNsfwChecker(false);
              }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                store.mode === 'video'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Play className="mr-1 inline h-3 w-3" />
              Video
            </button>
          </div>

          <div className="flex items-center gap-1 rounded-full border border-border/70 bg-card/90 px-3 py-1.5">
            {aspectRatios.slice(0, 4).map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => store.setAspectRatio(ratio)}
                className={`rounded-full px-2 py-0.5 text-xs font-medium transition-all ${
                  store.aspectRatio === ratio
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {ratio}
              </button>
            ))}
          </div>

          {store.mode === 'image' && (
            <div className="flex items-center gap-1 rounded-full border border-border/70 bg-card/90 px-3 py-1.5">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => store.setCount(n)}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium transition-all ${
                    store.count === n
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {n}x
                </button>
              ))}
            </div>
          )}

          <Button
            type="button"
            size="sm"
            className="ml-auto rounded-full px-4"
            onClick={handleGenerate}
            disabled={generationHook.loading || !canGenerate}
          >
            <Sparkles className="mr-1.5 h-4 w-4" />
            {generationHook.loading ? 'Generating...' : 'Generate'}
          </Button>
        </div>

        {generationHook.error && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="rounded-full border-red-500/40 text-red-700 dark:text-red-300">
              {generationHook.error}
            </Badge>
          </div>
        )}

        {store.mode === 'video' && (
          <div className="space-y-2 border border-border bg-background p-3 rounded-xl">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('sections.frames.title')}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => { setPickerTarget('start'); setPickerOpen(true); }}>
                {t('sections.frames.startFrame')}
              </Button>
              {!store.isLooping && (
                <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => { setPickerTarget('end'); setPickerOpen(true); }}>
                  {t('sections.frames.endFrame')}
                </Button>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={store.isLooping}
                onChange={(e) => {
                  store.setIsLooping(e.target.checked);
                  if (e.target.checked) store.setEndFramePath(null);
                }}
              />
              {t('sections.frames.loopVideo')}
            </label>
          </div>
        )}
      </div>

      {!startingPointsLoading && startingPoints.length > 0 && (
        <section>
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {t('dashboard.startingPointsTitle')}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {startingPoints.map((sp) => {
              const Icon = CATEGORY_ICONS[sp.category] || Sparkles;
              const colorClass = CATEGORY_COLORS[sp.category] || 'from-primary/10 to-primary/5 border-primary/20';
              return (
                <button
                  key={sp.id}
                  type="button"
                  onClick={() => handleStartingPoint(sp)}
                  className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-gradient-to-br p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg ${colorClass}`}
                >
                  <div className="mb-3 flex items-center gap-2.5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-background/80 backdrop-blur-sm">
                      <Icon className="h-4 w-4 text-foreground" />
                    </div>
                    <Badge variant="outline" className="rounded-full px-2 py-0 text-[10px]">
                      {sp.category}
                    </Badge>
                  </div>
                  <h4 className="mb-1.5 text-sm font-semibold text-foreground">{sp.title}</h4>
                  <p className="mb-4 line-clamp-2 flex-1 text-xs leading-5 text-muted-foreground">{sp.description}</p>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    <Sparkles className="h-3 w-3" />
                    {t('dashboard.recreate')}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {recentCompleted.length > 0 && (
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('dashboard.recentGenerationsTitle')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-xs text-muted-foreground"
              onClick={() => router.push('/studio/create')}
            >
              {t('dashboard.viewAll')}
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
            {recentCompleted.map((generation) => {
              const output = generation.outputs.find((o) => o.mediaUrl);
              if (!output) return null;
              return (
                <button
                  key={generation.id}
                  type="button"
                  onClick={() => {
                    setSelectedGenerationId(generation.id);
                    setSelectedOutputId(output.id);
                  }}
                  className="group relative aspect-square overflow-hidden rounded-2xl border border-border/60 bg-card/70 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
                >
                  {output.type === 'video' ? (
                    <video
                      src={output.mediaUrl!}
                      muted
                      playsInline
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : (
                    <img
                      src={toPreviewUrl(output.filePath!, 400, { preset: 'mini' })}
                      alt={generation.prompt || 'Studio output'}
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      loading="lazy"
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                  {generation.prompt && (
                    <p className="absolute bottom-2 left-2 right-2 truncate text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                      {generation.prompt}
                    </p>
                  )}
                  {output.isFavorite && (
                    <div className="absolute top-2 right-2">
                      <Sparkles className="h-3.5 w-3.5 text-yellow-400" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="mt-2 flex flex-wrap items-center justify-center gap-3 border-t border-border/50 pt-6">
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => router.push('/studio/models/new')}
        >
          <Package className="mr-1.5 h-3.5 w-3.5" />
          {t('dashboard.quickActions.newProduct')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => router.push('/studio/bulk')}
        >
          <Layers className="mr-1.5 h-3.5 w-3.5" />
          {t('dashboard.quickActions.startBulk')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => router.push('/studio/models')}
        >
          <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
          {t('modelLibrary.products')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => router.push('/studio/presets')}
        >
          <LayoutGrid className="mr-1.5 h-3.5 w-3.5" />
          {t('dashboard.quickActions.viewPresets')}
        </Button>
      </section>

      {resolvedSelectedGeneration && resolvedSelectedOutput && (
        <StudioPreview
          generation={resolvedSelectedGeneration}
          output={resolvedSelectedOutput}
          products={products}
          personas={personas}
          styles={styles}
          presets={presets}
          open={true}
          allVisibleOutputs={recentCompleted.flatMap((g) =>
            g.outputs.filter((o) => o.mediaUrl).map((o) => ({ generation: g, output: o }))
          )}
          onToggleFavorite={(generation, output) => {
            void generationHook.toggleFavorite(generation.id, output.id, !output.isFavorite);
          }}
          onCreateVariation={(generation, output) => {
            store.setMode('image');
            store.setRawPrompt(generation.rawPrompt || generation.prompt || '');
            store.setProductRefs((generation.product_ids ?? []).map((id) => {
              const p = products.find((product) => product.id === id);
              return { id, name: p?.name || id };
            }));
            store.setPersonaRefs((generation.persona_ids ?? []).map((id) => {
              const p = personas.find((persona) => persona.id === id);
              return { id, name: p?.name || id };
            }));
            store.setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
            store.setAspectRatio(generation.aspectRatio || '1:1');
            store.setProvider(generation.provider || 'gemini');
            store.setModel(generation.model || 'gemini-2.0-flash-exp-image-generation');
            const ref = getOutputReference(output);
            if (ref) store.addFileRef(ref);
            setSelectedGenerationId(null);
            setSelectedOutputId(null);
            router.push('/studio/create');
          }}
          onCreateVideo={(generation, output) => {
            store.setMode('video');
            store.setRawPrompt(generation.rawPrompt || generation.prompt || '');
            store.setProductRefs((generation.product_ids ?? []).map((id) => {
              const p = products.find((product) => product.id === id);
              return { id, name: p?.name || id };
            }));
            store.setPersonaRefs((generation.persona_ids ?? []).map((id) => {
              const p = personas.find((persona) => persona.id === id);
              return { id, name: p?.name || id };
            }));
            store.setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
            store.setAspectRatio(['16:9', '9:16'].includes(generation.aspectRatio) ? generation.aspectRatio : '16:9');
            store.setProvider('veo');
            store.setModel(getDefaultModelForProvider('video', 'veo'));
            const ref = getOutputReference(output);
            if (ref) store.addFileRef(ref);
            setSelectedGenerationId(null);
            setSelectedOutputId(null);
            router.push('/studio/create');
          }}
          onDelete={(generation) => {
            void generationHook.deleteGeneration(generation.id);
          }}
          onSaveToWorkspace={handleSaveSingleToWorkspace}
          onNavigate={(generationId, outputId) => {
            setSelectedGenerationId(generationId);
            setSelectedOutputId(outputId);
          }}
          onClose={() => {
            setSelectedGenerationId(null);
            setSelectedOutputId(null);
          }}
        />
      )}

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
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        multiple={pickerTarget === 'references'}
        maxSelection={pickerTarget === 'references' ? 10 : 1}
        onConfirm={handlePickerConfirm}
      />
    </div>
  );
}