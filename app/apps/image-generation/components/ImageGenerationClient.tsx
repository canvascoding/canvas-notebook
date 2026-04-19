'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, RefreshCw, WandSparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AssetPickerDialog } from '@/app/apps/veo-studio/components/AssetPickerDialog';
import { toPreviewUrl, toMediaUrl } from '@/app/lib/utils/media-url';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const PROVIDERS = [
  { id: 'gemini', labelKey: 'providerOptions.gemini.label' as const },
  { id: 'openai', labelKey: 'providerOptions.openai.label' as const },
] as const;

const GEMINI_MODELS = [
  { id: 'gemini-3.1-flash-image-preview', optionKey: 'bestQuality' as const },
  { id: 'gemini-2.5-flash-image', optionKey: 'fastAffordable' as const },
] as const;

const OPENAI_MODELS = [
  { id: 'gpt-image-1.5', optionKey: 'gptImage15' as const },
  { id: 'gpt-image-1', optionKey: 'gptImage1' as const },
  { id: 'gpt-image-1-mini', optionKey: 'gptImage1Mini' as const },
] as const;

const GEMINI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
const OPENAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'auto'] as const;

const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high'] as const;
const OUTPUT_FORMAT_OPTIONS = ['png', 'jpeg', 'webp'] as const;
const BACKGROUND_OPTIONS = ['auto', 'opaque', 'transparent'] as const;

const GEMINI_MAX_IMAGE_COUNT = 4;
const OPENAI_MAX_IMAGE_COUNT = 10;
const GEMINI_MAX_REFERENCE_IMAGES = 10;
const OPENAI_MAX_REFERENCE_IMAGES = 16;

const FALLBACK_MAX_IMAGE_COUNT = 4;
const FALLBACK_MAX_REFERENCE_IMAGES = 10;

interface GeneratedResult {
  index: number;
  path?: string;
  metadataPath?: string;
  mediaUrl?: string;
  previewUrl?: string;
  error?: string;
}

interface OutputItem {
  path: string;
  mediaUrl: string;
  previewUrl: string;
}

interface GenerateResponseData {
  results: GeneratedResult[];
  successCount: number;
  failureCount: number;
  outputDir: string;
}

interface ModelOption {
  label: string;
  value: string;
  description: string;
  shortLabel: string;
}

const SAMPLE_PROMPT_META = [
  { id: 'skincareProductShot', image: '/images/examples/aura_serum_produktfoto.png' },
  { id: 'travelCampaign', image: '/images/examples/reise_banner_find_your_paradise.png' },
  { id: 'techHeroBanner', image: '/images/examples/tech_banner_future_of_innovation.png' },
  { id: 'foodCampaign', image: '/images/examples/burger_fries_food_foto.png' },
  { id: 'fashionEditorial', image: '/images/examples/streetwear_model_neon_gasse.png' },
  { id: 'beforeAfter', image: '/images/examples/wohnzimmer_before_after.png' },
] as const;

interface ImageGenerationClientProps {
  availableProviders?: string[];
}

export function ImageGenerationClient({ availableProviders }: ImageGenerationClientProps) {
  const t = useTranslations('imageGeneration');
  const [provider, setProvider] = useState<string>(() => {
    if (availableProviders?.includes('gemini')) return 'gemini';
    if (availableProviders?.includes('openai')) return 'openai';
    return 'gemini';
  });

  const modelOptions: ModelOption[] = useMemo(() => {
    const models = provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
    return models.map((m) => ({
      value: m.id,
      label: t(`modelOptions.${m.optionKey}.label`),
      shortLabel: t(`modelOptions.${m.optionKey}.shortLabel`),
      description: t(`modelOptions.${m.optionKey}.description`),
    }));
  }, [provider, t]);

  const aspectRatios = provider === 'openai' ? OPENAI_ASPECT_RATIOS : GEMINI_ASPECT_RATIOS;
  const maxImageCount = provider === 'openai' ? OPENAI_MAX_IMAGE_COUNT : GEMINI_MAX_IMAGE_COUNT;
  const maxReferenceImages = provider === 'openai' ? OPENAI_MAX_REFERENCE_IMAGES : GEMINI_MAX_REFERENCE_IMAGES;

  const samplePrompts = SAMPLE_PROMPT_META.map((item) => ({
    image: item.image,
    label: t(`samplePrompts.${item.id}.label`),
    prompt: t(`samplePrompts.${item.id}.prompt`),
  }));

  const [model, setModel] = useState<string>(GEMINI_MODELS[0].id);
  const [aspectRatio, setAspectRatio] = useState<string>('1:1');
  const [imageCount, setImageCount] = useState(1);
  const [referenceImagePaths, setReferenceImagePaths] = useState<string[]>([]);
  const [quality, setQuality] = useState<'low' | 'medium' | 'high' | 'auto'>('auto');
  const [outputFormat, setOutputFormat] = useState<'png' | 'jpeg' | 'webp'>('png');
  const [background, setBackground] = useState<'transparent' | 'opaque' | 'auto'>('auto');

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedResult[]>([]);

  const [isLoadingOutputs, setIsLoadingOutputs] = useState(false);
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState<OutputItem | null>(null);

  useEffect(() => {
    const models = provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
    setModel(models[0].id);
    if (!aspectRatios.includes(aspectRatio as never)) {
      setAspectRatio('1:1');
    }
    if (imageCount > maxImageCount) {
      setImageCount(maxImageCount);
    }
    if (referenceImagePaths.length > maxReferenceImages) {
      setReferenceImagePaths((prev) => prev.slice(0, maxReferenceImages));
    }
  }, [provider]);

  const [promptText, setPromptText] = useState('');

  const canGenerate = useMemo(() => {
    return !isGenerating && (promptText.trim().length > 0 || referenceImagePaths.length > 0);
  }, [isGenerating, promptText, referenceImagePaths.length]);

  const loadOutputs = async () => {
    setIsLoadingOutputs(true);
    try {
      const response = await fetch(
        `/api/image-generation/assets?q=${encodeURIComponent('image-generation/generations')}&limit=60`,
        { credentials: 'include', cache: 'no-store' }
      );
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.loadOutputs'));
      }

      const items: OutputItem[] = (payload.data || []).map(
        (item: { path: string; mediaUrl: string; previewUrl: string }) => ({
          path: item.path,
          mediaUrl: item.mediaUrl,
          previewUrl: item.previewUrl,
        })
      );
      setOutputItems(items);
    } catch {
      setOutputItems([]);
    } finally {
      setIsLoadingOutputs(false);
    }
  };

  useEffect(() => {
    void loadOutputs();
  }, []);

  const handleGenerate = async () => {
    setError(null);
    setResults([]);
    setIsGenerating(true);

    try {
      const body: Record<string, unknown> = {
        prompt: promptText,
        provider,
        model,
        aspectRatio,
        imageCount,
        referenceImagePaths,
      };
      if (provider === 'openai') {
        body.quality = quality;
        body.outputFormat = outputFormat;
        body.background = background;
      }

      const response = await fetch('/api/image-generation/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const payload = await response.json();
      const data = payload.data as GenerateResponseData | undefined;

      if (!response.ok || !payload.success) {
        setResults(data?.results || []);
        throw new Error(payload.error || t('errors.generate'));
      }

      setResults(data?.results || []);
      if ((data?.failureCount || 0) > 0) {
        setError(t('errors.partialFailure', { count: data?.failureCount || 0 }));
      }

      await loadOutputs();
    } catch (generateError) {
      const message = generateError instanceof Error ? generateError.message : t('errors.generate');
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const removeReference = (refPath: string) => {
    setReferenceImagePaths((current) => current.filter((item) => item !== refPath));
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('cardTitle')}</CardTitle>
          <CardDescription>
            {t('cardDescription', { count: maxImageCount })}{' '}
            <span className="font-mono">image-generation/generations</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('providerField')}</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id} disabled={availableProviders && !availableProviders.includes(p.id)}>
                    {t(p.labelKey)}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('fields.model')}</span>
                <select
                  className="h-9 border border-input bg-background px-2 text-sm"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {(() => {
                const selectedModel = modelOptions.find((m) => m.value === model);
                return selectedModel ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">{selectedModel.shortLabel}:</span>{' '}
                    {selectedModel.description}
                  </p>
                ) : null;
              })()}
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('fields.aspectRatio')}</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={aspectRatio}
                onChange={(event) => setAspectRatio(event.target.value)}
              >
                {aspectRatios.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio === '4:3' && provider === 'openai' ? '4:3 (nearest: 1536x1024)' : ratio === '3:4' && provider === 'openai' ? '3:4 (nearest: 1024x1536)' : ratio}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('fields.imageCount')}</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={imageCount}
                onChange={(event) => setImageCount(Number(event.target.value))}
              >
                {Array.from({ length: maxImageCount }, (_, index) => index + 1).map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {provider === 'openai' && (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('fields.quality')}</span>
                <select
                  className="h-9 border border-input bg-background px-2 text-sm"
                  value={quality}
                  onChange={(event) => setQuality(event.target.value as typeof quality)}
                >
                  {QUALITY_OPTIONS.map((q) => (
                    <option key={q} value={q}>
                      {t(`qualityOptions.${q}.label`)} — {t(`qualityOptions.${q}.description`)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('fields.outputFormat')}</span>
                <select
                  className="h-9 border border-input bg-background px-2 text-sm"
                  value={outputFormat}
                  onChange={(event) => setOutputFormat(event.target.value as typeof outputFormat)}
                >
                  {OUTPUT_FORMAT_OPTIONS.map((fmt) => (
                    <option key={fmt} value={fmt}>
                      {t(`outputFormatOptions.${fmt}.label`)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">{t('fields.background')}</span>
                <select
                  className="h-9 border border-input bg-background px-2 text-sm"
                  value={background}
                  onChange={(event) => setBackground(event.target.value as typeof background)}
                >
                  {BACKGROUND_OPTIONS.map((bg) => (
                    <option key={bg} value={bg}>
                      {t(`backgroundOptions.${bg}.label`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t('fields.referenceImages')}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setPickerOpen(true)}>
                {t('actions.selectReferences')}
              </Button>
              <span className="text-xs text-muted-foreground">{referenceImagePaths.length}/{maxReferenceImages}</span>
            </div>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t('fields.prompt')}</span>
            <textarea
              className="min-h-[110px] border border-input bg-background px-3 py-2 text-sm"
              placeholder={t('promptPlaceholder')}
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
            />
          </label>

          <div className="space-y-2 border border-border bg-background p-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('promptIdeas')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
              {samplePrompts.map((item) => (
                <button
                  key={item.image}
                  type="button"
                  onClick={() => setPromptText(item.prompt)}
                  className="group border border-border bg-muted text-left transition hover:border-primary/50 overflow-hidden"
                  title={item.prompt}
                >
                  <img
                    src={item.image}
                    alt={item.label}
                    className="w-full aspect-[4/3] object-cover transition group-hover:opacity-90"
                  />
                  <p className="px-1.5 py-1 text-xs text-muted-foreground truncate group-hover:text-foreground">
                    {item.label}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {referenceImagePaths.length > 0 && (
            <div className="space-y-2 border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('referenceSection.title')}</p>
                <p className="text-xs text-muted-foreground">
                  {referenceImagePaths.length}/{maxReferenceImages}
                </p>
              </div>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {referenceImagePaths.map((refPath) => (
                  <div key={refPath} className="border border-border bg-card p-2">
                    <div className="relative">
                      <img
                        src={toPreviewUrl(refPath, 260, { preset: 'mini' })}
                        alt={refPath}
                        className="aspect-square w-full bg-muted object-cover max-h-[120px] sm:max-h-[150px]"
                        loading="lazy"
                        decoding="async"
                      />
                      <button
                        type="button"
                        onClick={() => removeReference(refPath)}
                        className="absolute right-1 top-1 border border-border bg-background p-1.5 sm:p-1 min-w-[28px] min-h-[28px] sm:min-w-[24px] sm:min-h-[24px] flex items-center justify-center"
                        aria-label={t('referenceSection.removeReference')}
                      >
                        <X className="h-4 w-4 sm:h-3 sm:w-3" />
                      </button>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={refPath}>
                      {refPath}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
            <Button className="gap-2 w-full sm:w-auto" onClick={handleGenerate} disabled={!canGenerate}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
              {isGenerating ? t('actions.generating') : t('actions.generateWithCount', { count: imageCount })}
            </Button>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => void loadOutputs()} disabled={isLoadingOutputs}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingOutputs ? 'animate-spin' : ''}`} />
              {t('actions.refresh')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('currentResults.title')}</CardTitle>
          <CardDescription>{t('currentResults.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('currentResults.empty')}</p>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              {results.map((result) => (
                <div key={result.index} className="border border-border bg-background p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">{t('currentResults.variation', { index: result.index + 1 })}</p>
                    {result.path ? (
                      <a href={`/api/files/download?path=${encodeURIComponent(result.path)}`} download className="text-xs text-primary hover:underline">
                        {t('actions.download')}
                      </a>
                    ) : null}
                  </div>
                  {result.error ? (
                    <p className="text-sm text-destructive">{result.error}</p>
                  ) : result.previewUrl ?? result.mediaUrl ? (
                    <img src={result.previewUrl ?? result.mediaUrl} alt={t('currentResults.variation', { index: result.index + 1 })} className="w-full h-auto border border-border bg-muted object-contain" />
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('currentResults.noImage')}</p>
                  )}
                  {result.path ? <p className="mt-2 truncate text-xs text-muted-foreground">{result.path}</p> : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('savedOutputs.title')}</CardTitle>
          <CardDescription>{t('savedOutputs.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {outputItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('savedOutputs.empty')}</p>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {outputItems.map((item) => (
                <button
                  key={item.path}
                  onClick={() => setPreviewItem(item)}
                  className="border border-border bg-background p-2 text-left transition hover:border-primary/40 hover:bg-accent"
                >
                  <img src={item.previewUrl} alt={item.path} className="w-full h-auto bg-muted object-contain" />
                  <p className="mt-1 truncate text-xs text-muted-foreground">{item.path}</p>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AssetPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        kind="image"
        multiple
        maxSelection={maxReferenceImages}
        assetApiPath="/api/image-generation/assets"
        uploadPath="image-generation/assets"
        onConfirm={(paths) => setReferenceImagePaths(paths.slice(0, maxReferenceImages))}
      />

      <Dialog open={!!previewItem} onOpenChange={(open) => !open && setPreviewItem(null)}>
        <DialogContent layout="viewport" className="p-0">
          <DialogHeader className="border-b bg-muted/50 px-4 py-3">
            <DialogTitle className="text-base font-medium truncate">
              {previewItem?.path}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-1 items-center justify-center bg-background p-4">
            {previewItem && (
              <img
                src={toMediaUrl(previewItem.path)}
                alt={previewItem.path}
                className="max-h-[calc(100dvh-8rem)] max-w-full object-contain"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}