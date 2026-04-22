'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Loader2, Upload, RefreshCw, ChevronRight, Folder, Image as ImageIcon, CheckSquare2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toPreviewUrl, toMediaUrl } from '@/app/lib/utils/media-url';
import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import type { ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';

type Source = 'workspace' | 'studio' | 'upload';

interface ImageAsset {
  path: string;
  name: string;
  mediaUrl: string;
  previewUrl: string;
  modified?: number;
}

interface ReferencePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (paths: string[]) => void;
}

// --- Workspace Tree Helpers ---
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);
function isImage(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return IMAGE_EXTS.has(ext || '');
}
function walkImages(nodes: FileNode[], list: FileNode[] = []) {
  for (const node of nodes) {
    if (node.type === 'file' && isImage(node.name)) list.push(node);
    if (node.children?.length) walkImages(node.children, list);
  }
  return list;
}

function TreeNode({
  node,
  depth = 0,
  selectedPaths,
  expandedDirs,
  onToggleDir,
  onToggleSelect,
}: {
  node: FileNode;
  depth?: number;
  selectedPaths: Set<string>;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onToggleSelect: (path: string) => void;
}) {
  if (node.type === 'file') {
    if (!isImage(node.name)) return null;
    const isSelected = selectedPaths.has(node.path);
    return (
      <div
        key={node.path}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition',
          isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
        )}
        style={{ paddingLeft: `${20 + depth * 16}px` }}
        onClick={() => onToggleSelect(node.path)}
      >
        <CheckSquare2
          className={cn('h-4 w-4 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')}
        />
        <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
      </div>
    );
  }
  const isExpanded = expandedDirs.has(node.path);
  return (
    <div key={node.path}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-muted transition"
        style={{ paddingLeft: `${20 + depth * 16}px` }}
        onClick={() => onToggleDir(node.path)}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            isExpanded && 'rotate-90'
          )}
        />
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {isExpanded &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPaths={selectedPaths}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onToggleSelect={onToggleSelect}
          />
        ))}
    </div>
  );
}

export function ReferencePickerDialog({ open, onOpenChange, onConfirm }: ReferencePickerDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<Source>('studio');
  const [search, setSearch] = useState('');

  // Studio / Upload tab state
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Workspace tab state
  const [tree, setTree] = useState<FileNode[]>([]);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  // Shared selection
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  // Upload state (mirrors AssetPickerDialog)
  const [isUploading, setIsUploading] = useState(false);
  const [imagePreprocessFiles, setImagePreprocessFiles] = useState<
    import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] | null
  >(null);
  const [imagePreprocessPendingFiles, setImagePreprocessPendingFiles] = useState<File[]>([]);

  const loadStudioAssets = async () => {
    if (tab !== 'studio') return;
    setIsLoading(true);
    setError(null);
    try {
      const query = search.trim();
      const url = `/api/studio/references/assets?kind=image&limit=300${query ? `&q=${encodeURIComponent(query)}` : ''}`;
      const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
      const payload = await res.json();
      if (!res.ok || !payload.success) throw new Error(payload.error || 'Failed loading assets');
      setAssets(payload.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed loading assets');
      setAssets([]);
    } finally {
      setIsLoading(false);
    }
  };

  const loadWorkspaceTree = async () => {
    if (tab !== 'workspace') return;
    setIsTreeLoading(true);
    setTreeError(null);
    try {
      const res = await fetch('/api/files/tree?path=.&depth=8', { credentials: 'include', cache: 'no-store' });
      const payload = await res.json();
      if (!res.ok || !payload.success) throw new Error(payload.error || 'Failed loading files');
      // Only keep nodes that have at least one image descendant for a cleaner tree
      const root = payload.data || [];
      setTree(root);
      // Expand first three levels automatically for convenience
      const initial = new Set<string>();
      const queue: FileNode[] = [...root];
      let depth = 0;
      while (queue.length && depth < 2) {
        const next: FileNode[] = [];
        for (const n of queue) {
          if (n.type === 'directory') {
            initial.add(n.path);
            if (n.children) next.push(...n.children);
          }
        }
        queue.length = 0;
        queue.push(...next);
        depth++;
      }
      setExpandedDirs(initial);
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : 'Failed loading files');
      setTree([]);
    } finally {
      setIsTreeLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setSelectedPaths(new Set());
    setSearch('');
    void loadStudioAssets();
    void loadWorkspaceTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (tab === 'studio') void loadStudioAssets();
    else if (tab === 'workspace') void loadWorkspaceTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, open, search]);

  const toggleExpanded = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const currentSelectionDisplay = useMemo(() => {
    const allAssets: ImageAsset[] = [];
    allAssets.push(...assets);
    allAssets.push(...walkImages(tree).map((n) => ({
      path: n.path,
      name: n.name,
      mediaUrl: toMediaUrl(n.path),
      previewUrl: toPreviewUrl(n.path, 200),
    })));
    return Array.from(selectedPaths)
      .map((p) => allAssets.find((a) => a.path === p))
      .filter(Boolean) as ImageAsset[];
  }, [assets, selectedPaths, tree]);

  // Upload helpers (mirrors AssetPickerDialog)
  const handleUploadFiles = async (files: FileList | null, convertParams?: (ConvertParams | null)[]) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      Array.from(files).forEach((file) => formData.append('files', file, file.name));
      formData.append('path', 'user-uploads/studio-references');
      if (convertParams && convertParams.length > 0) {
        const serializable = convertParams.map((p) =>
          p ? { format: p.format, quality: p.quality, maxDimension: p.maxDimension } : null
        );
        formData.append('convertParams', JSON.stringify(serializable));
      }
      const res = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include' });
      const payload = await res.json();
      if (!res.ok || !payload.success) throw new Error(payload.error || 'Upload failed');
      // Switch to studio tab to show updated list and select new files
      setTab('studio');
      await loadStudioAssets();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleImagePreprocessConfirm = async (convertParams: (ConvertParams | null)[]) => {
    if (imagePreprocessPendingFiles.length === 0) return;
    const files = imagePreprocessPendingFiles;
    setIsUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('files', file, file.name));
      formData.append('path', 'user-uploads/studio-references');
      if (convertParams.length > 0) {
        const serializable = convertParams.map((p) =>
          p ? { format: p.format, quality: p.quality, maxDimension: p.maxDimension } : null
        );
        formData.append('convertParams', JSON.stringify(serializable));
      }
      const res = await fetch('/api/files/upload', { method: 'POST', body: formData, credentials: 'include' });
      const payload = await res.json();
      if (!res.ok || !payload.success) throw new Error(payload.error || 'Upload failed');
      setTab('studio');
      setImagePreprocessFiles(null);
      setImagePreprocessPendingFiles([]);
      await loadStudioAssets();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleImagePreprocessSkip = async () => {
    const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);
    const HEIC_EXTS = new Set(['heic', 'heif']);
    const nonHeic = imagePreprocessPendingFiles.filter((f) => {
      return !HEIC_TYPES.has(f.type.toLowerCase()) && !HEIC_EXTS.has(f.name.split('.').pop()?.toLowerCase() ?? '');
    });
    if (nonHeic.length > 0) {
      const dt = new DataTransfer();
      nonHeic.forEach((f) => dt.items.add(f));
      await handleUploadFiles(dt.files);
    }
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  };

  const preprocessFileSelection = async (files: FileList) => {
    const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);
    const HEIC_EXTS = new Set(['heic', 'heif']);
    const SIZE_THRESHOLD = 1_500_000;
    const preprocessList: import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] = [];
    const normalFiles: File[] = [];
    for (const file of Array.from(files)) {
      const isHeic = HEIC_TYPES.has(file.type.toLowerCase()) || HEIC_EXTS.has(file.name.split('.').pop()?.toLowerCase() ?? '');
      const isImg = file.type.startsWith('image/') || HEIC_EXTS.has(file.name.split('.').pop()?.toLowerCase() ?? '');
      if (isHeic || (isImg && file.size > SIZE_THRESHOLD)) {
        preprocessList.push({ file, isHeic, isLarge: file.size > SIZE_THRESHOLD });
      } else {
        normalFiles.push(file);
      }
    }
    if (normalFiles.length > 0) {
      const dt = new DataTransfer();
      normalFiles.forEach((f) => dt.items.add(f));
      await handleUploadFiles(dt.files);
    }
    if (preprocessList.length > 0) {
      setImagePreprocessPendingFiles(preprocessList.map((f) => f.file));
      setImagePreprocessFiles(preprocessList);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex flex-col w-[95vw] max-w-4xl max-h-[90vh] overflow-hidden border border-border bg-card">
          <DialogHeader>
            <DialogTitle>Bildreferenz auswählen</DialogTitle>
            <DialogDescription>
              Wähle bereits generierte Studio-Bilder, Dateien aus deinem Workspace, oder lade neue Referenzen hoch.
            </DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={(val) => setTab(val as Source)} className="flex flex-col flex-1 min-h-0">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="studio">Studio Outputs</TabsTrigger>
              <TabsTrigger value="workspace">Workspace</TabsTrigger>
              <TabsTrigger value="upload">Hochladen</TabsTrigger>
            </TabsList>

            {/* Studio tab */}
            <TabsContent value="studio" className="flex flex-col flex-1 min-h-0 mt-0 data-[state=active]:flex">
              <div className="flex gap-2 py-3">
                <Input
                  placeholder="Assets suchen..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 shrink-0"
                  onClick={() => {
                    void loadStudioAssets();
                  }}
                  disabled={isLoading}
                >
                  <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
                  Neu laden
                </Button>
              </div>

              {error && <p className="text-sm text-destructive mb-2">{error}</p>}

              <ScrollArea className="flex-1 border rounded-md bg-background p-3">
                {isLoading ? (
                  <div className="flex h-40 items-center justify-center text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Lade Assets...
                  </div>
                ) : assets.length === 0 ? (
                  <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    Keine Bilder gefunden.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {assets.map((asset) => {
                      const selected = selectedPaths.has(asset.path);
                      return (
                        <button
                          key={asset.path}
                          type="button"
                          onClick={() => toggleSelect(asset.path)}
                          className={cn(
                            'relative overflow-hidden border rounded-lg text-left transition',
                            selected
                              ? 'border-primary ring-2 ring-primary/20 bg-primary/5'
                              : 'border-border bg-card hover:border-primary/50'
                          )}
                        >
                           <div className="aspect-video w-full bg-muted">
                             {/* eslint-disable-next-line @next/next/no-img-element */}
                             <img
                               src={asset.previewUrl}
                               alt={asset.name}
                               className="h-full w-full object-cover"
                               loading="lazy"
                               decoding="async"
                             />
                           </div>
                          <div className="p-2">
                            <p className="truncate text-xs font-medium">{asset.name}</p>
                            {selected && (
                              <CheckSquare2 className="absolute top-2 right-2 h-4 w-4 text-primary bg-white dark:bg-black rounded-sm" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            {/* Workspace tab */}
            <TabsContent value="workspace" className="flex flex-col flex-1 min-h-0 mt-0 data-[state=active]:flex">
              <div className="flex gap-2 py-3">
                <Input
                  placeholder="Workspace-Dateien suchen..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 shrink-0"
                  onClick={() => {
                    void loadWorkspaceTree();
                  }}
                  disabled={isTreeLoading}
                >
                  <RefreshCw className={cn('h-4 w-4', isTreeLoading && 'animate-spin')} />
                  Neu laden
                </Button>
              </div>

              {treeError && <p className="text-sm text-destructive mb-2">{treeError}</p>}

              <ScrollArea className="flex-1 border rounded-md bg-background p-3">
                {isTreeLoading ? (
                  <div className="flex h-40 items-center justify-center text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Lade Workspace...
                  </div>
                ) : tree.length === 0 ? (
                  <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    Workspace ist leer.
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {tree.map((node) => (
                      <TreeNode
                        key={node.path}
                        node={node}
                        selectedPaths={selectedPaths}
                        expandedDirs={expandedDirs}
                        onToggleDir={toggleExpanded}
                        onToggleSelect={toggleSelect}
                      />
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            {/* Upload tab */}
            <TabsContent value="upload" className="flex flex-col flex-1 min-h-0 mt-0 data-[state=active]:flex">
              <div className="flex flex-col flex-1 items-center justify-center border border-dashed border-border bg-background rounded-md p-6 gap-4">
                <div className="text-center space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Ziel: <span className="font-mono">user-uploads/studio-references</span>
                  </p>
                  <p className="text-xs text-muted-foreground">Maximale Dateigröße und automatische Bildverkleinerung verfügbar.</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                >
                  {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Dateien wählen
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*"
                  multiple
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      void preprocessFileSelection(e.target.files);
                    }
                    e.target.value = '';
                  }}
                />
                {error && <p className="text-sm text-destructive mt-2">{error}</p>}
              </div>
            </TabsContent>
          </Tabs>

          {/* Selection preview */}
          {currentSelectionDisplay.length > 0 && (
            <div className="shrink-0 pt-4 border-t border-border">
              <p className="text-xs text-muted-foreground mb-2">
                {currentSelectionDisplay.length} ausgewählt
              </p>
              <div className="flex flex-wrap gap-2">
                {currentSelectionDisplay.map((asset) => (
                  <button
                    key={asset.path}
                    type="button"
                    onClick={() => toggleSelect(asset.path)}
                    className="relative group overflow-hidden border rounded-md transition hover:border-destructive"
                    title="Zum Entfernen klicken"
                  >
                     {/* eslint-disable-next-line @next/next/no-img-element */}
                     <img src={asset.previewUrl} alt={asset.name} className="h-10 w-10 object-cover" />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-50 bg-black/30">
                      <X className="h-4 w-4 text-white" />
                    </div>
                    {/* Missing X import? using hidden */}
                  </button>
                ))}
              </div>
            </div>
          )}

          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {selectedPaths.size === 0 ? 'Nichts ausgewählt' : `${selectedPaths.size} Datei(en) ausgewählt`}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button
                disabled={selectedPaths.size === 0}
                onClick={() => {
                  onConfirm(Array.from(selectedPaths));
                  onOpenChange(false);
                }}
              >
                Referenzen hinzufügen
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImagePreprocessDialog
        open={imagePreprocessFiles !== null}
        onOpenChange={(o) => {
          if (!o) {
            setImagePreprocessFiles(null);
            setImagePreprocessPendingFiles([]);
          }
        }}
        files={imagePreprocessFiles ?? []}
        onConfirm={handleImagePreprocessConfirm}
        onSkip={handleImagePreprocessSkip}
      />
    </>
  );
}
