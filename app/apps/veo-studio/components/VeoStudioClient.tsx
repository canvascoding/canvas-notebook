'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AssetPickerDialog } from '@/app/apps/veo-studio/components/AssetPickerDialog';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type GenerationMode = 'text_to_video' | 'frames_to_video' | 'references_to_video' | 'extend_video';

interface OutputItem {
  path: string;
  mediaUrl: string;
  previewUrl: string;
}

interface GenerateResponseData {
  path: string;
  metadataPath: string;
  mediaUrl: string;
}

const MODE_LABELS: Record<GenerationMode, string> = {
  text_to_video: 'Text to Video',
  frames_to_video: 'Frames to Video',
  references_to_video: 'References to Video',
  extend_video: 'Extend Video',
};

function PreviewChip({ path, kind }: { path: string; kind: 'image' | 'video' }) {
  const name = path.split('/').pop() || path;

  return (
    <div className="flex items-center gap-2 border border-border bg-background px-2 py-1.5 sm:py-1">
      <div className="h-12 w-16 sm:h-10 sm:w-14 overflow-hidden bg-muted flex-shrink-0">
        {kind === 'image' ? (
          <img
            src={toPreviewUrl(path, 200, { preset: 'mini' })}
            alt={name}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
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

export function VeoStudioClient() {
  const [mode, setMode] = useState<GenerationMode>('text_to_video');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('veo-3.1-fast-generate-preview');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [resolution, setResolution] = useState<'720p' | '1080p' | '4k'>('720p');
  const [isLooping, setIsLooping] = useState(false);

  const [startFramePath, setStartFramePath] = useState<string | null>(null);
  const [endFramePath, setEndFramePath] = useState<string | null>(null);
  const [referenceImagePaths, setReferenceImagePaths] = useState<string[]>([]);
  const [inputVideoPath, setInputVideoPath] = useState<string | null>(null);

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GenerateResponseData | null>(null);
  const [outputItems, setOutputItems] = useState<OutputItem[]>([]);
  const [isLoadingOutputs, setIsLoadingOutputs] = useState(false);
  const [previewItem, setPreviewItem] = useState<OutputItem | null>(null);

  const [picker, setPicker] = useState<{
    open: boolean;
    kind: 'image' | 'video';
    multiple: boolean;
    target: 'start' | 'end' | 'references' | 'input';
    maxSelection: number;
  }>({
    open: false,
    kind: 'image',
    multiple: false,
    target: 'start',
    maxSelection: 1,
  });

  const canGenerate = useMemo(() => {
    if (isGenerating) return false;
    if (mode === 'text_to_video') return prompt.trim().length > 0;
    if (mode === 'frames_to_video') return Boolean(startFramePath);
    if (mode === 'references_to_video') return prompt.trim().length > 0 && referenceImagePaths.length > 0;
    return Boolean(inputVideoPath);
  }, [isGenerating, mode, prompt, startFramePath, referenceImagePaths.length, inputVideoPath]);

  const loadOutputs = async () => {
    setIsLoadingOutputs(true);
    try {
      const response = await fetch(
        `/api/veo/assets?kind=video&q=${encodeURIComponent('veo-studio/video-generation')}&limit=20`,
        { credentials: 'include', cache: 'no-store' }
      );
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to load generated videos');
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

  const openPicker = (
    target: 'start' | 'end' | 'references' | 'input',
    kind: 'image' | 'video',
    multiple = false,
    maxSelection = 1
  ) => {
    setPicker({ open: true, kind, multiple, target, maxSelection });
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
    if (picker.target === 'input') {
      setInputVideoPath(paths[0] || null);
      return;
    }
    setReferenceImagePaths(paths.slice(0, 3));
  };

  const handleGenerate = async () => {
    setError(null);
    setGenerated(null);
    setIsGenerating(true);

    try {
      const response = await fetch('/api/veo/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          mode,
          prompt,
          model,
          aspectRatio,
          resolution,
          isLooping,
          startFramePath,
          endFramePath,
          referenceImagePaths,
          inputVideoPath,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Video generation failed');
      }
      setGenerated(payload.data);
      await loadOutputs();
    } catch (generateError) {
      const message = generateError instanceof Error ? generateError.message : 'Video generation failed';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
      <Card>
        <CardHeader>
          <CardTitle>VEO Studio</CardTitle>
          <CardDescription>
            Workspace-basierte Video-Generierung mit lokalen Referenzen und Ausgabe nach{' '}
            <span className="font-mono">veo-studio/video-generation</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Mode</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={mode}
                onChange={(event) => setMode(event.target.value as GenerationMode)}
              >
                {Object.entries(MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Model</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option>
                <option value="veo-3.1-generate-preview">Veo 3.1 High Quality</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Aspect Ratio</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={aspectRatio}
                onChange={(event) => setAspectRatio(event.target.value as '16:9' | '9:16')}
              >
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Resolution</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={resolution}
                onChange={(event) => setResolution(event.target.value as '720p' | '1080p' | '4k')}
              >
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="4k">4k</option>
              </select>
            </label>
          </div>

          {mode !== 'extend_video' && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Prompt</span>
              <textarea
                className="min-h-[92px] border border-input bg-background px-3 py-2 text-sm"
                placeholder="Beschreibe das gewünschte Video..."
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
          )}

          {mode === 'frames_to_video' && (
            <div className="space-y-2 border border-border bg-background p-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Frames</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" className="w-full sm:w-auto" onClick={() => openPicker('start', 'image')}>
                  Start Frame
                </Button>
                {!isLooping && (
                  <Button variant="outline" className="w-full sm:w-auto" onClick={() => openPicker('end', 'image')}>
                    End Frame
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
                Loop-Video
              </label>
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                {startFramePath && <PreviewChip path={startFramePath} kind="image" />}
                {!isLooping && endFramePath && <PreviewChip path={endFramePath} kind="image" />}
              </div>
            </div>
          )}

          {mode === 'references_to_video' && (
            <div className="space-y-2 border border-border bg-background p-3">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Reference Images</p>
                <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => openPicker('references', 'image', true, 3)}>
                  Referenzen auswählen
                </Button>
              </div>
              {referenceImagePaths.length > 0 ? (
                <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {referenceImagePaths.map((item) => (
                    <PreviewChip key={item} path={item} kind="image" />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Noch keine Referenzen ausgewählt.</p>
              )}
            </div>
          )}

          {mode === 'extend_video' && (
            <div className="space-y-2 border border-border bg-background p-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Input Video</p>
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => openPicker('input', 'video')}>
                Input Video auswählen
              </Button>
              {inputVideoPath ? (
                <PreviewChip path={inputVideoPath} kind="video" />
              ) : (
                <p className="text-sm text-muted-foreground">Noch kein Input-Video ausgewählt.</p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
            <Button className="gap-2 w-full sm:w-auto" onClick={handleGenerate} disabled={!canGenerate}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
              {isGenerating ? 'Generiere...' : 'Generieren'}
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
          <CardTitle>Aktuelles Ergebnis</CardTitle>
          <CardDescription>Letzte Generierung und gespeicherter Workspace-Pfad.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {generated ? (
            <>
              <video src={generated.mediaUrl} controls className="aspect-video w-full border border-border bg-muted max-h-[300px] sm:max-h-[400px]" />
              <p className="text-xs text-muted-foreground truncate">
                Video: <span className="font-mono">{generated.path}</span>
              </p>
              <p className="text-xs text-muted-foreground truncate">
                Metadaten: <span className="font-mono">{generated.metadataPath}</span>
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Noch keine Generierung in dieser Session.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>video-generation</CardTitle>
          <CardDescription>Zuletzt gespeicherte Videos aus dem Workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {outputItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch keine Videos im Output-Ordner gefunden.</p>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              {outputItems.map((item) => (
                <button
                  key={item.path}
                  onClick={() => setPreviewItem(item)}
                  className="border border-border bg-background p-2 text-left transition hover:border-primary/40 hover:bg-accent"
                >
                  <video src={item.mediaUrl} className="aspect-video w-full bg-muted max-h-[250px] sm:max-h-[300px]" />
                  <p className="mt-1 truncate text-xs text-muted-foreground">{item.path}</p>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AssetPickerDialog
        open={picker.open}
        onOpenChange={(open) => setPicker((current) => ({ ...current, open }))}
        kind={picker.kind}
        multiple={picker.multiple}
        maxSelection={picker.maxSelection}
        onConfirm={handlePickerConfirm}
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
              <video
                src={previewItem.mediaUrl}
                controls
                autoPlay
                className="max-h-[calc(100dvh-8rem)] max-w-full"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
