'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, RefreshCw, WandSparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AssetPickerDialog } from '@/app/apps/veo-studio/components/AssetPickerDialog';
import { toPreviewUrl, toMediaUrl } from '@/app/lib/utils/media-url';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface LocalizedResult {
  market: string;
  path?: string;
  metadataPath?: string;
  mediaUrl?: string;
  error?: string;
}

interface OutputItem {
  path: string;
  mediaUrl: string;
  previewUrl: string;
}

interface LocalizeResponseData {
  results: LocalizedResult[];
  successCount: number;
  failureCount: number;
  outputDir: string;
}

const TARGET_MARKET_OPTIONS = [
  { id: 'unitedStates' },
  { id: 'unitedKingdom' },
  { id: 'germany' },
  { id: 'france' },
  { id: 'spain' },
  { id: 'italy' },
  { id: 'portugal' },
  { id: 'netherlands' },
  { id: 'belgium' },
  { id: 'poland' },
  { id: 'sweden' },
  { id: 'norway' },
  { id: 'denmark' },
  { id: 'czechRepublic' },
  { id: 'turkey' },
  { id: 'unitedArabEmirates' },
  { id: 'saudiArabia' },
  { id: 'india' },
  { id: 'japan' },
  { id: 'southKorea' },
  { id: 'thailand' },
  { id: 'vietnam' },
  { id: 'indonesia' },
  { id: 'mexico' },
  { id: 'brazil' },
  { id: 'argentina' },
  { id: 'canada' },
  { id: 'australia' },
] as const;

interface ModelOption {
  label: string;
  value: string;
  description: string;
  shortLabel: string;
}

const MODEL_OPTION_META = [
  { id: 'bestQuality', value: 'gemini-3.1-flash-image-preview' },
  { id: 'fastAffordable', value: 'gemini-2.5-flash-image' },
] as const;

const ASPECT_RATIOS = ['16:9', '1:1', '9:16', '4:3', '3:4'] as const;

export function NanoBananaLocalizerClient() {
  const t = useTranslations('nanoBanana');
  const modelOptions: ModelOption[] = MODEL_OPTION_META.map((option) => ({
    label: t(`modelOptions.${option.id}.label`),
    value: option.value,
    shortLabel: t(`modelOptions.${option.id}.shortLabel`),
    description: t(`modelOptions.${option.id}.description`),
  }));
  const targetMarketOptions = TARGET_MARKET_OPTIONS.map((market) => t(`markets.${market.id}`));
  const [referenceImagePath, setReferenceImagePath] = useState<string | null>(null);
  const [targetMarkets, setTargetMarkets] = useState<string[]>([]);
  const [marketInput, setMarketInput] = useState('');
  const [model, setModel] = useState<string>(MODEL_OPTION_META[0].value);
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>('16:9');
  const [customInstructions, setCustomInstructions] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<LocalizedResult[]>([]);
  const [isLoadingOutputs, setIsLoadingOutputs] = useState(false);
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState<OutputItem | null>(null);

  const canGenerate = useMemo(() => {
    return Boolean(referenceImagePath) && targetMarkets.length > 0 && !isGenerating;
  }, [referenceImagePath, targetMarkets.length, isGenerating]);

  const loadOutputs = async () => {
    setIsLoadingOutputs(true);
    try {
      const response = await fetch(
        `/api/nano-banana/assets?kind=image&q=${encodeURIComponent('nano-banana-ad-localizer/localizations')}&limit=40`,
        { credentials: 'include', cache: 'no-store' }
      );
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('errors.loadOutputs'));
      }
      const items: OutputItem[] = (payload.data || []).map((item: { path: string; mediaUrl: string; previewUrl: string }) => ({
        path: item.path,
        mediaUrl: item.mediaUrl,
        previewUrl: item.previewUrl,
      }));
      setOutputItems(items);
    } catch {
      setOutputItems([]);
    } finally {
      setIsLoadingOutputs(false);
    }
  };

  useEffect(() => {
    void loadOutputs();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; loadOutputs is a plain function
  }, []);

  const addMarket = (raw: string) => {
    const market = raw.trim().replace(/\s+/g, ' ');
    if (!market) {
      return;
    }

    setTargetMarkets((current) => {
      if (current.some((entry) => entry.toLowerCase() === market.toLowerCase())) {
        return current;
      }
      return [...current, market];
    });
    setMarketInput('');
  };

  const removeMarket = (market: string) => {
    setTargetMarkets((current) => current.filter((item) => item !== market));
  };

  const handleGenerate = async () => {
    if (!referenceImagePath || targetMarkets.length === 0) {
      return;
    }

    setError(null);
    setResults([]);
    setIsGenerating(true);

    try {
      const response = await fetch('/api/nano-banana/localize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          referenceImagePath,
          targetMarkets,
          model,
          aspectRatio,
          customInstructions,
        }),
      });
      const payload = await response.json();
      const data = payload.data as LocalizeResponseData | undefined;

      if (!response.ok || !payload.success) {
        setResults(data?.results || []);
        throw new Error(payload.error || t('errors.localize'));
      }

      setResults(data?.results || []);
      if ((data?.failureCount || 0) > 0) {
        setError(t('errors.partialFailure', { count: data?.failureCount || 0 }));
      }
      await loadOutputs();
    } catch (localizeError) {
      const message = localizeError instanceof Error ? localizeError.message : t('errors.localize');
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
      <Card id="onboarding-localizer-reference">
        <CardHeader>
          <CardTitle>{t('cardTitle')}</CardTitle>
          <CardDescription>
            {t('cardDescription')}{' '}
            <span className="font-mono">nano-banana-ad-localizer/localizations</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
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
                onChange={(event) => setAspectRatio(event.target.value as (typeof ASPECT_RATIOS)[number])}
              >
                {ASPECT_RATIOS.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">{t('fields.referenceAd')}</span>
              <Button variant="outline" onClick={() => setPickerOpen(true)}>
                {t('actions.selectReference')}
              </Button>
            </div>
          </div>

          {referenceImagePath ? (
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 border border-border bg-background p-2">
              <img
                src={toPreviewUrl(referenceImagePath, 280, { preset: 'mini' })}
                alt={referenceImagePath}
                className="h-24 w-32 sm:h-20 sm:w-28 border border-border bg-muted object-cover flex-shrink-0"
                loading="lazy"
                decoding="async"
              />
              <div className="min-w-0 text-xs text-muted-foreground flex-1">
                <p className="truncate font-medium text-foreground">{t('selectedReference')}</p>
                <p className="truncate font-mono hidden sm:block">{referenceImagePath}</p>
                <p className="text-xs text-muted-foreground sm:hidden">{referenceImagePath.split('/').pop()}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('referenceEmpty')}</p>
          )}

          <div id="onboarding-localizer-markets" className="space-y-2 border border-border bg-background p-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('fields.targetMarkets')}</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder={t('targetMarketsPlaceholder', { example: t('markets.germany') })}
                value={marketInput}
                list="nano-banana-market-options"
                onChange={(event) => setMarketInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addMarket(marketInput);
                  }
                }}
              />
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => addMarket(marketInput)}>
                <Plus className="mr-1 h-4 w-4" />
                {t('actions.addMarket')}
              </Button>
            </div>
            <datalist id="nano-banana-market-options">
              {targetMarketOptions.map((market) => (
                <option key={market} value={market} />
              ))}
            </datalist>

            {targetMarkets.length > 0 ? (
              <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto">
                {targetMarkets.map((market) => (
                  <button
                    key={market}
                    type="button"
                    onClick={() => removeMarket(market)}
                    className="inline-flex items-center gap-1 border border-border bg-muted px-2 py-1.5 sm:py-1 text-xs min-h-[32px] sm:min-h-[28px]"
                  >
                    {market}
                    <X className="h-4 w-4 sm:h-3 sm:w-3" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('targetMarketsEmpty')}</p>
            )}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t('fields.customInstructions')}</span>
            <textarea
              className="min-h-[84px] border border-input bg-background px-3 py-2 text-sm"
              placeholder={t('customInstructionsPlaceholder')}
              value={customInstructions}
              onChange={(event) => setCustomInstructions(event.target.value)}
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
            <Button className="gap-2 w-full sm:w-auto" onClick={handleGenerate} disabled={!canGenerate}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
              {isGenerating ? t('actions.localizing') : t('actions.localize')}
            </Button>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => void loadOutputs()} disabled={isLoadingOutputs}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingOutputs ? 'animate-spin' : ''}`} />
              {t('actions.refresh')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card id="onboarding-localizer-results">
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
                <div key={result.market} className="border border-border bg-background p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold">{result.market}</p>
                    {result.mediaUrl ? (
                      <a href={result.mediaUrl} download className="text-xs text-primary hover:underline">
                        {t('actions.download')}
                      </a>
                    ) : null}
                  </div>
                  {result.error ? (
                    <p className="text-sm text-destructive">{result.error}</p>
                  ) : result.mediaUrl ? (
                    <img src={result.mediaUrl} alt={result.market} className="aspect-video w-full border border-border bg-muted object-cover max-h-[250px] sm:max-h-[300px]" />
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
                  <img src={item.previewUrl} alt={item.path} className="aspect-video w-full bg-muted object-cover max-h-[200px] sm:max-h-[250px]" />
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
        multiple={false}
        maxSelection={1}
        assetApiPath="/api/nano-banana/assets"
        uploadPath="nano-banana-ad-localizer/assets"
        onConfirm={(paths) => setReferenceImagePath(paths[0] || null)}
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
