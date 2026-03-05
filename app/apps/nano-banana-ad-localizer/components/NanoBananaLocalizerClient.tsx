'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw, WandSparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AssetPickerDialog } from '@/app/apps/veo-studio/components/AssetPickerDialog';
import { toPreviewUrl } from '@/app/lib/utils/media-url';

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
  'United States',
  'United Kingdom',
  'Germany',
  'France',
  'Spain',
  'Italy',
  'Portugal',
  'Netherlands',
  'Belgium',
  'Poland',
  'Sweden',
  'Norway',
  'Denmark',
  'Czech Republic',
  'Turkey',
  'United Arab Emirates',
  'Saudi Arabia',
  'India',
  'Japan',
  'South Korea',
  'Thailand',
  'Vietnam',
  'Indonesia',
  'Mexico',
  'Brazil',
  'Argentina',
  'Canada',
  'Australia',
];

const MODEL_OPTIONS = [
  { label: 'Gemini 3.1 Flash Image Preview', value: 'gemini-3.1-flash-image-preview' },
  { label: 'Gemini 2.5 Flash Image Preview', value: 'gemini-2.5-flash-image-preview' },
];

const ASPECT_RATIOS = ['16:9', '1:1', '9:16', '4:3', '3:4'] as const;

export function NanoBananaLocalizerClient() {
  const [referenceImagePath, setReferenceImagePath] = useState<string | null>(null);
  const [targetMarkets, setTargetMarkets] = useState<string[]>([]);
  const [marketInput, setMarketInput] = useState('');
  const [model, setModel] = useState(MODEL_OPTIONS[0].value);
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>('16:9');
  const [customInstructions, setCustomInstructions] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<LocalizedResult[]>([]);
  const [isLoadingOutputs, setIsLoadingOutputs] = useState(false);
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

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
        throw new Error(payload.error || 'Failed to load localized outputs');
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
        throw new Error(payload.error || 'Localization failed');
      }

      setResults(data?.results || []);
      if ((data?.failureCount || 0) > 0) {
        setError(`${data?.failureCount} Markt/Märkte konnten nicht lokalisiert werden.`);
      }
      await loadOutputs();
    } catch (localizeError) {
      const message = localizeError instanceof Error ? localizeError.message : 'Localization failed';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Nano Banana Ad Localizer</CardTitle>
          <CardDescription>
            Referenziere eine bestehende Ad, lokalisiere die Texte für Zielmärkte und speichere Ergebnisse im Workspace unter{' '}
            <span className="font-mono">nano-banana-ad-localizer/localizations</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Model</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {MODEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Aspect Ratio</span>
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
              <span className="text-xs text-muted-foreground">Reference Ad</span>
              <Button variant="outline" onClick={() => setPickerOpen(true)}>
                Referenzbild wählen
              </Button>
            </div>
          </div>

          {referenceImagePath ? (
            <div className="flex items-center gap-3 border border-border bg-background p-2">
              <img
                src={toPreviewUrl(referenceImagePath, 280)}
                alt={referenceImagePath}
                className="h-20 w-28 border border-border bg-muted object-cover"
              />
              <div className="min-w-0 text-xs text-muted-foreground">
                <p className="truncate font-medium text-foreground">Ausgewähltes Referenzbild</p>
                <p className="truncate font-mono">{referenceImagePath}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Noch kein Referenzbild ausgewählt.</p>
          )}

          <div className="space-y-2 border border-border bg-background p-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Target Markets</p>
            <div className="flex gap-2">
              <Input
                placeholder="Markt/Land hinzufügen (z. B. Germany)"
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
              <Button type="button" variant="outline" onClick={() => addMarket(marketInput)}>
                <Plus className="mr-1 h-4 w-4" />
                Hinzufügen
              </Button>
            </div>
            <datalist id="nano-banana-market-options">
              {TARGET_MARKET_OPTIONS.map((market) => (
                <option key={market} value={market} />
              ))}
            </datalist>

            {targetMarkets.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {targetMarkets.map((market) => (
                  <button
                    key={market}
                    type="button"
                    onClick={() => removeMarket(market)}
                    className="inline-flex items-center gap-1 border border-border bg-muted px-2 py-1 text-xs"
                  >
                    {market}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Noch keine Zielmärkte ausgewählt.</p>
            )}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Zusätzliche Hinweise (optional)</span>
            <textarea
              className="min-h-[84px] border border-input bg-background px-3 py-2 text-sm"
              placeholder="Optional: Tonalität, Terminologie oder Brand-Vorgaben..."
              value={customInstructions}
              onChange={(event) => setCustomInstructions(event.target.value)}
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button className="gap-2" onClick={handleGenerate} disabled={!canGenerate}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
              {isGenerating ? 'Lokalisiere...' : 'Ads lokalisieren'}
            </Button>
            <Button variant="outline" onClick={() => void loadOutputs()} disabled={isLoadingOutputs}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingOutputs ? 'animate-spin' : ''}`} />
              Output aktualisieren
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Aktuelle Ergebnisse</CardTitle>
          <CardDescription>Ergebnisse aus dem letzten Lauf je Zielmarkt.</CardDescription>
        </CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch keine Lokalisierung in dieser Session.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {results.map((result) => (
                <div key={result.market} className="border border-border bg-background p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold">{result.market}</p>
                    {result.mediaUrl ? (
                      <a href={result.mediaUrl} download className="text-xs text-primary hover:underline">
                        Download
                      </a>
                    ) : null}
                  </div>
                  {result.error ? (
                    <p className="text-sm text-destructive">{result.error}</p>
                  ) : result.mediaUrl ? (
                    <img src={result.mediaUrl} alt={result.market} className="aspect-video w-full border border-border bg-muted object-cover" />
                  ) : (
                    <p className="text-sm text-muted-foreground">Kein Bild zurückgegeben.</p>
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
          <CardTitle>localizations</CardTitle>
          <CardDescription>Zuletzt gespeicherte Bilder aus dem Workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {outputItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch keine lokalisierten Ads im Output-Ordner gefunden.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {outputItems.map((item) => (
                <a key={item.path} href={item.mediaUrl} target="_blank" rel="noreferrer" className="border border-border bg-background p-2">
                  <img src={item.previewUrl} alt={item.path} className="aspect-video w-full bg-muted object-cover" />
                  <p className="mt-1 truncate text-xs text-muted-foreground">{item.path}</p>
                </a>
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
    </div>
  );
}
