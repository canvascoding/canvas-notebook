'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, WandSparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AssetPickerDialog } from '@/app/apps/veo-studio/components/AssetPickerDialog';
import { toPreviewUrl } from '@/app/lib/utils/media-url';

interface GeneratedResult {
  index: number;
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

interface GenerateResponseData {
  results: GeneratedResult[];
  successCount: number;
  failureCount: number;
  outputDir: string;
}

const SAMPLE_PROMPTS = [
  'Premium product shot of a minimalist skincare bottle on a marble pedestal, soft studio lighting, clean luxury branding',
  'Instagram ad creative for a summer travel campaign, bold typography space, vibrant tropical colors, modern marketing style',
  'Hero banner scene for a SaaS landing page, abstract 3D shapes, professional corporate palette, high-end tech aesthetic',
  'Food campaign visual with dramatic lighting, gourmet burger and fries, high contrast commercial photography look',
  'Fashion e-commerce editorial: streetwear model in urban setting, cinematic lighting, high-detail fabric textures',
  'Before-and-after style concept image for a home cleaning brand, split composition, bright and trustworthy tone',
] as const;

const MAX_IMAGE_COUNT = 4;
const MAX_REFERENCE_IMAGES = 10;

interface ModelOption {
  label: string;
  value: string;
  description: string;
  shortLabel: string;
}

const MODEL_OPTIONS: ModelOption[] = [
  {
    label: '🎨 Best Quality & Features',
    value: 'gemini-3.1-flash-image-preview',
    shortLabel: 'Gemini 3.1 Flash Image',
    description: 'Latest model with highest quality and more capabilities. Supports up to 14 reference images and advanced features like grounding. Best for professional results.',
  },
  {
    label: '⚡ Fast & Affordable',
    value: 'gemini-2.5-flash-image',
    shortLabel: 'Gemini 2.5 Flash Image',
    description: 'Fast generation at lower cost. Supports up to 3 reference images. Perfect for quick drafts, simple images, and when speed matters.',
  },
] as const;
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;

export function ImageGenerationClient() {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>(MODEL_OPTIONS[0].value);
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>('1:1');
  const [imageCount, setImageCount] = useState(MAX_IMAGE_COUNT);
  const [referenceImagePaths, setReferenceImagePaths] = useState<string[]>([]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedResult[]>([]);

  const [isLoadingOutputs, setIsLoadingOutputs] = useState(false);
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const canGenerate = useMemo(() => {
    return !isGenerating && (prompt.trim().length > 0 || referenceImagePaths.length > 0);
  }, [isGenerating, prompt, referenceImagePaths.length]);

  const loadOutputs = async () => {
    setIsLoadingOutputs(true);
    try {
      const response = await fetch(
        `/api/image-generation/assets?q=${encodeURIComponent('image-generation/generations')}&limit=60`,
        { credentials: 'include', cache: 'no-store' }
      );
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to load image generation outputs');
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
      const response = await fetch('/api/image-generation/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          prompt,
          model,
          aspectRatio,
          imageCount,
          referenceImagePaths,
        }),
      });

      const payload = await response.json();
      const data = payload.data as GenerateResponseData | undefined;

      if (!response.ok || !payload.success) {
        setResults(data?.results || []);
        throw new Error(payload.error || 'Image generation failed');
      }

      setResults(data?.results || []);
      if ((data?.failureCount || 0) > 0) {
        setError(`${data?.failureCount} Variation(en) konnten nicht erzeugt werden.`);
      }

      await loadOutputs();
    } catch (generateError) {
      const message = generateError instanceof Error ? generateError.message : 'Image generation failed';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const removeReference = (path: string) => {
    setReferenceImagePaths((current) => current.filter((item) => item !== path));
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
      <Card>
        <CardHeader>
          <CardTitle>AI Studio Image Generator</CardTitle>
          <CardDescription>
            Generiere bis zu {MAX_IMAGE_COUNT} Bildvariationen mit Prompt und optionalen Referenzbildern. Ausgabe im Workspace unter{' '}
            <span className="font-mono">image-generation/generations</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
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
              {(() => {
                const selectedModel = MODEL_OPTIONS.find((m) => m.value === model);
                return selectedModel ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">{selectedModel.shortLabel}:</span>{' '}
                    {selectedModel.description}
                  </p>
                ) : null;
              })()}
            </div>

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

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Anzahl Variationen</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={imageCount}
                onChange={(event) => setImageCount(Number(event.target.value))}
              >
                {Array.from({ length: MAX_IMAGE_COUNT }, (_, index) => index + 1).map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Reference Images</span>
              <Button variant="outline" onClick={() => setPickerOpen(true)}>
                Referenzen wählen
              </Button>
            </div>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Prompt</span>
            <textarea
              className="min-h-[110px] border border-input bg-background px-3 py-2 text-sm"
              placeholder="Beschreibe das gewünschte Bild..."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          <div className="space-y-2 border border-border bg-background p-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Prompt Ideen</p>
            <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto">
              {SAMPLE_PROMPTS.map((samplePrompt) => (
                <button
                  key={samplePrompt}
                  type="button"
                  onClick={() => setPrompt(samplePrompt)}
                  className="border border-border bg-muted px-2 py-1 text-left text-xs text-muted-foreground transition hover:border-primary/50 hover:text-foreground max-w-full"
                >
                  {samplePrompt}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2 border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Reference Images</p>
              <p className="text-xs text-muted-foreground">
                {referenceImagePaths.length}/{MAX_REFERENCE_IMAGES}
              </p>
            </div>

            {referenceImagePaths.length > 0 ? (
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {referenceImagePaths.map((path) => (
                    <div key={path} className="border border-border bg-card p-2">
                      <div className="relative">
                        <img
                          src={toPreviewUrl(path, 260, { preset: 'mini' })}
                          alt={path}
                          className="aspect-square w-full bg-muted object-cover max-h-[120px] sm:max-h-[150px]"
                          loading="lazy"
                          decoding="async"
                        />
                        <button
                          type="button"
                        onClick={() => removeReference(path)}
                        className="absolute right-1 top-1 border border-border bg-background p-1.5 sm:p-1 min-w-[28px] min-h-[28px] sm:min-w-[24px] sm:min-h-[24px] flex items-center justify-center"
                        aria-label="Referenz entfernen"
                      >
                        <X className="h-4 w-4 sm:h-3 sm:w-3" />
                      </button>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={path}>
                      {path}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Noch keine Referenzbilder ausgewählt.</p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
            <Button className="gap-2 w-full sm:w-auto" onClick={handleGenerate} disabled={!canGenerate}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
              {isGenerating ? 'Generiere...' : `Generieren (${imageCount})`}
            </Button>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => void loadOutputs()} disabled={isLoadingOutputs}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingOutputs ? 'animate-spin' : ''}`} />
              Aktualisieren
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Aktuelle Ergebnisse</CardTitle>
          <CardDescription>Ergebnisse aus dem letzten Generierungslauf.</CardDescription>
        </CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch keine Generierung in dieser Session.</p>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              {results.map((result) => (
                <div key={result.index} className="border border-border bg-background p-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">Variation {result.index + 1}</p>
                    {result.mediaUrl ? (
                      <a href={result.mediaUrl} download className="text-xs text-primary hover:underline">
                        Download
                      </a>
                    ) : null}
                  </div>
                  {result.error ? (
                    <p className="text-sm text-destructive">{result.error}</p>
                  ) : result.mediaUrl ? (
                    <img src={result.mediaUrl} alt={`Variation ${result.index + 1}`} className="aspect-square w-full border border-border bg-muted object-cover max-h-[300px] sm:max-h-[400px]" />
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
          <CardTitle>generations</CardTitle>
          <CardDescription>Zuletzt gespeicherte Bilder aus dem Workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {outputItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch keine Bilder im Output-Ordner gefunden.</p>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {outputItems.map((item) => (
                <a key={item.path} href={item.previewUrl} target="_blank" rel="noreferrer" className="border border-border bg-background p-2">
                  <img src={item.previewUrl} alt={item.path} className="aspect-square w-full bg-muted object-cover max-h-[250px] sm:max-h-[300px]" />
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
        multiple
        maxSelection={MAX_REFERENCE_IMAGES}
        assetApiPath="/api/image-generation/assets"
        uploadPath="image-generation/assets"
        onConfirm={(paths) => setReferenceImagePaths(paths.slice(0, MAX_REFERENCE_IMAGES))}
      />
    </div>
  );
}
