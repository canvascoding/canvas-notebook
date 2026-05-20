'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crop, FolderInput, ImageIcon, Loader2, Maximize2, RefreshCw, Save, ShieldAlert, Sparkles, WandSparkles, ZoomIn } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { ReferencePickerDialog } from '@/app/apps/studio/components/create/ReferencePickerDialog';
import { useSetStudioChatContext } from '@/app/apps/studio/context/studio-chat-context';
import { DirectoryBrowser } from '@/app/components/file-browser/DirectoryBrowser';
import { useFileStore } from '@/app/store/file-store';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getImageSizesForModel } from '@/app/lib/integrations/image-generation-constants';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';

type Mode = 'crop' | 'ai_extend';
type DragState =
  | { type: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { type: 'move-frame'; startImageX: number; startImageY: number; frame: Frame }
  | { type: 'resize-frame'; handle: Handle; startImageX: number; startImageY: number; frame: Frame };

type Handle = 'nw' | 'ne' | 'sw' | 'se';

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ProviderOption {
  id: 'gemini' | 'openai';
  name: string;
  models: Array<{ id: string; label: string; shortLabel: string; description: string }>;
  aspectRatios: string[];
  supportsQuality: boolean;
  supportsOutputFormat: boolean;
  supportsBackground: boolean;
  supportsImageSize: boolean;
}

interface PreviewResult {
  path: string;
  name: string;
  mediaUrl: string;
  previewUrl: string;
  mode: Mode;
  width: number;
  height: number;
  mimeType: string;
}

const PRESETS = [
  { label: '1:1', ratio: '1:1', width: 1024, height: 1024 },
  { label: '4:5', ratio: '4:5', width: 1080, height: 1350 },
  { label: '3:4', ratio: '3:4', width: 1080, height: 1440 },
  { label: '4:3', ratio: '4:3', width: 1440, height: 1080 },
  { label: '16:9', ratio: '16:9', width: 1920, height: 1080 },
  { label: '9:16', ratio: '9:16', width: 1080, height: 1920 },
  { label: '3:2', ratio: '3:2', width: 1500, height: 1000 },
  { label: '2:3', ratio: '2:3', width: 1000, height: 1500 },
  { label: 'Freeform', ratio: 'freeform', width: 1024, height: 1024 },
] as const;

const MAX_TARGET_SIZE = 2048;
const MIN_FRAME_SIZE = 24;

function parseRatio(ratio: string) {
  const [w, h] = ratio.split(':').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

function getFrameMode(frame: Frame, imageWidth: number, imageHeight: number): Mode {
  return frame.x >= 0 && frame.y >= 0 && frame.x + frame.width <= imageWidth && frame.y + frame.height <= imageHeight
    ? 'crop'
    : 'ai_extend';
}

function clampTargetSize(width: number, height: number) {
  const scale = Math.min(1, MAX_TARGET_SIZE / Math.max(width, height));
  return {
    width: Math.max(64, Math.round(width * scale)),
    height: Math.max(64, Math.round(height * scale)),
  };
}

function getTargetSize(frame: Frame, ratio: string) {
  const preset = PRESETS.find((item) => item.ratio === ratio);
  if (preset && ratio !== 'freeform') return { width: preset.width, height: preset.height };
  return clampTargetSize(frame.width, frame.height);
}

function fitFrameToRatio(imageWidth: number, imageHeight: number, ratio: string): Frame {
  const parsed = parseRatio(ratio);
  if (!parsed) {
    return {
      x: Math.round(imageWidth * 0.1),
      y: Math.round(imageHeight * 0.1),
      width: Math.round(imageWidth * 0.8),
      height: Math.round(imageHeight * 0.8),
    };
  }

  let width = imageWidth;
  let height = width / parsed;
  if (height > imageHeight) {
    height = imageHeight;
    width = height * parsed;
  }

  return {
    x: Math.round((imageWidth - width) / 2),
    y: Math.round((imageHeight - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function clientPointToImagePoint(clientX: number, clientY: number, stage: HTMLDivElement | null, pan: { x: number; y: number }, zoom: number) {
  const rect = stage?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: (clientX - rect.left - pan.x) / zoom,
    y: (clientY - rect.top - pan.y) / zoom,
  };
}

function buildImageUrl(path: string) {
  return path.startsWith('/api/') || /^https?:\/\//i.test(path) ? path : toMediaUrl(path);
}

function buildDefaultFileName(preview: PreviewResult | null) {
  return preview?.name || 'aspect-ratio-edit.png';
}

function ProviderControls({
  providers,
  provider,
  model,
  quality,
  outputFormat,
  background,
  imageSize,
  onProviderChange,
  onModelChange,
  onQualityChange,
  onOutputFormatChange,
  onBackgroundChange,
  onImageSizeChange,
}: {
  providers: ProviderOption[];
  provider: 'gemini' | 'openai';
  model: string;
  quality: 'auto' | 'low' | 'medium' | 'high';
  outputFormat: 'png' | 'jpeg' | 'webp';
  background: 'auto' | 'transparent' | 'opaque';
  imageSize: string;
  onProviderChange: (value: 'gemini' | 'openai') => void;
  onModelChange: (value: string) => void;
  onQualityChange: (value: 'auto' | 'low' | 'medium' | 'high') => void;
  onOutputFormatChange: (value: 'png' | 'jpeg' | 'webp') => void;
  onBackgroundChange: (value: 'auto' | 'transparent' | 'opaque') => void;
  onImageSizeChange: (value: string) => void;
}) {
  const t = useTranslations('studio.aspectRatioEditor');
  const activeProvider = providers.find((item) => item.id === provider);
  const models = activeProvider?.models ?? [];
  const imageSizes = provider === 'gemini' ? getImageSizesForModel(model) : [];

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <WandSparkles className="h-4 w-4 text-primary" />
        {t('mode.aiExtend')}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">{t('provider')}</span>
        <select
          className="h-9 rounded-md border border-input bg-background px-2"
          value={provider}
          onChange={(event) => onProviderChange(event.target.value as 'gemini' | 'openai')}
        >
          {providers.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">{t('model')}</span>
        <select className="h-9 rounded-md border border-input bg-background px-2" value={model} onChange={(event) => onModelChange(event.target.value)}>
          {models.map((item) => (
            <option key={item.id} value={item.id}>{item.shortLabel || item.id}</option>
          ))}
        </select>
      </label>
      {provider === 'openai' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t('quality')}</span>
            <select className="h-9 rounded-md border border-input bg-background px-2" value={quality} onChange={(event) => onQualityChange(event.target.value as typeof quality)}>
              {['auto', 'low', 'medium', 'high'].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t('format')}</span>
            <select className="h-9 rounded-md border border-input bg-background px-2" value={outputFormat} onChange={(event) => onOutputFormatChange(event.target.value as typeof outputFormat)}>
              {['png', 'jpeg', 'webp'].map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t('background')}</span>
            <select className="h-9 rounded-md border border-input bg-background px-2" value={background} onChange={(event) => onBackgroundChange(event.target.value as typeof background)}>
              {['auto', 'transparent', 'opaque'].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
      ) : null}
      {provider === 'gemini' && imageSizes.length > 0 ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t('resolution')}</span>
          <select className="h-9 rounded-md border border-input bg-background px-2" value={imageSize} onChange={(event) => onImageSizeChange(event.target.value)}>
            {imageSizes.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function WorkspaceCopyDialog({
  open,
  onOpenChange,
  preview,
  onCopied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: PreviewResult | null;
  onCopied: (path: string) => void;
}) {
  const t = useTranslations('studio.aspectRatioEditor');
  const { fileTree, loadFileTree, refreshDirectory } = useFileStore();
  const [selectedDir, setSelectedDir] = useState('.');
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [fileName, setFileName] = useState(buildDefaultFileName(preview));
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFileName(buildDefaultFileName(preview));
    void loadFileTree('.', 6, true);
  }, [loadFileTree, open, preview]);

  const handleToggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
    void refreshDirectory(dirPath, true);
  };

  const handleSave = async () => {
    if (!preview) return;
    setIsSaving(true);
    try {
      const response = await fetch('/api/studio/aspect-ratio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'copy_workspace',
          previewPath: preview.path,
          targetDirectory: selectedDir,
          fileName,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.copyFailed'));
      await refreshDirectory(selectedDir, true);
      onCopied(payload.path);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.copyFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('workspaceDialog.title')}</DialogTitle>
          <DialogDescription>{t('workspaceDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t('workspaceDialog.fileName')}</span>
            <Input value={fileName} onChange={(event) => setFileName(event.target.value)} />
          </label>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t('workspaceDialog.targetFolder')}</p>
            <p className="mt-1 truncate font-mono text-sm">{selectedDir === '.' ? t('workspaceDialog.workspaceRoot') : selectedDir}</p>
          </div>
          <DirectoryBrowser tree={fileTree} selectedPath={selectedDir} onSelect={setSelectedDir} expandedDirs={expandedDirs} onToggleDir={handleToggleDir} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={handleSave} disabled={!preview || isSaving || !fileName.trim()}>
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}
            {t('copy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AspectRatioEditorView() {
  const t = useTranslations('studio.aspectRatioEditor');
  const searchParams = useSearchParams();
  const initialRefPath = searchParams.get('ref');
  const setChatContext = useSetStudioChatContext();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState<string | null>(() => initialRefPath);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState({ x: 80, y: 60 });
  const [zoom, setZoom] = useState(1);
  const [frame, setFrame] = useState<Frame>({ x: 0, y: 0, width: 100, height: 100 });
  const [aspectRatio, setAspectRatio] = useState<string>('1:1');
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<'gemini' | 'openai'>('openai');
  const [model, setModel] = useState('gpt-image-2');
  const [quality, setQuality] = useState<'auto' | 'low' | 'medium' | 'high'>('auto');
  const [outputFormat, setOutputFormat] = useState<'png' | 'jpeg' | 'webp'>('png');
  const [background, setBackground] = useState<'auto' | 'transparent' | 'opaque'>('auto');
  const [geminiImageSize, setGeminiImageSize] = useState('1K');
  const [isGenerating, setIsGenerating] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);

  const mode = imageSize.width > 0 ? getFrameMode(frame, imageSize.width, imageSize.height) : 'crop';
  const targetSize = useMemo(() => getTargetSize(frame, aspectRatio), [aspectRatio, frame]);
  const activeProvider = providers.find((item) => item.id === provider);
  const providerRatios = activeProvider?.aspectRatios ?? [];
  const canUseCurrentRatioForAi = aspectRatio !== 'freeform' && providerRatios.includes(aspectRatio);
  const canGenerate = Boolean(sourcePath && imageSize.width > 0 && (mode === 'crop' || canUseCurrentRatioForAi));

  useEffect(() => {
    setChatContext({ currentPage: '/studio/aspect-ratio' });
  }, [setChatContext]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/studio/aspect-ratio/models', { credentials: 'include', cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.modelsFailed'));
        if (!cancelled) {
          const nextProviders = payload.providers || [];
          setProviders(nextProviders);
          const firstOpenAI = nextProviders.find((item: ProviderOption) => item.id === 'openai') || nextProviders[0];
          if (firstOpenAI) {
            setProvider(firstOpenAI.id);
            setModel(firstOpenAI.models[0]?.id || '');
          }
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('errors.modelsFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const resetView = useCallback((width: number, height: number) => {
    const initialZoom = Math.min(1, 680 / Math.max(width, height));
    setZoom(initialZoom);
    setPan({ x: 96, y: 64 });
    setAspectRatio('1:1');
    setFrame(fitFrameToRatio(width, height, '1:1'));
  }, []);

  const handleImageLoaded = () => {
    const img = imageRef.current;
    if (!img) return;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    setImageSize({ width, height });
    resetView(width, height);
  };

  const applyPreset = (ratio: string) => {
    if (imageSize.width <= 0) return;
    setAspectRatio(ratio);
    setFrame(fitFrameToRatio(imageSize.width, imageSize.height, ratio));
    setPreview(null);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    const nextZoom = Math.min(4, Math.max(0.08, zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    const imagePointX = (pointX - pan.x) / zoom;
    const imagePointY = (pointY - pan.y) / zoom;
    setZoom(nextZoom);
    setPan({
      x: pointX - imagePointX * nextZoom,
      y: pointY - imagePointY * nextZoom,
    });
  };

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { type: 'pan', startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startFrameMove = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const start = clientPointToImagePoint(event.clientX, event.clientY, stageRef.current, pan, zoom);
    dragRef.current = { type: 'move-frame', startImageX: start.x, startImageY: start.y, frame };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startFrameResize = (event: React.PointerEvent<HTMLButtonElement>, handle: Handle) => {
    event.stopPropagation();
    const start = clientPointToImagePoint(event.clientX, event.clientY, stageRef.current, pan, zoom);
    dragRef.current = { type: 'resize-frame', handle, startImageX: start.x, startImageY: start.y, frame };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.type === 'pan') {
      setPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY });
      return;
    }

    const currentPoint = clientPointToImagePoint(event.clientX, event.clientY, stageRef.current, pan, zoom);
    const dx = currentPoint.x - drag.startImageX;
    const dy = currentPoint.y - drag.startImageY;

    if (drag.type === 'move-frame') {
      setFrame({ ...drag.frame, x: drag.frame.x + dx, y: drag.frame.y + dy });
      setPreview(null);
      return;
    }

    const keepRatio = event.shiftKey;
    const ratio = drag.frame.width / drag.frame.height;
    const next = { ...drag.frame };
    if (drag.handle.includes('e')) next.width = Math.max(MIN_FRAME_SIZE, drag.frame.width + dx);
    if (drag.handle.includes('s')) next.height = Math.max(MIN_FRAME_SIZE, drag.frame.height + dy);
    if (drag.handle.includes('w')) {
      const right = drag.frame.x + drag.frame.width;
      next.x = Math.min(right - MIN_FRAME_SIZE, drag.frame.x + dx);
      next.width = right - next.x;
    }
    if (drag.handle.includes('n')) {
      const bottom = drag.frame.y + drag.frame.height;
      next.y = Math.min(bottom - MIN_FRAME_SIZE, drag.frame.y + dy);
      next.height = bottom - next.y;
    }

    if (keepRatio) {
      if (Math.abs(dx) >= Math.abs(dy)) {
        const previousHeight = next.height;
        next.height = next.width / ratio;
        if (drag.handle.includes('n')) next.y += previousHeight - next.height;
      } else {
        const previousWidth = next.width;
        next.width = next.height * ratio;
        if (drag.handle.includes('w')) next.x += previousWidth - next.width;
      }
    } else {
      setAspectRatio('freeform');
    }

    setFrame(next);
    setPreview(null);
  };

  const stopDrag = () => {
    dragRef.current = null;
  };

  const handleGeneratePreview = async () => {
    if (!sourcePath) return;
    setIsGenerating(true);
    try {
      const response = await fetch('/api/studio/aspect-ratio/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sourcePath,
          frame,
          mode,
          aspectRatio,
          targetWidth: targetSize.width,
          targetHeight: targetSize.height,
          provider: mode === 'ai_extend' ? provider : undefined,
          model: mode === 'ai_extend' ? model : undefined,
          quality: mode === 'ai_extend' && provider === 'openai' ? quality : undefined,
          outputFormat,
          background: mode === 'ai_extend' && provider === 'openai' ? background : undefined,
          imageSize: mode === 'ai_extend' && provider === 'gemini' ? geminiImageSize : undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.previewFailed'));
      setPreview(payload.preview);
      toast.success(t('toasts.previewSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.previewFailed'));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleKeepEdit = async () => {
    if (!preview) return;
    try {
      const response = await fetch('/api/studio/aspect-ratio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'keep_edit', previewPath: preview.path }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.saveFailed'));
      toast.success(t('toasts.keepEdit'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.saveFailed'));
    }
  };

  const handleOverwriteOriginal = async () => {
    if (!preview || !sourcePath) return;
    try {
      const response = await fetch('/api/studio/aspect-ratio/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'overwrite_original',
          previewPath: preview.path,
          sourcePath,
          confirmOverwrite: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.overwriteFailed'));
      toast.success(t('toasts.originalOverwritten'));
      setOverwriteDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('errors.overwriteFailed'));
    }
  };

  const frameStyle = {
    left: pan.x + frame.x * zoom,
    top: pan.y + frame.y * zoom,
    width: frame.width * zoom,
    height: frame.height * zoom,
  };

  const sourceName = sourcePath?.split('/').pop() || t('noImage');

  return (
    <div className="flex min-h-full flex-col bg-background">
      <div className="border-b border-border bg-background px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('title')}</h2>
            <p className="text-sm text-muted-foreground">{t('description')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setPickerOpen(true)}>
              <ImageIcon className="h-4 w-4" />
              {t('selectImage')}
            </Button>
            <Button variant="outline" disabled={!sourcePath} onClick={() => imageSize.width && resetView(imageSize.width, imageSize.height)}>
              <RefreshCw className="h-4 w-4" />
              {t('reset')}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-h-[520px] overflow-hidden bg-[linear-gradient(45deg,hsl(var(--muted))_25%,transparent_25%),linear-gradient(-45deg,hsl(var(--muted))_25%,transparent_25%),linear-gradient(45deg,transparent_75%,hsl(var(--muted))_75%),linear-gradient(-45deg,transparent_75%,hsl(var(--muted))_75%)] bg-[length:28px_28px] bg-[position:0_0,0_14px,14px_-14px,-14px_0px]">
          <div
            ref={stageRef}
            className="relative h-full min-h-[520px] cursor-grab overflow-hidden active:cursor-grabbing"
            onWheel={handleWheel}
            onPointerDown={startPan}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
          >
            {!sourcePath ? (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="flex max-w-md flex-col items-center gap-4 rounded-lg border border-dashed border-border bg-background/90 px-8 py-10 text-center shadow-sm hover:border-primary/60"
                >
                  <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <ImageIcon className="h-7 w-7" />
                  </div>
                  <div>
                    <p className="font-medium">{t('empty.title')}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{t('empty.description')}</p>
                  </div>
                </button>
              </div>
            ) : null}

            {sourcePath ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imageRef}
                  src={buildImageUrl(sourcePath)}
                  alt={sourceName}
                  onLoad={handleImageLoaded}
                  className="pointer-events-none absolute max-w-none select-none shadow-[0_18px_80px_-35px_rgba(0,0,0,0.55)]"
                  style={{
                    left: pan.x,
                    top: pan.y,
                    width: imageSize.width * zoom || undefined,
                    height: imageSize.height * zoom || undefined,
                  }}
                />
                {imageSize.width > 0 ? (
                  <div
                    className={cn(
                      'absolute border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.36)]',
                      mode === 'crop' ? 'border-emerald-400' : 'border-amber-400',
                    )}
                    style={frameStyle}
                    onPointerDown={startFrameMove}
                  >
                    <div className="pointer-events-none absolute inset-0 bg-background/5" />
                    <div className="pointer-events-none absolute left-2 top-2 rounded bg-background/90 px-2 py-1 text-xs font-medium shadow-sm">
                      {mode === 'crop' ? t('mode.crop') : t('mode.aiExtend')} · {aspectRatio === 'freeform' ? t('freeform') : aspectRatio}
                    </div>
                    {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
                      <button
                        key={handle}
                        type="button"
                        aria-label={t('resizeHandle', { handle })}
                        onPointerDown={(event) => startFrameResize(event, handle)}
                        className={cn(
                          'absolute h-4 w-4 rounded-full border-2 border-background bg-primary shadow',
                          handle.includes('n') ? '-top-2' : '-bottom-2',
                          handle.includes('w') ? '-left-2' : '-right-2',
                        )}
                      />
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto border-l border-border bg-card/70 p-4">
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t('source')}</p>
              <p className="mt-1 truncate text-sm font-medium">{sourceName}</p>
              {imageSize.width > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">{imageSize.width} x {imageSize.height}px · Zoom {Math.round(zoom * 100)}%</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Maximize2 className="h-4 w-4 text-primary" />
                {t('presets')}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((preset) => {
                  const disabled = mode === 'ai_extend' && (preset.ratio === 'freeform' || (providerRatios.length > 0 && !providerRatios.includes(preset.ratio)));
                  return (
                    <Button
                      key={preset.ratio}
                      variant={aspectRatio === preset.ratio ? 'default' : 'outline'}
                      size="sm"
                      disabled={disabled}
                      onClick={() => applyPreset(preset.ratio)}
                    >
                      {preset.label}
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{t('presetHint')}</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {mode === 'crop' ? <Crop className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {t('mode.label')}
                </div>
                <p className={cn('mt-2 text-sm font-semibold', mode === 'crop' ? 'text-emerald-600' : 'text-amber-600')}>
                  {mode === 'crop' ? t('mode.crop') : t('mode.aiExtend')}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <ZoomIn className="h-3.5 w-3.5" />
                  {t('output')}
                </div>
                <p className="mt-2 text-sm font-semibold">{targetSize.width} x {targetSize.height}</p>
              </div>
            </div>

            {mode === 'ai_extend' ? (
              <ProviderControls
                providers={providers}
                provider={provider}
                model={model}
                quality={quality}
                outputFormat={outputFormat}
                background={background}
                imageSize={geminiImageSize}
                onProviderChange={(value) => {
                  setProvider(value);
                  const nextProvider = providers.find((item) => item.id === value);
                  setModel(nextProvider?.models[0]?.id || '');
                }}
                onModelChange={setModel}
                onQualityChange={setQuality}
                onOutputFormatChange={setOutputFormat}
                onBackgroundChange={setBackground}
                onImageSizeChange={setGeminiImageSize}
              />
            ) : (
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                {t('cropNotice')}
              </div>
            )}

            {mode === 'ai_extend' && !canUseCurrentRatioForAi ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {t('unsupportedRatio')}
              </div>
            ) : null}

            <Button className="w-full" disabled={!canGenerate || isGenerating} onClick={handleGeneratePreview}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'crop' ? <Crop className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              {isGenerating ? t('creatingPreview') : t('createPreview')}
            </Button>

            {preview ? (
              <div className="space-y-3 rounded-lg border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{t('preview')}</p>
                    <p className="text-xs text-muted-foreground">{t('savedInEdits')}</p>
                  </div>
                  <Check className="h-4 w-4 text-emerald-600" />
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={toPreviewUrl(preview.path, 720)} alt={preview.name} className="max-h-64 w-full rounded-md object-contain bg-muted" />
                <p className="truncate font-mono text-xs text-muted-foreground">{preview.path}</p>
                <div className="grid gap-2">
                  <Button variant="outline" onClick={handleKeepEdit}>
                    <Save className="h-4 w-4" />
                    {t('keepInEdits')}
                  </Button>
                  <Button variant="outline" onClick={() => setCopyDialogOpen(true)}>
                    <FolderInput className="h-4 w-4" />
                    {t('copyToWorkspace')}
                  </Button>
                  <Button variant="destructive" onClick={() => setOverwriteDialogOpen(true)}>
                    <ShieldAlert className="h-4 w-4" />
                    {t('overwriteOriginal')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <ReferencePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        multiple={false}
        maxSelection={1}
        onConfirm={(paths) => {
          const nextPath = paths[0] || null;
          setSourcePath(nextPath);
          setPreview(null);
          setImageSize({ width: 0, height: 0 });
        }}
      />

      <WorkspaceCopyDialog
        open={copyDialogOpen}
        onOpenChange={setCopyDialogOpen}
        preview={preview}
        onCopied={(path) => toast.success(t('toasts.copiedTo', { path }))}
      />

      <AlertDialog open={overwriteDialogOpen} onOpenChange={setOverwriteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('overwriteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('overwriteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleOverwriteOriginal}>
              {t('overwriteOriginal')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
