'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Building2,
  Clapperboard,
  Droplets,
  ExternalLink,
  FileVideo,
  ImageIcon,
  KeyRound,
  Package,
  Shapes,
  Shirt,
  Sparkles,
  Sun,
  Utensils,
  type LucideIcon,
} from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { useStudioGeneration } from '../../hooks/useStudioGeneration';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import { useStudioStyles } from '../../hooks/useStudioStyles';
import { useStudioBatchActions } from '../../hooks/useStudioBatchActions';
import type { StudioGeneration, StudioGenerationMode, StudioGenerationOutput } from '../../types/generation';
import { SaveToWorkspaceDialog } from './SaveToWorkspaceDialog';
import { StudioPreview } from './StudioPreview';
import { ImageEditSelectionView } from './ImageEditSelectionView';
import { OutputGrid, type OutputDateFilter, type OutputMediaFilter, type OutputSortOrder } from './OutputGrid';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from './FilterBar';
import { PromptBar } from './PromptBar';
import { ControlBar } from './ControlBar';
import { ReferencePickerDialog } from './ReferencePickerDialog';
import { BatchDeleteDialog } from './BatchDeleteDialog';
import { getDefaultModelForProvider, getAspectRatiosForProvider, getVideoResolutionsForModel, getVideoDurationsForModel, getImageSizesForModel, normalizeGeminiImageModelId, type VideoResolution, type StudioVideoDuration } from '@/app/lib/integrations/image-generation-constants';
import { toPreviewUrl, toWorkspaceMediaUrl } from '@/app/lib/utils/media-url';
import { useSetStudioChatContext } from '@/app/apps/studio/context/studio-chat-context';
import { useStudioGenerationStore, type ReferenceTag } from '@/app/store/studio-generation-store';
import { buildStudioGeneratePayload } from '../../utils/studio-generate-payload';
import { clearStudioGenerateHandoff, consumeStudioGenerateHandoff } from '../../utils/studio-generate-handoff';
import { getStudioUserPrompt } from '../../utils/studio-generation-prompt';
import { getFileReferenceLimitForMode, getVideoImageReferenceBudget } from '../../utils/video-reference-limits';
import { EMPTY_STUDIO_PROVIDER_CONFIG, type StudioProviderConfig } from '../../types/config';
import { StudioMediaThumbnail } from '../StudioMediaThumbnail';

const KIE_REFERRAL_URL = 'https://kie.ai?ref=3564e992e10640926d4f0b1620c3a79f';
const INSPIRATION_OUTPUT_THRESHOLD = 8;

interface StartingPoint {
  id: string;
  title: string;
  description: string;
  category: string;
  prompt: string;
  presetId: string | null;
}

const STARTING_POINT_CATEGORY_ICONS: Record<string, LucideIcon> = {
  abstract: Shapes,
  architecture: Building2,
  beauty: Droplets,
  fashion: Shirt,
  food: Utensils,
  lifestyle: Sun,
  product: Package,
  video: Clapperboard,
};

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

function EmptyState({ inspirationPanel }: { inspirationPanel?: ReactNode }) {
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

        {inspirationPanel}
      </div>
    </div>
  );
}

function FilteredEmptyState({ inspirationPanel }: { inspirationPanel?: ReactNode }) {
  const t = useTranslations('studio');
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-6 px-4 py-12 text-center">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Sparkles className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('dashboard.filteredEmptyState.title')}</h2>
          <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
            {t('dashboard.filteredEmptyState.subtitle')}
          </p>
        </div>
      </div>

      {inspirationPanel}
    </div>
  );
}

function StartingPointsPanel({
  onSelect,
  startingPoints,
}: {
  onSelect: (startingPoint: StartingPoint) => void;
  startingPoints: StartingPoint[];
}) {
  const t = useTranslations('studio');

  if (startingPoints.length === 0) {
    return null;
  }

  return (
    <section className="w-full rounded-3xl border border-border/70 bg-card/90 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]">
          {t('dashboard.startingPointsTitle')}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {startingPoints.map((item) => {
          const Icon = STARTING_POINT_CATEGORY_ICONS[item.category.toLowerCase()] ?? Sparkles;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              className="group rounded-2xl border border-border/70 bg-background/80 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {item.category}
                </span>
              </div>
              <h3 className="mb-1.5 text-sm font-semibold text-foreground">{item.title}</h3>
              <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

type StudioProviderRequirement = 'gemini' | 'openai' | 'kie';
type StudioProviderConfigStatus = 'checking' | 'ready';

function hasProviderAccess(config: StudioProviderConfig, provider: StudioProviderRequirement): boolean {
  return config.localApiKeys[provider] || config.managedMediaAvailable;
}

function getMissingProviderRequirement(
  config: StudioProviderConfig,
  mode: 'image' | 'video' | 'sound',
  provider: string,
): StudioProviderRequirement | null {
  if (mode === 'video' && provider === 'bytedance') {
    return hasProviderAccess(config, 'kie') ? null : 'kie';
  }

  if (mode === 'image' && provider === 'openai') {
    return hasProviderAccess(config, 'openai') ? null : 'openai';
  }

  if ((mode === 'image' || mode === 'sound') && provider === 'gemini') {
    return hasProviderAccess(config, 'gemini') ? null : 'gemini';
  }

  if (mode === 'video' && provider === 'veo') {
    return hasProviderAccess(config, 'gemini') ? null : 'gemini';
  }

  return null;
}

function ProviderRequirementNotice({ requirement }: { requirement: StudioProviderRequirement }) {
  const t = useTranslations('studio.providerRequirements');
  const showKieReferral = requirement === 'kie';

  return (
    <div className="flex flex-col gap-3 rounded-[20px] border border-amber-300/80 bg-amber-50/95 p-3 text-amber-950 shadow-sm dark:border-amber-500/35 dark:bg-amber-950/35 dark:text-amber-50 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-200 text-amber-950 dark:bg-amber-500/25 dark:text-amber-100">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <p className="text-sm font-semibold">{t(`${requirement}.title`)}</p>
          </div>
          <p className="mt-1 text-sm leading-5 text-amber-900/85 dark:text-amber-100/85">
            {t(`${requirement}.description`)}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {showKieReferral ? (
          <Button asChild size="sm" className="rounded-full">
            <a href={KIE_REFERRAL_URL} target="_blank" rel="noreferrer">
              {t('kie.getKey')}
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        ) : null}
        <Button asChild size="sm" variant={showKieReferral ? 'outline' : 'default'} className="rounded-full">
          <Link href="/settings?tab=integrations">
            {t('openIntegrations')}
          </Link>
        </Button>
      </div>
    </div>
  );
}

function PreviewChip({ path, kind }: { path: string; kind: 'image' | 'video' }) {
  const name = path.split('/').pop() || path;

  return (
      <div className="flex min-w-0 items-center gap-2 rounded-2xl border border-border/70 bg-background/80 px-2 py-1 shadow-sm">
        <div className="relative h-8 w-11 flex-shrink-0 overflow-hidden rounded-xl bg-muted">
          <StudioMediaThumbnail
            src={toPreviewUrl(path, 200, { preset: 'mini' })}
            alt={name}
            fallback={kind === 'video' ? <FileVideo className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
            skeletonIcon={kind === 'video' ? <FileVideo className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{name}</p>
        </div>
      </div>
  );
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

function getReferenceName(referencePath: string) {
  const cleanPath = referencePath.split(/[?#]/, 1)[0] || referencePath;
  const name = cleanPath.split('/').pop() || referencePath;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

interface CreateViewProps {
  initialProviderConfig?: StudioProviderConfig;
}

export function CreateView({ initialProviderConfig = EMPTY_STUDIO_PROVIDER_CONFIG }: CreateViewProps) {
  const t = useTranslations('studio');
  const router = useRouter();
  const searchParams = useSearchParams();
  const setChatContext = useSetStudioChatContext();
  const [creatorFilter, setCreatorFilter] = useState<string | null>(null);
  const generationHook = useStudioGeneration(creatorFilter);
  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const stylesHook = useStudioStyles();
  const presetsHook = useStudioPresets();
  const batchActions = useStudioBatchActions();
  const {
    fetchGenerations,
    generations,
    creators,
    recentlyCompletedIds,
    hasMoreGenerations,
    loadingMore,
    loadMoreGenerations,
    fetchGeneration,
    watchGeneration,
    generate,
  } = generationHook;
  const { fetchProducts, products, loading: productsLoading } = productsHook;
  const { fetchPersonas, personas, loading: personasLoading } = personasHook;
  const { fetchStyles, styles, loading: stylesLoading } = stylesHook;
  const { fetchPresets, presets } = presetsHook;
  const store = useStudioGenerationStore();
  const pendingGenerateRequest = store.pendingGenerateRequest;
  const clearGenerateRequest = store.clearGenerateRequest;

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
  const [showBatchDeleteDialog, setShowBatchDeleteDialog] = useState(false);
  const [editSelection, setEditSelection] = useState<{
    generation: StudioGeneration;
    output: StudioGenerationOutput;
  } | null>(null);
  const [savingEditSelection, setSavingEditSelection] = useState(false);
  const promptOverlayRef = useRef<HTMLDivElement | null>(null);
  const openedRoutePreviewRef = useRef<string | null>(null);
  const openedRouteReferenceRef = useRef<string | null>(null);
  const startedPendingGenerateRequestRef = useRef<string | null>(null);
  const isMountedRef = useRef(false);
  const [promptOverlayHeight, setPromptOverlayHeight] = useState(180);
  const [providerConfig, setProviderConfig] = useState<StudioProviderConfig>(initialProviderConfig);
  const [providerConfigStatus, setProviderConfigStatus] = useState<StudioProviderConfigStatus>('checking');
  const [startingPoints, setStartingPoints] = useState<StartingPoint[]>([]);
  const [startingPointsLoading, setStartingPointsLoading] = useState(true);

  const openPicker = (target: 'start' | 'end' | 'references', maxSelection = 1) => {
    setPicker({ open: true, target, maxSelection });
  };

  const handlePickerConfirm = (paths: string[]) => {
    if (picker.target === 'start') {
      store.setStartFramePath(paths[0] || null);
      if (store.isLooping) {
        store.setEndFramePath(null);
      }
      return;
    }
    if (picker.target === 'end') {
      store.setEndFramePath(paths[0] || null);
      return;
    }
  };

  const trimFileRefsToVideoBudget = useCallback((overrides: {
    mode?: StudioGenerationMode;
    provider?: string;
    productRefs?: ReferenceTag[];
    personaRefs?: ReferenceTag[];
    styleRefs?: ReferenceTag[];
    fileRefs?: ReferenceTag[];
  } = {}) => {
    const mode = overrides.mode ?? store.mode;
    if (mode !== 'video') return;

    const fileRefs = overrides.fileRefs ?? store.fileRefs;
    const budget = getVideoImageReferenceBudget({
      mode,
      provider: overrides.provider ?? store.provider,
      productRefs: overrides.productRefs ?? store.productRefs,
      personaRefs: overrides.personaRefs ?? store.personaRefs,
      styleRefs: overrides.styleRefs ?? store.styleRefs,
      fileRefs,
    });

    if (fileRefs.length > budget.acceptedFileCount) {
      store.setFileRefs(fileRefs.slice(0, budget.acceptedFileCount));
    }
  }, [store]);

  const resolvedSelectedGeneration = selectedGenerationId
    ? generations.find((g) => g.id === selectedGenerationId) ?? null
    : null;
  const resolvedSelectedOutput = resolvedSelectedGeneration && selectedOutputId
    ? resolvedSelectedGeneration.outputs.find((o) => o.id === selectedOutputId) ?? null
    : null;

  useEffect(() => {
    if (resolvedSelectedGeneration && resolvedSelectedOutput) {
      setChatContext({
        currentPage: '/studio',
        studioContext: {
          generationId: resolvedSelectedGeneration.id,
          currentOutputId: resolvedSelectedOutput.id,
          generationPrompt: getStudioUserPrompt(resolvedSelectedGeneration) || null,
          generationPresetId: resolvedSelectedGeneration.studioPresetId,
          generationProductIds: resolvedSelectedGeneration.product_ids ?? [],
          generationPersonaIds: resolvedSelectedGeneration.persona_ids ?? [],
          outputFilePath: resolvedSelectedOutput.filePath,
          outputMediaUrl: resolvedSelectedOutput.mediaUrl,
        },
      });
      return;
    }

    setChatContext({ currentPage: '/studio' });
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

  const handleStartingPointSelect = useCallback((startingPoint: StartingPoint) => {
    store.setRawPrompt(startingPoint.prompt);
    if (startingPoint.presetId) {
      const preset = presets.find((item) => item.id === startingPoint.presetId);
      if (preset) {
        store.setPresetRef(preset);
      }
    }
  }, [presets, store]);

  const findOutputPair = useCallback((outputId: string): { generationId: string; outputId: string } | null => {
    for (const gen of generations) {
      const out = gen.outputs.find((o) => o.id === outputId);
      if (out) return { generationId: gen.id, outputId: out.id };
    }
    return null;
  }, [generations]);

  const handleBatchDelete = useCallback(async () => {
    setShowBatchDeleteDialog(false);
    const pairs = selectedOutputIds
      .map((id) => findOutputPair(id))
      .filter((p): p is { generationId: string; outputId: string } => p !== null);
    await Promise.allSettled(
      pairs.map(({ generationId, outputId }) => generationHook.deleteOutput(generationId, outputId)),
    );
    setSelectedOutputIds([]);
    setSelectionEnabled(false);
  }, [selectedOutputIds, findOutputPair, generationHook]);

  const handleBatchFavorite = useCallback(async () => {
    const pairs = selectedOutputIds
      .map((id) => findOutputPair(id))
      .filter((p): p is { generationId: string; outputId: string } => p !== null);
    for (const { generationId, outputId } of pairs) {
      void generationHook.toggleFavorite(generationId, outputId, true);
    }
  }, [selectedOutputIds, findOutputPair, generationHook]);

  const handleBatchDownload = useCallback(() => {
    void batchActions.downloadAsZip(selectedOutputIds);
  }, [selectedOutputIds, batchActions]);

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
        if (mediaFilter === 'image' || mediaFilter === 'video' || mediaFilter === 'sound') return entry.output.type === mediaFilter;
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

  const clearSelectedOutput = useCallback(() => {
    setSelectedGenerationId(null);
    setSelectedOutputId(null);
  }, []);

  const applyGenerationReferencesToPrompt = useCallback((generation: StudioGeneration) => {
    const productRefs = (generation.product_ids ?? []).map((id) => {
      const p = products.find((product) => product.id === id);
      return p ? createModelReferenceTag(p) : { id, name: id };
    });
    const personaRefs = (generation.persona_ids ?? []).map((id) => {
      const p = personas.find((persona) => persona.id === id);
      return p ? createModelReferenceTag(p) : { id, name: id };
    });
    const styleRefs = (generation.style_ids ?? []).map((id) => {
      const s = styles.find((style) => style.id === id);
      return s ? createModelReferenceTag(s) : { id, name: id };
    });

    store.setProductRefs(productRefs);
    store.setPersonaRefs(personaRefs);
    store.setStyleRefs(styleRefs);
    store.setPresetRef(presets.find((p) => p.id === generation.studioPresetId) ?? null);
    return { productRefs, personaRefs, styleRefs };
  }, [personas, presets, products, store, styles]);

  const applyGenerationSettingsToPrompt = useCallback((generation: StudioGeneration) => {
    store.setMode('image');
    store.setProvider(generation.provider || 'gemini');
    store.setModel(normalizeGeminiImageModelId(generation.model || getDefaultModelForProvider('image', generation.provider || 'gemini')));
    store.setCount(1);
    applyGenerationReferencesToPrompt(generation);
  }, [applyGenerationReferencesToPrompt, store]);

  const replaceFileRefsWithOutput = useCallback((output: StudioGenerationOutput) => {
    const ref = getOutputReference(output);
    store.setFileRefs(ref ? [ref] : []);
  }, [store]);

  const applyOutputAsImageVariation = useCallback((generation: StudioGeneration, output: StudioGenerationOutput) => {
    applyGenerationSettingsToPrompt(generation);
    store.setRawPrompt(getStudioUserPrompt(generation));
    store.setAspectRatio(generation.aspectRatio || '1:1');
    replaceFileRefsWithOutput(output);
    clearSelectedOutput();
  }, [applyGenerationSettingsToPrompt, clearSelectedOutput, replaceFileRefsWithOutput, store]);

  const applyOutputAsVideoSource = useCallback((generation: StudioGeneration, output: StudioGenerationOutput) => {
    store.setMode('video');
    store.setRawPrompt(getStudioUserPrompt(generation));
    const referenceRefs = applyGenerationReferencesToPrompt(generation);
    store.setAspectRatio(['16:9', '9:16'].includes(generation.aspectRatio) ? generation.aspectRatio : '16:9');
    store.setProvider('veo');
    store.setModel(getDefaultModelForProvider('video', 'veo'));
    const outputRef = getOutputReference(output);
    const fileRefs = outputRef ? [outputRef] : [];
    store.setFileRefs(fileRefs);
    trimFileRefsToVideoBudget({
      mode: 'video',
      provider: 'veo',
      ...referenceRefs,
      fileRefs,
    });
    clearSelectedOutput();
  }, [applyGenerationReferencesToPrompt, clearSelectedOutput, store, trimFileRefsToVideoBudget]);

  const handleUseAspectRatio = useCallback((generation: StudioGeneration, output: StudioGenerationOutput, aspectRatio: string) => {
    applyGenerationSettingsToPrompt(generation);
    store.setAspectRatio(aspectRatio);
    store.setRawPrompt(`Make the aspect ratio ${aspectRatio}`);
    replaceFileRefsWithOutput(output);
    setSelectedGenerationId(null);
    setSelectedOutputId(null);
  }, [applyGenerationSettingsToPrompt, replaceFileRefsWithOutput, store]);

  const handleOpenCustomAspectRatio = useCallback((generation: StudioGeneration, output: StudioGenerationOutput) => {
    if (output.type !== 'image' || !output.filePath) return;

    const params = new URLSearchParams({ ref: output.filePath });
    if (generation.provider) params.set('provider', generation.provider);
    if (generation.model) params.set('model', generation.model);

    setSelectedGenerationId(null);
    setSelectedOutputId(null);
    router.push(`/studio/aspect-ratio?${params.toString()}`);
  }, [router]);

  const handleOpenEditSelection = useCallback((generation: StudioGeneration, output: StudioGenerationOutput) => {
    if (output.type !== 'image' || !output.mediaUrl) return;
    setEditSelection({ generation, output });
  }, []);

  const handleImportEditSelection = useCallback(async ({ prompt, maskDataUrl }: { prompt: string; maskDataUrl: string }) => {
    if (!editSelection) return;
    setSavingEditSelection(true);
    try {
      const response = await fetch('/api/studio/edits/markup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sourcePath: editSelection.output.filePath,
          maskDataUrl,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || !payload.edit?.path) {
        throw new Error(payload.error || 'Failed to create edit markup');
      }

      applyGenerationSettingsToPrompt(editSelection.generation);
      store.setAspectRatio(editSelection.generation.aspectRatio || '1:1');
      store.setRawPrompt(prompt);
      store.setFileRefs([{
        id: payload.edit.path,
        name: payload.edit.name || payload.edit.path.split('/').pop() || 'marked-edit.png',
        thumbnailPath: payload.edit.path,
      }]);
      setEditSelection(null);
      setSelectedGenerationId(null);
      setSelectedOutputId(null);
    } catch (error) {
      console.error('Failed to import edit selection', error);
    } finally {
      setSavingEditSelection(false);
    }
  }, [applyGenerationSettingsToPrompt, editSelection, store]);

  useEffect(() => {
    void fetchGenerations();
    void fetchPresets();
    void fetchProducts();
    void fetchPersonas();
    void fetchStyles();
  }, [fetchGenerations, fetchPresets, fetchProducts, fetchPersonas, fetchStyles]);

  useEffect(() => {
    let cancelled = false;

    async function fetchStartingPoints() {
      try {
        const response = await fetch('/api/studio/starting-points', { credentials: 'include' });
        const payload = await response.json();
        if (!cancelled && response.ok && payload.success && Array.isArray(payload.startingPoints)) {
          setStartingPoints(payload.startingPoints as StartingPoint[]);
        }
      } catch {
        // The studio remains fully usable without inspiration data.
      } finally {
        if (!cancelled) {
          setStartingPointsLoading(false);
        }
      }
    }

    void fetchStartingPoints();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchProviderConfig() {
      try {
        const response = await fetch('/api/studio/config', { credentials: 'include' });
        const payload = await response.json();
        if (!cancelled && response.ok && payload.success && payload.config) {
          setProviderConfig(payload.config as StudioProviderConfig);
        }
      } catch (error) {
        console.error('[Studio] Failed to refresh provider config:', error);
      } finally {
        if (!cancelled) {
          setProviderConfigStatus('ready');
        }
      }
    }

    void fetchProviderConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const initialRefPath = searchParams.get('ref');
  const initialRefSource = searchParams.get('refSource');
  const initialGenerationId = searchParams.get('generation');
  const initialOutputId = searchParams.get('output');
  const initialGenerateRequestId = searchParams.get('generateRequest');

  useEffect(() => {
    if (!initialRefPath) return;
    const routeReferenceKey = `${initialRefSource || 'default'}:${initialRefPath}`;
    if (openedRouteReferenceRef.current === routeReferenceKey) return;
    openedRouteReferenceRef.current = routeReferenceKey;

    const isWorkspaceReference = initialRefSource === 'workspace';
    store.setFileRefs([{
      id: isWorkspaceReference ? toWorkspaceMediaUrl(initialRefPath) : initialRefPath,
      name: getReferenceName(initialRefPath),
      thumbnailPath: initialRefPath,
    }]);
  }, [initialRefPath, initialRefSource, store]);

  useEffect(() => {
    if (!initialGenerationId) return;
    watchGeneration(initialGenerationId);
  }, [initialGenerationId, watchGeneration]);

  useEffect(() => {
    if (!initialGenerationId || !initialOutputId) return;
    const routePreviewKey = `${initialGenerationId}:${initialOutputId}`;
    if (openedRoutePreviewRef.current === routePreviewKey) return;

    const matchingGeneration = generations.find((generation) => generation.id === initialGenerationId);
    const matchingOutput = matchingGeneration?.outputs.find((output) => output.id === initialOutputId);

    if (matchingGeneration && matchingOutput) {
      openedRoutePreviewRef.current = routePreviewKey;
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setSelectedGenerationId(matchingGeneration.id);
        setSelectedOutputId(matchingOutput.id);
      });
      return () => {
        cancelled = true;
      };
    }

    void fetchGeneration(initialGenerationId, { silent: true });
  }, [fetchGeneration, generations, initialGenerationId, initialOutputId]);

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
  }, [store.mode, store.showMoreOptions]);

  const canGenerate = useMemo(() => {
    const hasVeoExtendSource = store.mode === 'video' && store.provider === 'veo' && store.videoExtendSourceRef !== null;
    return store.rawPrompt.trim().length > 0 || store.productRefs.length > 0 || store.personaRefs.length > 0 || store.presetRef !== null || store.fileRefs.length > 0 || store.videoReferenceRefs.length > 0 || store.audioReferenceRefs.length > 0 || hasVeoExtendSource;
  }, [store.mode, store.provider, store.rawPrompt, store.productRefs.length, store.personaRefs.length, store.presetRef, store.fileRefs.length, store.videoReferenceRefs.length, store.audioReferenceRefs.length, store.videoExtendSourceRef]);
  const missingProviderRequirement = useMemo(
    () => getMissingProviderRequirement(providerConfig, store.mode, store.provider),
    [providerConfig, store.mode, store.provider],
  );
  const shouldShowProviderRequirement = providerConfigStatus === 'ready' && missingProviderRequirement !== null;
  const canGenerateWithProvider = canGenerate && providerConfigStatus === 'ready' && missingProviderRequirement === null;

  const isInitialGenerationLoad = generationHook.loading && generations.length === 0;
  const completedOutputCount = useMemo(
    () => generations.reduce(
      (count, generation) => count + generation.outputs.filter((output) => Boolean(output.mediaUrl)).length,
      0,
    ),
    [generations],
  );
  const hasStudioActivity = useMemo(
    () => generations.some((generation) => (
      generation.outputs.length > 0 ||
      generation.status === 'pending' ||
      generation.status === 'generating' ||
      generation.status === 'failed'
    )),
    [generations],
  );
  const hasActiveOutputFilters = mediaFilter !== 'all' || dateFilter !== 'all' || creatorFilter !== null;
  const hasNoMatchingVisibleOutputs = visibleOutputList.length === 0;
  const shouldShowInspiration = (
    !startingPointsLoading &&
    completedOutputCount < INSPIRATION_OUTPUT_THRESHOLD &&
    (!hasActiveOutputFilters || hasNoMatchingVisibleOutputs)
  );
  const inspirationPanel = shouldShowInspiration ? (
    <StartingPointsPanel
      onSelect={handleStartingPointSelect}
      startingPoints={startingPoints}
    />
  ) : null;

  const handleGenerate = async () => {
    if (providerConfigStatus !== 'ready' || missingProviderRequirement) return;

    const result = await generate(buildStudioGeneratePayload(store));

    if (result) {
      store.resetAfterGenerate();
    }
  };

  useEffect(() => {
    const request = pendingGenerateRequest ?? consumeStudioGenerateHandoff(initialGenerateRequestId);
    if (!request || startedPendingGenerateRequestRef.current === request.id) return;

    startedPendingGenerateRequestRef.current = request.id;
    clearStudioGenerateHandoff(request.id);

    (async () => {
      try {
        const result = await generate(request.payload);
        if (result && isMountedRef.current) {
          router.replace(`/studio?generation=${encodeURIComponent(result.id)}`);
        }
      } finally {
        clearGenerateRequest(request.id);
        clearStudioGenerateHandoff(request.id);
      }
    })();
  }, [clearGenerateRequest, generate, initialGenerateRequestId, pendingGenerateRequest, router]);

  const handlePasteImage = useCallback(async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('files', file, file.name);
      const res = await fetch('/api/studio/references/upload', { method: 'POST', body: formData, credentials: 'include' });
      const payload = await res.json();
      if (!res.ok || !payload.success) throw new Error(payload.error || 'Upload failed');
      if (payload.files?.length) {
        const currentState = useStudioGenerationStore.getState();
        const files = currentState.mode === 'video'
          ? payload.files.slice(0, getVideoImageReferenceBudget({
            mode: currentState.mode,
            provider: currentState.provider,
            productRefs: currentState.productRefs,
            personaRefs: currentState.personaRefs,
            styleRefs: currentState.styleRefs,
            fileRefs: currentState.fileRefs,
          }).remaining)
          : payload.files;

        for (const f of files) {
          currentState.addFileRef({ id: f.path, name: f.path.split('/').pop() || f.path, thumbnailPath: f.path });
        }
      }
    } catch (err) {
      console.error('Failed to upload pasted image', err);
    }
  }, []);

  const promptBarValue = useMemo(() => ({
    rawPrompt: store.rawPrompt,
    productRefs: store.productRefs,
    personaRefs: store.personaRefs,
    styleRefs: store.styleRefs,
    presetRef: store.presetRef,
    fileRefs: store.fileRefs,
  }), [store.rawPrompt, store.productRefs, store.personaRefs, store.styleRefs, store.presetRef, store.fileRefs]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div
            className="flex-1 min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.12),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.12),_transparent_32%)]"
            style={{ paddingBottom: promptOverlayHeight + 16 }}
          >
            <FilterBar
              mediaFilter={mediaFilter}
              onMediaFilterChange={setMediaFilter}
              dateFilter={dateFilter}
              onDateFilterChange={setDateFilter}
              sortOrder={sortOrder}
              onSortOrderChange={setSortOrder}
              creatorFilter={creatorFilter}
              onCreatorFilterChange={setCreatorFilter}
              creators={creators}
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
              onDeleteSelected={() => setShowBatchDeleteDialog(true)}
              onFavoriteSelected={handleBatchFavorite}
              onDownloadSelected={handleBatchDownload}
            />
            {hasStudioActivity && inspirationPanel && !hasNoMatchingVisibleOutputs ? (
              <div className="p-3 pb-0">
                {inspirationPanel}
              </div>
            ) : null}
            <OutputGrid
              generations={generations}
              initialLoading={isInitialGenerationLoad}
              recentlyCompletedIds={recentlyCompletedIds}
              emptyState={<EmptyState inspirationPanel={inspirationPanel} />}
              filterEmptyState={<FilteredEmptyState inspirationPanel={inspirationPanel} />}
              mediaFilter={mediaFilter}
              dateFilter={dateFilter}
              sortOrder={sortOrder}
              selectionEnabled={selectionEnabled}
              selectedOutputIds={selectedOutputIds}
              hasMoreGenerations={hasMoreGenerations}
              loadingMoreGenerations={loadingMore}
              onToggleSelectOutput={handleToggleOutputSelect}
              onLoadMoreGenerations={() => {
                void loadMoreGenerations();
              }}
              onOutputOpen={({ generation, output }) => {
                setSelectedGenerationId(generation.id);
                setSelectedOutputId(output.id);
              }}
              onToggleFavorite={(generation, output) => {
                void generationHook.toggleFavorite(generation.id, output.id, !output.isFavorite);
              }}
              onCreateVariation={applyOutputAsImageVariation}
              onCreateVideo={applyOutputAsVideoSource}
              onDelete={(generation, output) => {
                void generationHook.deleteOutput(generation.id, output.id);
                if (selectedGenerationId === generation.id && selectedOutputId === output.id) {
                  setSelectedGenerationId(null);
                  setSelectedOutputId(null);
                }
              }}
              onDeleteGeneration={(generation) => {
                void generationHook.deleteGeneration(generation.id);
                if (selectedGenerationId === generation.id) {
                  setSelectedGenerationId(null);
                  setSelectedOutputId(null);
                }
              }}
              onRemixGeneration={(generation) => {
                store.setRawPrompt(getStudioUserPrompt(generation));
                // Scroll to the prompt bar for better UX
                const promptBar = document.getElementById('studio-prompt-bar');
                if (promptBar) {
                  promptBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              }}
              onSaveToWorkspace={handleSaveSingleToWorkspace}
            />
          </div>
        </div>
      </div>

      <div
        ref={promptOverlayRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-background via-background/85 to-transparent px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-14 md:px-6"
      >
        <div className="pointer-events-auto mx-auto flex w-full max-w-5xl flex-col gap-2 rounded-[28px] border border-border/80 bg-card/95 p-3 shadow-2xl backdrop-blur-xl">
          {store.mode === 'video' ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-background/70 px-3 py-2">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('sections.frames.title')}</p>
                <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                  <Button variant="outline" size="sm" className="h-8 rounded-full" onClick={() => openPicker('start')}>
                    {t('sections.frames.startFrame')}
                  </Button>
                  {!store.isLooping && (
                    <Button variant="outline" size="sm" className="h-8 rounded-full" onClick={() => openPicker('end')}>
                      {t('sections.frames.endFrame')}
                    </Button>
                  )}
                  <label className="flex items-center gap-2 rounded-full border border-border/70 bg-card/80 px-3 py-1.5 text-xs font-medium">
                    <input
                      type="checkbox"
                      checked={store.isLooping}
                      onChange={(event) => {
                        store.setIsLooping(event.target.checked);
                        if (event.target.checked) {
                          store.setEndFramePath(null);
                        }
                      }}
                    />
                    {t('sections.frames.loopVideo')}
                  </label>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {store.startFramePath && <PreviewChip path={store.startFramePath} kind="image" />}
                {!store.isLooping && store.endFramePath && <PreviewChip path={store.endFramePath} kind="image" />}
              </div>
            </div>
          ) : null}

          <PromptBar
            value={promptBarValue}
            mode={store.mode}
            provider={store.provider}
            videoReferenceRefs={store.videoReferenceRefs}
            audioReferenceRefs={store.audioReferenceRefs}
            videoExtendSourceRef={store.videoExtendSourceRef}
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
            onRawPromptChange={store.setRawPrompt}
            onProductAdd={(product) => {
              const productRef = createModelReferenceTag(product);
              const productRefs = upsertReferenceTag(store.productRefs, productRef);
              store.setProductRefs(productRefs);
              trimFileRefsToVideoBudget({ productRefs });
            }}
            onPersonaAdd={(persona) => {
              const personaRef = createModelReferenceTag(persona);
              const personaRefs = upsertReferenceTag(store.personaRefs, personaRef);
              store.setPersonaRefs(personaRefs);
              trimFileRefsToVideoBudget({ personaRefs });
            }}
            onStyleAdd={(style) => {
              const styleRef = createModelReferenceTag(style);
              const styleRefs = upsertReferenceTag(store.styleRefs, styleRef);
              store.setStyleRefs(styleRefs);
              trimFileRefsToVideoBudget({ styleRefs });
            }}
            onPresetSelect={store.setPresetRef}
            onReferenceRemove={(type, id) => {
              if (type === 'product') store.removeProductRef(id);
              else if (type === 'persona') store.removePersonaRef(id);
              else if (type === 'style') store.removeStyleRef(id);
              else if (type === 'file') store.removeFileRef(id);
              else if (type === 'videoReference') store.removeVideoReferenceRef(id);
              else if (type === 'audioReference') store.removeAudioReferenceRef(id);
              else if (type === 'videoExtendSource') store.removeVideoExtendSourceRef();
              else if (type === 'preset') store.removePresetRef();
            }}
            onFileAdd={(paths) => {
              if (store.mode === 'video') {
                const budget = getVideoImageReferenceBudget({
                  mode: store.mode,
                  provider: store.provider,
                  productRefs: store.productRefs,
                  personaRefs: store.personaRefs,
                  styleRefs: store.styleRefs,
                  fileRefs: store.fileRefs,
                });
                for (const path of paths.slice(0, budget.remaining)) {
                  store.addFileRef({ id: path, name: path.split('/').pop() || path, thumbnailPath: path });
                }
                return;
              }

              const limit = getFileReferenceLimitForMode(store.mode, store.provider);
              const allowedPaths = typeof limit === 'number'
                ? paths.slice(0, Math.max(limit - store.fileRefs.length, 0))
                : paths;
              for (const path of allowedPaths) {
                store.addFileRef({ id: path, name: path.split('/').pop() || path, thumbnailPath: path });
              }
            }}
            onVideoReferenceAdd={(paths) => {
              for (const path of paths) {
                store.addVideoReferenceRef({ id: path, name: path.split('/').pop() || path, mediaKind: 'video' });
              }
            }}
            onAudioReferenceAdd={(paths) => {
              for (const path of paths) {
                store.addAudioReferenceRef({ id: path, name: path.split('/').pop() || path, mediaKind: 'audio' });
              }
            }}
            onVideoExtendSourceAdd={(paths) => {
              const path = paths[0];
              if (path) {
                store.setVideoExtendSourceRef({ id: path, name: path.split('/').pop() || path, mediaKind: 'video' });
              }
            }}
            onPasteImage={handlePasteImage}
          />

          {shouldShowProviderRequirement ? (
            <ProviderRequirementNotice requirement={missingProviderRequirement} />
          ) : null}

          <ControlBar
            mode={store.mode}
            onModeChange={(nextMode) => {
              store.setMode(nextMode);
              store.setCount(1);
              if (nextMode === 'video') {
                store.setProvider('veo');
                store.setModel(getDefaultModelForProvider('video', 'veo'));
                store.setAspectRatio('16:9');
                store.setVideoResolution('720p');
                store.setVideoDuration(6);
                store.setVideoGenerateAudio(true);
                store.setVideoWebSearch(false);
                store.setVideoNsfwChecker(false);
                trimFileRefsToVideoBudget({ mode: 'video', provider: 'veo' });
              } else if (nextMode === 'sound') {
                store.setProvider('gemini');
                store.setModel(getDefaultModelForProvider('sound', 'gemini'));
                store.setOutputFormat('mp3');
              } else {
                store.setProvider('gemini');
                store.setModel(getDefaultModelForProvider('image', 'gemini'));
                if (store.outputFormat === 'mp3' || store.outputFormat === 'wav') {
                  store.setOutputFormat('png');
                }
                const validRatios = getAspectRatiosForProvider('image', 'gemini');
                if (!validRatios.includes(store.aspectRatio as never)) {
                  store.setAspectRatio('1:1');
                }
              }
            }}
            presets={presets}
            selectedPreset={store.presetRef}
            onPresetChange={store.setPresetRef}
            aspectRatio={store.aspectRatio}
            onAspectRatioChange={store.setAspectRatio}
            count={store.count}
            onCountChange={store.setCount}
            provider={store.provider}
            onProviderChange={(nextProvider) => {
              store.setProvider(nextProvider);
              store.setModel(getDefaultModelForProvider(store.mode, nextProvider));
              const validRatios = getAspectRatiosForProvider(store.mode, nextProvider);
              if (!validRatios.includes(store.aspectRatio as never)) {
                store.setAspectRatio(store.mode === 'video' ? '16:9' : '1:1');
              }
              if (store.mode === 'video') {
                const nextModel = getDefaultModelForProvider(store.mode, nextProvider);
                const validRes = getVideoResolutionsForModel(nextModel);
                store.setVideoResolution(validRes.includes(store.videoResolution) ? store.videoResolution : validRes[0] as VideoResolution);
                const validDur = getVideoDurationsForModel(nextModel);
                store.setVideoDuration(validDur.includes(store.videoDuration) ? store.videoDuration : validDur.includes(6) ? 6 : validDur[0] as StudioVideoDuration);
                trimFileRefsToVideoBudget({ provider: nextProvider });
              }
              if (store.mode === 'sound') {
                store.setOutputFormat('mp3');
              }
            }}
            model={store.model}
            onModelChange={(nextModel) => {
              store.setModel(nextModel);
              const validSizes = getImageSizesForModel(nextModel);
              if (validSizes.length > 0 && !validSizes.includes(store.imageSize)) {
                store.setImageSize(validSizes[0]);
              }
              if (store.mode === 'video') {
                const validRes = getVideoResolutionsForModel(nextModel);
                if (!validRes.includes(store.videoResolution)) {
                  store.setVideoResolution(validRes[0] as VideoResolution);
                }
                const validDur = getVideoDurationsForModel(nextModel);
                if (!validDur.includes(store.videoDuration)) {
                  store.setVideoDuration(validDur.includes(6) ? 6 : validDur[0] as StudioVideoDuration);
                }
              }
              if (store.mode === 'sound' && nextModel !== 'lyria-3-pro-preview') {
                store.setOutputFormat('mp3');
              }
            }}
            quality={store.quality}
            onQualityChange={store.setQuality}
            outputFormat={store.outputFormat}
            onOutputFormatChange={store.setOutputFormat}
            background={store.background}
            onBackgroundChange={store.setBackground}
            imageSize={store.imageSize}
            onImageSizeChange={store.setImageSize}
            videoResolution={store.videoResolution}
            onVideoResolutionChange={(res) => {
              store.setVideoResolution(res);
              if (store.provider !== 'bytedance' && (res === '1080p' || res === '4k')) {
                store.setVideoDuration(8);
              }
            }}
            videoDuration={store.videoDuration}
            onVideoDurationChange={store.setVideoDuration}
            videoGenerateAudio={store.videoGenerateAudio}
            onVideoGenerateAudioChange={store.setVideoGenerateAudio}
            videoWebSearch={store.videoWebSearch}
            onVideoWebSearchChange={store.setVideoWebSearch}
            videoNsfwChecker={store.videoNsfwChecker}
            onVideoNsfwCheckerChange={store.setVideoNsfwChecker}
            onGenerate={handleGenerate}
            isGenerating={generationHook.loading}
            canGenerate={canGenerateWithProvider}
            showMoreOptions={store.showMoreOptions}
            onShowMoreOptionsChange={store.setShowMoreOptions}
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
        onEditSelection={handleOpenEditSelection}
        onUseAspectRatio={handleUseAspectRatio}
        onOpenCustomAspectRatio={handleOpenCustomAspectRatio}
        onCreateVariation={applyOutputAsImageVariation}
        onCreateVideo={applyOutputAsVideoSource}
        onDelete={(generation, output) => {
          void generationHook.deleteOutput(generation.id, output.id);
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
        onSaveToWorkspace={handleSaveSingleToWorkspace}
        onNavigate={handlePreviewNavigate}
        onClose={() => {
          setSelectedGenerationId(null);
          setSelectedOutputId(null);
        }}
      />
      <ImageEditSelectionView
        open={editSelection !== null}
        imageUrl={editSelection?.output.mediaUrl ?? null}
        imageAlt={editSelection?.output.filePath}
        isSaving={savingEditSelection}
        onClose={() => setEditSelection(null)}
        onSubmit={(payload) => {
          void handleImportEditSelection(payload);
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
      <BatchDeleteDialog
        open={showBatchDeleteDialog}
        onOpenChange={setShowBatchDeleteDialog}
        count={selectedOutputIds.length}
        onConfirm={handleBatchDelete}
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
