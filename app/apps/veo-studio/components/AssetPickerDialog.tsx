'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Upload, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';

type AssetKind = 'image' | 'video';

interface AssetItem {
  path: string;
  name: string;
  kind: AssetKind;
  mediaUrl: string;
  previewUrl: string;
}

interface AssetPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: AssetKind;
  multiple?: boolean;
  maxSelection?: number;
  onConfirm: (paths: string[]) => void;
  assetApiPath?: string;
  uploadPath?: string;
}

export function AssetPickerDialog({
  open,
  onOpenChange,
  kind,
  multiple = false,
  maxSelection = 1,
  onConfirm,
  assetApiPath = '/api/veo/assets',
  uploadPath = 'veo-studio/assets',
}: AssetPickerDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'workspace' | 'upload'>('workspace');

  const acceptType = useMemo(() => (kind === 'image' ? 'image/*' : 'video/mp4,video/quicktime'), [kind]);

  const loadAssets = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const query = search.trim();
      const url = `${assetApiPath}?kind=${kind}&limit=300${query ? `&q=${encodeURIComponent(query)}` : ''}`;
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to load assets');
      }
      setAssets(payload.data || []);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : 'Failed to load assets';
      setError(message);
      setAssets([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setSelectedPaths([]);
    setTab('workspace');
  }, [open, kind]);

  useEffect(() => {
    if (!open || tab !== 'workspace') return;
    const timer = setTimeout(() => {
      void loadAssets();
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search, kind, tab]);

  const toggleSelect = (path: string) => {
    setSelectedPaths((current) => {
      if (!multiple) {
        return current[0] === path ? [] : [path];
      }

      const exists = current.includes(path);
      if (exists) {
        return current.filter((item) => item !== path);
      }
      if (current.length >= maxSelection) {
        return current;
      }
      return [...current, path];
    });
  };

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append('files', file, file.name);
      });
      formData.append('path', uploadPath);

      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Upload failed');
      }

      setTab('workspace');
      await loadAssets();
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : 'Upload failed';
      setError(message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-4xl border border-border bg-card">
        <DialogHeader>
          <DialogTitle>{kind === 'image' ? 'Bild auswählen' : 'Video auswählen'}</DialogTitle>
          <DialogDescription>
            Wähle Assets aus dem Workspace oder lade neue Dateien hoch.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as 'workspace' | 'upload')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="workspace">Workspace</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
          </TabsList>

          <TabsContent value="workspace" className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="Suche nach Dateiname oder Pfad"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  void loadAssets();
                }}
                disabled={isLoading}
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                Aktualisieren
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <ScrollArea className="h-[420px] border border-border bg-background p-3">
              {isLoading ? (
                <div className="flex h-40 items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Lade Assets...
                </div>
              ) : assets.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                  Keine passenden Assets gefunden.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {assets.map((asset) => {
                    const selected = selectedPaths.includes(asset.path);
                    return (
                      <button
                        key={asset.path}
                        type="button"
                        onClick={() => toggleSelect(asset.path)}
                        className={`overflow-hidden border text-left transition ${
                          selected
                            ? 'border-primary bg-primary/10'
                            : 'border-border bg-card hover:border-primary/50'
                        }`}
                      >
                        <div className="aspect-video w-full bg-muted">
                          {asset.kind === 'image' ? (
                            <img
                              src={asset.previewUrl}
                              alt={asset.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <video src={asset.mediaUrl} className="h-full w-full object-cover" muted />
                          )}
                        </div>
                        <div className="p-2">
                          <p className="truncate text-xs font-medium">{asset.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{asset.path}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="upload" className="space-y-3">
            <div className="border border-dashed border-border bg-background p-6">
              <p className="mb-3 text-sm text-muted-foreground">
                Upload-Ziel: <span className="font-mono">{uploadPath}</span>
              </p>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Dateien hochladen
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept={acceptType}
                multiple={multiple}
                onChange={(event) => {
                  void handleUploadFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {multiple
              ? `${selectedPaths.length}/${maxSelection} ausgewählt`
              : selectedPaths.length > 0
                ? '1 ausgewählt'
                : 'Nichts ausgewählt'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Abbrechen
            </Button>
            <Button
              onClick={() => {
                onConfirm(selectedPaths);
                onOpenChange(false);
              }}
              disabled={selectedPaths.length === 0}
            >
              Übernehmen
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
