'use client';

import { useTranslations } from 'next-intl';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Plus,
  X,
  ArrowLeft,
  Sparkles,
  Loader2,
  Image as ImageIcon,
  Trash2,
  Check,
} from 'lucide-react';
import type { StudioBlock, StudioPresetBlockCatalog, StudioPreset } from '../../types/presets';

interface PresetBuilderProps {
  presetId?: string;
}

function getIconComponent(iconName: string) {
  // Dynamically map icon names to Lucide icons
  // We return a simple colored circle since we can't dynamically import Lucide
  const colors: Record<string, string> = {
    Lamp: 'bg-amber-500',
    Crosshair: 'bg-blue-500',
    Square: 'bg-stone-500',
    Clapperboard: 'bg-rose-500',
    Flower2: 'bg-green-500',
    Users: 'bg-purple-500',
    Image: 'bg-sky-500',
    Aperture: 'bg-orange-500',
    Sparkles: 'bg-yellow-500',
    Palette: 'bg-pink-500',
    Layout: 'bg-indigo-500',
    Heart: 'bg-red-500',
    Clock: 'bg-amber-600',
    MapPin: 'bg-teal-500',
    Wand2: 'bg-violet-500',
    Waves: 'bg-cyan-500',
    Move: 'bg-emerald-500',
    Sparkle: 'bg-fuchsia-500',
    Cloud: 'bg-slate-400',
  };
  const colorClass = colors[iconName] || 'bg-gray-500';
  return <div className={cn('h-6 w-6 rounded-full', colorClass)} />;
}

export function PresetBuilder({ presetId }: PresetBuilderProps) {
  useTranslations('studio');
  const router = useRouter();
  const { presets, fetchPresets, fetchBlockCatalog, createPreset, updatePreset, deletePreset, generatePreview } = useStudioPresets();

  const [catalog, setCatalog] = useState<StudioPresetBlockCatalog | null>(null);
  const [activeBlockType, setActiveBlockType] = useState<string | null>(null);
  const [selectedBlocks, setSelectedBlocks] = useState<StudioBlock[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [previewGenerating, setPreviewGenerating] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load catalog and preset data
  useEffect(() => {
    fetchBlockCatalog().then((cat) => {
      if (cat && cat.blockTypes.length > 0) {
        setCatalog(cat);
        setActiveBlockType(cat.blockTypes[0].type);
      }
    });
  }, [fetchBlockCatalog]);

  useEffect(() => {
    if (presetId) {
      fetchPresets().then(() => {
        const preset = presets.find((p: StudioPreset) => p.id === presetId);
        if (preset) {
          setName(preset.name);
          setDescription(preset.description || '');
          setCategory(preset.category || '');
          setTags(preset.tags.join(', '));
          setSelectedBlocks(preset.blocks.map((b) => ({
            id: b.id || '',
            type: b.type,
            label: b.label,
            promptFragment: b.promptFragment,
            category: b.category || b.type,
            description: b.description,
            thumbnailPath: b.thumbnailPath,
          })));
          setPreviewImageUrl(preset.previewImageUrl);
        }
      });
    }
  }, [presetId, fetchPresets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced preview generation
  useEffect(() => {
    if (!previewEnabled || !presetId || selectedBlocks.length === 0) return;

    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }

    previewTimeoutRef.current = setTimeout(() => {
      handleGeneratePreview();
    }, 2000);

    return () => {
      if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    };
  }, [selectedBlocks, previewEnabled, presetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddBlock = useCallback((blockDef: { id: string; type: string; label: string; promptFragment: string; category: string; description?: string }) => {
    setSelectedBlocks((prev) => {
      const exists = prev.find((b) => b.id === blockDef.id);
      if (exists) return prev;
      return [...prev, {
        id: blockDef.id,
        type: blockDef.type,
        label: blockDef.label,
        promptFragment: blockDef.promptFragment,
        category: blockDef.category,
        description: blockDef.description,
        thumbnailPath: null,
      }];
    });
  }, []);

  const handleRemoveBlock = useCallback((blockId: string) => {
    setSelectedBlocks((prev) => prev.filter((b) => b.id !== blockId));
  }, []);

  const handleGeneratePreview = async () => {
    if (!presetId) return;
    setPreviewGenerating(true);
    try {
      const updated = await generatePreview(presetId, { provider: 'gemini', model: 'gemini-2.5-flash-image' });
      if (updated?.previewImageUrl) {
        setPreviewImageUrl(updated.previewImageUrl);
      }
    } catch {
      // Preview generation is optional
    } finally {
      setPreviewGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        category: category.trim() || undefined,
        blocks: selectedBlocks,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      };

      if (presetId) {
        await updatePreset(presetId, payload);
      } else {
        const created = await createPreset(payload);
        if (created) {
          router.push(`/studio/presets/${created.id}`);
          return;
        }
      }

      router.push('/studio/presets');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!presetId) return;
    if (!confirm('Are you sure you want to delete this preset?')) return;
    await deletePreset(presetId);
    router.push('/studio/presets');
  };

  const handleCancel = () => {
    router.push('/studio/presets');
  };

  const currentBlockGroup = catalog?.blockTypes.find((g) => g.type === activeBlockType);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 pb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-bold">
            {presetId ? 'Edit Studio Preset' : 'New Studio Preset'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {presetId && (
            <Button variant="destructive" size="sm" onClick={handleDelete} className="gap-2">
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !name.trim()} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>

      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* Left Sidebar - Block Navigator */}
        <div className="flex w-64 flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-card p-3">
          <h2 className="text-lg font-semibold px-2">Blocks</h2>
          <div className="flex flex-col gap-1">
            {catalog?.blockTypes.map((group) => (
              <button
                key={group.type}
                onClick={() => setActiveBlockType(group.type)}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  activeBlockType === group.type
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-muted text-muted-foreground',
                )}
              >
                {getIconComponent(group.blocks[0]?.icon || 'Sparkles')}
                <span className="capitalize">{group.type}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {group.blocks.length}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Center - Block Options + Form + Preview */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {/* Block Options */}
          {currentBlockGroup && (
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-sm font-semibold capitalize">
                {currentBlockGroup.type}
              </h3>
              <div className="grid grid-cols-1 gap-2">
                {currentBlockGroup.blocks.map((block) => {
                  const isSelected = selectedBlocks.some((b) => b.id === block.id);
                  return (
                    <button
                      key={block.id}
                      onClick={() => {
                        if (isSelected) {
                          handleRemoveBlock(block.id);
                        } else {
                          handleAddBlock(block);
                        }
                      }}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50 hover:bg-muted/50',
                      )}
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                        {getIconComponent(block.icon)}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{block.label}</p>
                        <p className="text-xs text-muted-foreground">{block.description}</p>
                      </div>
                      <div
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-muted-foreground/30',
                        )}
                      >
                        {isSelected ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Preset Details */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold">Preset Details</h3>
            <div className="flex flex-col gap-3">
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Editorial Softbox Portrait" />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea value={description} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)} placeholder="Optional description..." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Category</Label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    <option value="">Select category...</option>
                    {catalog?.categories.map((cat) => (
                      <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Tags (comma separated)</Label>
                  <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="portrait, editorial, soft light" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right - Preview */}
        <div className="flex w-80 flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Preview</h3>
              <div className="flex items-center gap-2">
                <Switch
                  id="preview-toggle"
                  checked={previewEnabled}
                  onCheckedChange={setPreviewEnabled}
                />
                <Label htmlFor="preview-toggle" className="text-xs">
                  Live
                </Label>
              </div>
            </div>

            <div className="aspect-square overflow-hidden rounded-lg bg-muted flex items-center justify-center">
               {previewImageUrl && previewEnabled ? (
                <>
                 {/* eslint-disable-next-line @next/next/no-img-element */}
                 <img
                   src={previewImageUrl}
                   alt="Preview"
                   className="h-full w-full object-cover"
                 />
                </>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <ImageIcon className="h-8 w-8" />
                  <p className="text-xs">{previewEnabled ? 'Preview will generate after saving' : 'Preview disabled'}</p>
                </div>
              )}
              {previewGenerating && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                  <Loader2 className="h-8 w-8 animate-spin text-white" />
                </div>
              )}
            </div>

            {presetId && previewEnabled && (
              <Button
                size="sm"
                variant="outline"
                className="mt-3 w-full gap-2"
                onClick={handleGeneratePreview}
                disabled={previewGenerating}
              >
                {previewGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Generate Preview
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom - Selected Blocks Bar */}
      <div className="mt-4 rounded-xl border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Selected:</span>
          <div className="flex flex-1 flex-wrap gap-2">
            {selectedBlocks.length === 0 && (
              <span className="text-xs text-muted-foreground">No blocks selected yet. Click blocks from the left sidebar to build your preset.</span>
            )}
            {selectedBlocks.map((block) => (
              <div
                key={block.id}
                className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
              >
                {getIconComponent(
                  catalog?.blockTypes.find((g) => g.type === block.type)?.blocks.find((b) => b.id === block.id)?.icon || 'Sparkles'
                )}
                <span>{block.label}</span>
                <button
                  onClick={() => handleRemoveBlock(block.id)}
                  className="ml-1 rounded-full hover:bg-primary/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
