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
  Trash2,
  Check,
  Lamp,
  Crosshair,
  Square,
  Clapperboard,
  Flower2,
  Users,
  Aperture,
  Palette,
  Layout,
  Heart,
  Clock,
  MapPin,
  Wand2,
  Waves,
  Move,
  Cloud,
  Sun,
  Camera,
  Package,
  UtensilsCrossed,
  Cpu,
  Home,
  Car,
  Layers,
  Image as ImageIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StudioBlock, StudioPresetBlockCatalog, StudioPreset } from '../../types/presets';

const PREVIEW_CATEGORY_ICONS: Record<string, LucideIcon> = {
  fashion: Camera,
  product: Package,
  food: UtensilsCrossed,
  lifestyle: Sun,
  beauty: Sparkles,
  tech: Cpu,
  interior: Home,
  automotive: Car,
};

const PREVIEW_CATEGORY_GRADIENTS: Record<string, string> = {
  fashion: 'from-rose-100 to-pink-50',
  product: 'from-slate-100 to-gray-50',
  food: 'from-amber-100 to-yellow-50',
  lifestyle: 'from-orange-100 to-amber-50',
  beauty: 'from-fuchsia-100 to-pink-50',
  tech: 'from-blue-100 to-cyan-50',
  interior: 'from-stone-100 to-neutral-50',
  automotive: 'from-zinc-200 to-zinc-100',
};

const PREVIEW_CATEGORY_ICON_COLORS: Record<string, string> = {
  fashion: 'text-rose-400/60',
  product: 'text-slate-400/60',
  food: 'text-amber-400/60',
  lifestyle: 'text-orange-400/60',
  beauty: 'text-fuchsia-400/60',
  tech: 'text-blue-400/60',
  interior: 'text-stone-400/60',
  automotive: 'text-zinc-500/60',
};

interface PresetBuilderProps {
  presetId?: string;
}

const iconMap: Record<string, React.ReactNode> = {
  Lamp: <Lamp className="h-5 w-5" />,
  Crosshair: <Crosshair className="h-5 w-5" />,
  Square: <Square className="h-5 w-5" />,
  Clapperboard: <Clapperboard className="h-5 w-5" />,
  Flower2: <Flower2 className="h-5 w-5" />,
  Users: <Users className="h-5 w-5" />,
  Image: <ImageIcon className="h-5 w-5" />,
  Aperture: <Aperture className="h-5 w-5" />,
  Sparkles: <Sparkles className="h-5 w-5" />,
  Palette: <Palette className="h-5 w-5" />,
  Layout: <Layout className="h-5 w-5" />,
  Heart: <Heart className="h-5 w-5" />,
  Clock: <Clock className="h-5 w-5" />,
  MapPin: <MapPin className="h-5 w-5" />,
  Wand2: <Wand2 className="h-5 w-5" />,
  Waves: <Waves className="h-5 w-5" />,
  Move: <Move className="h-5 w-5" />,
  Cloud: <Cloud className="h-5 w-5" />,
  Sun: <Sun className="h-5 w-5" />,
};

const iconColors: Record<string, string> = {
  lighting: 'text-amber-500',
  camera: 'text-blue-500',
  surfaces: 'text-stone-500',
  filmTypes: 'text-rose-500',
  props: 'text-green-500',
  characters: 'text-purple-500',
  backgrounds: 'text-sky-500',
  cameraAngles: 'text-orange-500',
  lenses: 'text-cyan-500',
  actions: 'text-yellow-500',
  colorPalettes: 'text-pink-500',
  composition: 'text-indigo-500',
  feeling: 'text-red-500',
  weather: 'text-slate-400',
  historicalPeriods: 'text-amber-600',
  location: 'text-teal-500',
  styles: 'text-violet-500',
  textures: 'text-fuchsia-500',
  positions: 'text-emerald-500',
  visualEffects: 'text-cyan-500',
};

function getIconComponent(iconName: string, type?: string) {
  const icon = iconMap[iconName] || <Sparkles className="h-5 w-5" />;
  const colorClass = type ? iconColors[type] || 'text-gray-500' : 'text-gray-500';
  return <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted', colorClass)}>{icon}</div>;
}

const PRESET_CATEGORIES = [
  'fashion',
  'product',
  'food',
  'lifestyle',
  'beauty',
  'tech',
  'interior',
  'automotive',
] as const;

export function PresetBuilder({ presetId }: PresetBuilderProps) {
  useTranslations('studio');
  const router = useRouter();
  const { fetchPresets, fetchBlockCatalog, createPreset, updatePreset, deletePreset, generatePreview } = useStudioPresets();

  const [catalog, setCatalog] = useState<StudioPresetBlockCatalog | null>(null);
  const [activeBlockType, setActiveBlockType] = useState<string | null>(null);
  const [selectedBlocks, setSelectedBlocks] = useState<StudioBlock[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [previewGenerating, setPreviewGenerating] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const prevPreviewEnabled = useRef(false);

  const canSave = name.trim().length > 0 && category.length > 0 && selectedBlocks.length > 0;

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
      fetchPresets().then((fetchedPresets) => {
        const preset = fetchedPresets.find((p: StudioPreset) => p.id === presetId);
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
  }, [presetId, fetchPresets]);

  // When Live toggle is turned ON and preset exists, generate preview immediately
  useEffect(() => {
    if (previewEnabled && !prevPreviewEnabled.current && presetId && selectedBlocks.length > 0) {
      handleGeneratePreview();
    }
    prevPreviewEnabled.current = previewEnabled;
  }, [previewEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced preview generation on block changes (only when live)
  useEffect(() => {
    if (!previewEnabled || !presetId || selectedBlocks.length === 0) return;

    const timeout = setTimeout(() => {
      handleGeneratePreview();
    }, 2000);

    return () => clearTimeout(timeout);
  }, [selectedBlocks, previewEnabled, presetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddBlock = useCallback((blockDef: { id: string; type: string; label: string; promptFragment: string; category: string; description?: string; icon?: string }) => {
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
    if (!canSave) return;

    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        category: category,
        blocks: selectedBlocks,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      };

      if (presetId) {
        await updatePreset(presetId, payload);
        router.push('/studio/presets');
      } else {
        const created = await createPreset(payload);
        if (created) {
          router.push(`/studio/presets/${created.id}`);
          return;
        }
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save preset');
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
    <div className="flex h-[calc(100vh-8rem)] flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 pb-4 shrink-0">
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
          <Button size="sm" onClick={handleSave} disabled={saving || !canSave} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>

      <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
        {/* Left Sidebar - Block Navigator */}
        <div className="flex w-64 flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-card p-3 shrink-0">
          <h2 className="text-lg font-semibold px-2">
            Blocks <span className="text-xs text-muted-foreground font-normal">{selectedBlocks.length > 0 ? `${selectedBlocks.length} selected` : ''}</span>
          </h2>
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
                {getIconComponent(group.blocks[0]?.icon || 'Sparkles', group.type)}
                <span className="capitalize">{group.type}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {group.blocks.length}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Center - Block Options + Form */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto min-h-0">
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
                      {getIconComponent(block.icon, block.type)}
                      <div className="flex-1 min-w-0">
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
                <Label className="mb-1">
                  Name <span className="text-red-500">*</span>
                </Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Editorial Softbox Portrait" className={!name.trim() && name.length > 0 ? 'border-red-400' : ''} />
              </div>
              <div>
                <Label className="mb-1">Description</Label>
                <Textarea value={description} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)} placeholder="Optional description..." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="mb-1">
                    Category <span className="text-red-500">*</span>
                  </Label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className={cn(
                      'flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm',
                      !category ? 'border-red-400' : 'border-input',
                    )}
                  >
                    <option value="">Select category...</option>
                    {PRESET_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="mb-1">Tags (comma separated)</Label>
                  <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="portrait, editorial, soft light" />
                </div>
              </div>
            </div>
            {saveError && (
              <p className="mt-2 text-sm text-red-500">{saveError}</p>
            )}
          </div>
        </div>

        {/* Right - Preview */}
        <div className="flex w-80 flex-col gap-4 shrink-0">
          <div className="rounded-xl border border-border bg-card p-4 overflow-y-auto">
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

            <div className="aspect-square overflow-hidden rounded-lg bg-muted flex items-center justify-center relative">
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
                <div className={cn('flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br', PREVIEW_CATEGORY_GRADIENTS[category ?? ''] ?? 'from-muted to-muted/50')}>
                  {(() => {
                    const FallbackIcon = PREVIEW_CATEGORY_ICONS[category ?? ''] ?? Layers;
                    const iconColor = PREVIEW_CATEGORY_ICON_COLORS[category ?? ''] ?? 'text-muted-foreground/40';
                    return <FallbackIcon className={cn('h-10 w-10', iconColor)} />;
                  })()}
                  <span className="max-w-[80%] text-center text-xs font-medium leading-tight text-muted-foreground/50 line-clamp-2">
                    {name || 'Preset Preview'}
                  </span>
                  {!previewEnabled && !presetId && (
                    <p className="text-[10px] text-muted-foreground/40">Save preset first, then enable Live Preview</p>
                  )}
                  {!previewEnabled && presetId && (
                    <p className="text-[10px] text-muted-foreground/40">Enable Live Preview to generate</p>
                  )}
                  {previewEnabled && !presetId && (
                    <p className="text-[10px] text-muted-foreground/40">Save preset first to generate preview</p>
                  )}
                  {previewEnabled && presetId && !previewImageUrl && !previewGenerating && (
                    <p className="text-[10px] text-muted-foreground/40">Click Generate Preview or add blocks</p>
                  )}
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
      <div className="mt-4 rounded-xl border border-border bg-card p-3 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Selected <span className="text-red-500">*</span>:
          </span>
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
                  catalog?.blockTypes.find((g) => g.type === block.type)?.blocks.find((b) => b.id === block.id)?.icon || 'Sparkles',
                  block.type
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