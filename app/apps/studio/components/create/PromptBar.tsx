'use client';

import { useMemo, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import {
  AtSign,
  LayoutTemplate,
  Package2,
  UserRound,
  X,
  Image as ImageIcon,
  Camera,
  Package,
  UtensilsCrossed,
  Sun,
  Sparkles,
  Cpu,
  Home,
  Car,
  Loader2,
  Layers,
  FileVideo,
  Music,
  Plus,
  ChevronLeft,
  ChevronRight,
  Search,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ReferencePickerDialog } from './ReferencePickerDialog';
import { ReferenceHoverCard } from './ReferenceHoverCard';
import type { StudioPreset } from '../../types/presets';
import type { StudioPersona, StudioProduct, StudioStyle } from '../../types/models';

interface ReferenceTag {
  id: string;
  name: string;
  thumbnailPath?: string;
  status?: string;
}

interface PromptBarValue {
  rawPrompt: string;
  productRefs: ReferenceTag[];
  personaRefs: ReferenceTag[];
  styleRefs: ReferenceTag[];
  presetRef: StudioPreset | null;
  fileRefs: ReferenceTag[];
}

interface PromptBarProps {
  value: PromptBarValue;
  mode?: 'image' | 'video' | 'sound';
  provider?: string;
  videoReferenceRefs?: ReferenceTag[];
  audioReferenceRefs?: ReferenceTag[];
  videoExtendSourceRef?: ReferenceTag | null;
  products: StudioProduct[];
  personas: StudioPersona[];
  styles: StudioStyle[];
  presets: StudioPreset[];
  onRawPromptChange: (value: string) => void;
  onProductAdd: (product: StudioProduct) => void;
  onPersonaAdd: (persona: StudioPersona) => void;
  onStyleAdd: (style: StudioStyle) => void;
  onPresetSelect: (preset: StudioPreset) => void;
  onReferenceRemove: (type: 'product' | 'persona' | 'style' | 'preset' | 'file' | 'videoReference' | 'audioReference' | 'videoExtendSource', id: string) => void;
  onFileAdd: (paths: string[]) => void;
  onVideoReferenceAdd?: (paths: string[]) => void;
  onAudioReferenceAdd?: (paths: string[]) => void;
  onVideoExtendSourceAdd?: (paths: string[]) => void;
  onPasteImage?: (file: File) => void;
}

const PRESET_CATEGORY_ICONS: Record<string, typeof Camera> = {
  fashion: Camera,
  product: Package,
  food: UtensilsCrossed,
  lifestyle: Sun,
  beauty: Sparkles,
  tech: Cpu,
  interior: Home,
  automotive: Car,
};

interface ReferenceChipProps {
  label: string;
  borderColor: string;
  bgColor: string;
  onRemove: () => void;
  thumbnailUrl?: string;
  icon: React.ReactNode;
  isLoading?: boolean;
}

function ReferenceChip({ label, borderColor, bgColor, onRemove, thumbnailUrl, icon, isLoading }: ReferenceChipProps) {
  return (
    <div className="relative inline-flex" title={label}>
      <div className={cn('h-9 w-9 rounded-md border-2 flex items-center justify-center overflow-hidden', borderColor, bgColor)}>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          icon
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-background text-foreground shadow-sm border border-border/50 hover:bg-accent"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

interface ReferenceOption {
  id: string;
  name: string;
  description?: string | null;
  thumbnailPath?: string | null;
  imageCount?: number;
  images?: {
    id: string;
    filePath: string;
    sortOrder: number;
  }[];
}

interface ReferenceOptionGridProps<T extends ReferenceOption> {
  items: T[];
  emptyText: string;
  createAction: {
    label: string;
    onClick: () => void;
  };
  fallbackIcon: React.ReactNode;
  onSelect: (item: T) => void;
}

function getReferenceImagePaths(item: ReferenceOption) {
  const paths = (item.images ?? [])
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((image) => image.filePath)
    .filter(Boolean);

  if (paths.length > 0) return paths;
  return item.thumbnailPath ? [item.thumbnailPath] : [];
}

function ReferenceTile<T extends ReferenceOption>({
  item,
  fallbackIcon,
  onSelect,
}: {
  item: T;
  fallbackIcon: React.ReactNode;
  onSelect: (item: T) => void;
}) {
  const imagePaths = useMemo(() => getReferenceImagePaths(item), [item]);
  const [imageIndex, setImageIndex] = useState(0);
  const safeImageIndex = imagePaths.length > 0 ? Math.min(imageIndex, imagePaths.length - 1) : 0;
  const currentImage = imagePaths[safeImageIndex];
  const hasMultipleImages = imagePaths.length > 1;

  const handleNavigateImage = (event: React.MouseEvent, direction: -1 | 1) => {
    event.preventDefault();
    event.stopPropagation();
    setImageIndex((current) => {
      if (!hasMultipleImages) return current;
      return (current + direction + imagePaths.length) % imagePaths.length;
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(item);
        }
      }}
      className="group flex min-h-[210px] cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {currentImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={toPreviewUrl(currentImage, 420)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            onError={(event) => {
              (event.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            {fallbackIcon}
          </div>
        )}
        {hasMultipleImages ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={(event) => handleNavigateImage(event, -1)}
              className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/45 text-white shadow-sm opacity-100 transition hover:bg-black/65 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={(event) => handleNavigateImage(event, 1)}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/45 text-white shadow-sm opacity-100 transition hover:bg-black/65 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
              {safeImageIndex + 1}/{imagePaths.length}
            </div>
          </>
        ) : null}
      </div>
      <div className="flex min-h-[76px] flex-col justify-center gap-1 px-3 py-2.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{item.name}</p>
        {item.description ? (
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p>
        ) : null}
      </div>
    </div>
  );
}

function CreateReferenceTile({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[210px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-background p-4 text-center text-sm font-medium text-muted-foreground transition hover:border-primary/60 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-current/25 bg-card">
        <Plus className="h-5 w-5" />
      </span>
      {label}
    </button>
  );
}

function ReferenceOptionGrid<T extends ReferenceOption>({
  items,
  emptyText,
  createAction,
  fallbackIcon,
  onSelect,
}: ReferenceOptionGridProps<T>) {
  return (
    <div className="min-h-[260px] flex-1 overflow-y-auto rounded-md border border-border bg-background p-2 sm:p-3">
      {items.length === 0 ? (
        <div className="mb-3 flex min-h-32 items-center justify-center rounded-md border border-dashed border-border bg-card/50 p-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <ReferenceTile
            key={item.id}
            item={item}
            fallbackIcon={fallbackIcon}
            onSelect={onSelect}
          />
        ))}
        <CreateReferenceTile label={createAction.label} onClick={createAction.onClick} />
      </div>
    </div>
  );
}

function filterReferenceOptions<T extends ReferenceOption>(items: T[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return items;

  return items.filter((item) => {
    if (item.name.toLowerCase().includes(query)) return true;
    if (item.description?.toLowerCase().includes(query)) return true;
    return false;
  });
}

type ReferenceCategory = 'product' | 'persona' | 'style';

export function PromptBar({
  value,
  mode,
  provider,
  videoReferenceRefs = [],
  audioReferenceRefs = [],
  videoExtendSourceRef = null,
  products,
  personas,
  styles,
  presets: _presets,
  onRawPromptChange,
  onProductAdd,
  onPersonaAdd,
  onStyleAdd,
  onPresetSelect: _onPresetSelect,
  onReferenceRemove,
  onFileAdd,
  onVideoReferenceAdd,
  onAudioReferenceAdd,
  onVideoExtendSourceAdd,
  onPasteImage,
}: PromptBarProps) {
  const t = useTranslations('studio.promptBar');
  const tStudio = useTranslations('studio');
  const router = useRouter();
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false);
  const [referenceCategory, setReferenceCategory] = useState<ReferenceCategory>('product');
  const [referenceSearch, setReferenceSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [closeReferenceDialogOnPickerConfirm, setCloseReferenceDialogOnPickerConfirm] = useState(false);
  const [mediaPicker, setMediaPicker] = useState<'image' | 'video' | 'audio' | 'extendVideo'>('image');
  const isSeedanceVideo = mode === 'video' && provider === 'bytedance';
  const isVeoVideo = mode === 'video' && provider === 'veo';

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    if (!onPasteImage) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          event.preventDefault();
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const renamedFile = new File([file], `screenshot-${timestamp}.png`, { type: file.type });
          onPasteImage(renamedFile);
        }
      }
    }
  }, [onPasteImage]);

  const productMap = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const personaMap = useMemo(() => new Map((personas ?? []).map((p) => [p.id, p])), [personas]);
  const styleMap = useMemo(() => new Map((styles ?? []).map((s) => [s.id, s])), [styles]);

  const availableProducts = useMemo(() => (products ?? []).filter((product) => !(value.productRefs ?? []).some((selected) => selected.id === product.id)), [products, value.productRefs]);
  const availablePersonas = useMemo(() => (personas ?? []).filter((persona) => !(value.personaRefs ?? []).some((selected) => selected.id === persona.id)), [personas, value.personaRefs]);
  const availableStyles = useMemo(() => (styles ?? []).filter((style) => !(value.styleRefs ?? []).some((selected) => selected.id === style.id)), [styles, value.styleRefs]);
  const filteredProducts = useMemo(() => filterReferenceOptions(availableProducts, referenceSearch), [availableProducts, referenceSearch]);
  const filteredPersonas = useMemo(() => filterReferenceOptions(availablePersonas, referenceSearch), [availablePersonas, referenceSearch]);
  const filteredStyles = useMemo(() => filterReferenceOptions(availableStyles, referenceSearch), [availableStyles, referenceSearch]);
  const openModelCreate = useCallback((type: 'product' | 'persona' | 'style') => {
    setReferenceDialogOpen(false);
    router.push(`/studio/models/new?type=${type}`);
  }, [router]);
  const getEmptyText = useCallback((baseCount: number, defaultText: string) => {
    if (referenceSearch.trim()) return t('noSearchResults');
    if (baseCount > 0) return t('allReferencesSelected');
    return defaultText;
  }, [referenceSearch, t]);

  return (
    <div className="rounded-[28px] border border-border/80 bg-card/95 p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <AtSign className="h-3.5 w-3.5" />
          {t('title')}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => {
            setReferenceSearch('');
            setReferenceDialogOpen(true);
          }}>
            <AtSign className="h-4 w-4" />
            {t('addReference')}
          </Button>
        </div>
      </div>

      {/* Unified references above textarea */}
      {(value.productRefs.length > 0 || value.personaRefs.length > 0 || value.styleRefs.length > 0 || value.presetRef || value.fileRefs.length > 0 || videoReferenceRefs.length > 0 || audioReferenceRefs.length > 0 || videoExtendSourceRef) ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {value.productRefs.map((product) => (
            <ReferenceHoverCard
              key={product.id}
              name={product.name}
              type="product"
              thumbnailPath={productMap.get(product.id)?.thumbnailPath}
              fallbackIcon={<Package2 className="h-4 w-4 text-amber-600" />}
              bgColor="bg-amber-50"
              onRemove={() => onReferenceRemove('product', product.id)}
            >
              <ReferenceChip
                label={`@product ${product.name}`}
                borderColor="border-amber-400"
                bgColor="bg-amber-50"
                thumbnailUrl={productMap.get(product.id)?.thumbnailPath ? toPreviewUrl(productMap.get(product.id)!.thumbnailPath!, 64, { preset: 'mini' }) : undefined}
                icon={<Package2 className="h-4 w-4 text-amber-600" />}
                onRemove={() => onReferenceRemove('product', product.id)}
              />
            </ReferenceHoverCard>
          ))}
          {value.personaRefs.map((persona) => (
            <ReferenceHoverCard
              key={persona.id}
              name={persona.name}
              type="persona"
              thumbnailPath={personaMap.get(persona.id)?.thumbnailPath}
              fallbackIcon={<UserRound className="h-4 w-4 text-sky-600" />}
              bgColor="bg-sky-50"
              onRemove={() => onReferenceRemove('persona', persona.id)}
            >
              <ReferenceChip
                label={`@persona ${persona.name}`}
                borderColor="border-sky-400"
                bgColor="bg-sky-50"
                thumbnailUrl={personaMap.get(persona.id)?.thumbnailPath ? toPreviewUrl(personaMap.get(persona.id)!.thumbnailPath!, 64, { preset: 'mini' }) : undefined}
                icon={<UserRound className="h-4 w-4 text-sky-600" />}
                onRemove={() => onReferenceRemove('persona', persona.id)}
              />
            </ReferenceHoverCard>
          ))}
          {value.styleRefs.map((style) => (
            <ReferenceHoverCard
              key={style.id}
              name={style.name}
              type="style"
              thumbnailPath={styleMap.get(style.id)?.thumbnailPath}
              fallbackIcon={<LayoutTemplate className="h-4 w-4 text-emerald-600" />}
              bgColor="bg-emerald-50"
              onRemove={() => onReferenceRemove('style', style.id)}
            >
              <ReferenceChip
                label={`@style ${style.name}`}
                borderColor="border-emerald-400"
                bgColor="bg-emerald-50"
                thumbnailUrl={styleMap.get(style.id)?.thumbnailPath ? toPreviewUrl(styleMap.get(style.id)!.thumbnailPath!, 64, { preset: 'mini' }) : undefined}
                icon={<LayoutTemplate className="h-4 w-4 text-emerald-600" />}
                onRemove={() => onReferenceRemove('style', style.id)}
              />
            </ReferenceHoverCard>
          ))}
          {value.presetRef ? (
            <ReferenceHoverCard
              key={value.presetRef.id}
              name={value.presetRef.name}
              type="preset"
              thumbnailPath={value.presetRef.previewImagePath ?? undefined}
              fallbackIcon={(() => {
                const CategoryIcon = PRESET_CATEGORY_ICONS[value.presetRef.category ?? ''] ?? Layers;
                return <CategoryIcon className="h-4 w-4 text-violet-600" />;
              })()}
              bgColor="bg-violet-50"
              onRemove={() => onReferenceRemove('preset', value.presetRef?.id || '')}
            >
              <ReferenceChip
                label={`@studio ${value.presetRef.name}`}
                borderColor="border-violet-400"
                bgColor="bg-violet-50"
                thumbnailUrl={value.presetRef.previewImagePath ? toPreviewUrl(value.presetRef.previewImagePath, 64, { preset: 'mini' }) : undefined}
                icon={(() => {
                  const CategoryIcon = PRESET_CATEGORY_ICONS[value.presetRef.category ?? ''] ?? Layers;
                  return <CategoryIcon className="h-4 w-4 text-violet-600" />;
                })()}
                onRemove={() => onReferenceRemove('preset', value.presetRef?.id || '')}
              />
            </ReferenceHoverCard>
          ) : null}
          {value.fileRefs.map((file) => (
            <ReferenceHoverCard
              key={file.id}
              name={file.name}
              type="file"
              thumbnailPath={file.thumbnailPath}
              fallbackIcon={<ImageIcon className="h-4 w-4 text-rose-600" />}
              bgColor="bg-rose-50"
              onRemove={() => onReferenceRemove('file', file.id)}
            >
              <ReferenceChip
                label={`@file ${file.name}`}
                borderColor="border-rose-400"
                bgColor="bg-rose-50"
                thumbnailUrl={file.thumbnailPath ? toPreviewUrl(file.thumbnailPath, 64, { preset: 'mini' }) : undefined}
                icon={<ImageIcon className="h-4 w-4 text-rose-600" />}
                onRemove={() => onReferenceRemove('file', file.id)}
                isLoading={file.status === 'loading'}
              />
            </ReferenceHoverCard>
          ))}
          {videoReferenceRefs.map((file) => (
            <ReferenceHoverCard
              key={file.id}
              name={file.name}
              type="file"
              fallbackIcon={<FileVideo className="h-4 w-4 text-indigo-600" />}
              bgColor="bg-indigo-50"
              onRemove={() => onReferenceRemove('videoReference', file.id)}
            >
              <ReferenceChip
                label={`@video ${file.name}`}
                borderColor="border-indigo-400"
                bgColor="bg-indigo-50"
                icon={<FileVideo className="h-4 w-4 text-indigo-600" />}
                onRemove={() => onReferenceRemove('videoReference', file.id)}
                isLoading={file.status === 'loading'}
              />
            </ReferenceHoverCard>
          ))}
          {audioReferenceRefs.map((file) => (
            <ReferenceHoverCard
              key={file.id}
              name={file.name}
              type="file"
              fallbackIcon={<Music className="h-4 w-4 text-teal-600" />}
              bgColor="bg-teal-50"
              onRemove={() => onReferenceRemove('audioReference', file.id)}
            >
              <ReferenceChip
                label={`@audio ${file.name}`}
                borderColor="border-teal-400"
                bgColor="bg-teal-50"
                icon={<Music className="h-4 w-4 text-teal-600" />}
                onRemove={() => onReferenceRemove('audioReference', file.id)}
                isLoading={file.status === 'loading'}
              />
            </ReferenceHoverCard>
          ))}
          {videoExtendSourceRef ? (
            <ReferenceHoverCard
              key={videoExtendSourceRef.id}
              name={videoExtendSourceRef.name}
              type="file"
              fallbackIcon={<FileVideo className="h-4 w-4 text-orange-600" />}
              bgColor="bg-orange-50"
              onRemove={() => onReferenceRemove('videoExtendSource', videoExtendSourceRef.id)}
            >
              <ReferenceChip
                label={`@extend ${videoExtendSourceRef.name}`}
                borderColor="border-orange-400"
                bgColor="bg-orange-50"
                icon={<FileVideo className="h-4 w-4 text-orange-600" />}
                onRemove={() => onReferenceRemove('videoExtendSource', videoExtendSourceRef.id)}
                isLoading={videoExtendSourceRef.status === 'loading'}
              />
            </ReferenceHoverCard>
          ) : null}

        </div>
      ) : null}

      <textarea value={value.rawPrompt} onChange={(event) => onRawPromptChange(event.target.value)} onPaste={handlePaste} placeholder={t('placeholder')} className="min-h-24 w-full resize-y rounded-3xl border border-border/80 bg-background/95 px-4 py-4 text-sm leading-6 text-foreground outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/15" />

      {isSeedanceVideo ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Button type="button" variant="outline" size="sm" className="justify-start rounded-xl" onClick={() => { setMediaPicker('image'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
            <ImageIcon className="h-4 w-4" />
            Image refs
            <span className="ml-auto text-xs text-muted-foreground">{value.fileRefs.length}/9</span>
          </Button>
          <Button type="button" variant="outline" size="sm" className="justify-start rounded-xl" onClick={() => { setMediaPicker('video'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
            <FileVideo className="h-4 w-4" />
            Video refs
            <span className="ml-auto text-xs text-muted-foreground">{videoReferenceRefs.length}/3</span>
          </Button>
          <Button type="button" variant="outline" size="sm" className="justify-start rounded-xl" onClick={() => { setMediaPicker('audio'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
            <Music className="h-4 w-4" />
            Audio refs
            <span className="ml-auto text-xs text-muted-foreground">{audioReferenceRefs.length}/3</span>
          </Button>
        </div>
      ) : null}

      {isVeoVideo ? (
        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" className="w-full justify-start rounded-xl sm:w-auto" onClick={() => { setMediaPicker('extendVideo'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
            <FileVideo className="h-4 w-4" />
            Extend source
            <span className="ml-auto text-xs text-muted-foreground">{videoExtendSourceRef ? '1/1' : '0/1'}</span>
          </Button>
        </div>
      ) : null}

      <Dialog
        open={referenceDialogOpen}
        onOpenChange={(open) => {
          setReferenceDialogOpen(open);
          if (!open) setReferenceSearch('');
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col gap-4 overflow-hidden p-4 sm:max-h-[min(86vh,760px)] sm:p-6">
          <DialogHeader>
            <DialogTitle>{t('addReference')}</DialogTitle>
            <DialogDescription className="sr-only">{t('referenceCategories')}</DialogDescription>
          </DialogHeader>

          <Button
            type="button"
            variant="outline"
            className="h-12 w-full justify-start rounded-md"
            onClick={() => {
              setMediaPicker('image');
              setCloseReferenceDialogOnPickerConfirm(true);
              setPickerOpen(true);
            }}
          >
            <ImageIcon className="h-4 w-4" />
            {t('imageReference')}
            <span className="ml-auto text-xs text-muted-foreground">{value.fileRefs.length}/9</span>
          </Button>

          <div className="relative shrink-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={referenceSearch}
              onChange={(event) => setReferenceSearch(event.target.value)}
              placeholder={t('searchPlaceholder')}
              className="h-11 w-full rounded-md border border-input bg-background pl-10 pr-10 text-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/15"
            />
            {referenceSearch ? (
              <button
                type="button"
                onClick={() => setReferenceSearch('')}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <Tabs
            value={referenceCategory}
            onValueChange={(nextValue) => setReferenceCategory(nextValue as ReferenceCategory)}
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="product">
                <Package2 className="h-4 w-4" />
                {t('product')}
              </TabsTrigger>
              <TabsTrigger value="persona">
                <UserRound className="h-4 w-4" />
                {t('persona')}
              </TabsTrigger>
              <TabsTrigger value="style">
                <LayoutTemplate className="h-4 w-4" />
                {t('style')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="product" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex">
              <ReferenceOptionGrid
                items={filteredProducts}
                emptyText={getEmptyText(products.length, t('noProducts'))}
                createAction={{
                  label: tStudio('modelLibrary.newProduct'),
                  onClick: () => openModelCreate('product'),
                }}
                fallbackIcon={<Package2 className="h-4 w-4" />}
                onSelect={(product) => {
                  onProductAdd(product);
                  setReferenceDialogOpen(false);
                }}
              />
            </TabsContent>
            <TabsContent value="persona" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex">
              <ReferenceOptionGrid
                items={filteredPersonas}
                emptyText={getEmptyText(personas.length, t('noPersonas'))}
                createAction={{
                  label: tStudio('modelLibrary.newPersona'),
                  onClick: () => openModelCreate('persona'),
                }}
                fallbackIcon={<UserRound className="h-4 w-4" />}
                onSelect={(persona) => {
                  onPersonaAdd(persona);
                  setReferenceDialogOpen(false);
                }}
              />
            </TabsContent>
            <TabsContent value="style" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex">
              <ReferenceOptionGrid
                items={filteredStyles}
                emptyText={getEmptyText(styles.length, t('noStyles'))}
                createAction={{
                  label: tStudio('modelLibrary.newStyle'),
                  onClick: () => openModelCreate('style'),
                }}
                fallbackIcon={<LayoutTemplate className="h-4 w-4" />}
                onSelect={(style) => {
                  onStyleAdd(style);
                  setReferenceDialogOpen(false);
                }}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <ReferencePickerDialog
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) setCloseReferenceDialogOnPickerConfirm(false);
        }}
        mediaKind={mediaPicker === 'audio' ? 'audio' : mediaPicker === 'image' ? 'image' : 'video'}
        multiple={mediaPicker !== 'extendVideo'}
        maxSelection={mediaPicker === 'extendVideo' ? 1 : mediaPicker === 'image' ? 9 : 3}
        studioOnly={mediaPicker === 'extendVideo'}
        veoGeneratedOnly={mediaPicker === 'extendVideo'}
        onConfirm={(paths) => {
          if (mediaPicker === 'extendVideo') onVideoExtendSourceAdd?.(paths);
          else if (mediaPicker === 'video') onVideoReferenceAdd?.(paths);
          else if (mediaPicker === 'audio') onAudioReferenceAdd?.(paths);
          else onFileAdd(paths);
          setPickerOpen(false);
          if (closeReferenceDialogOnPickerConfirm) {
            setReferenceDialogOpen(false);
            setCloseReferenceDialogOnPickerConfirm(false);
          }
        }}
      />
    </div>
  );
}
