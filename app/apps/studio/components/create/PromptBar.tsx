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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReferencePickerDialog } from './ReferencePickerDialog';
import { ReferenceHoverCard } from './ReferenceHoverCard';
import { ModelReferencePickerDialog } from './ModelReferencePickerDialog';
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
  productsLoading: boolean;
  personasLoading: boolean;
  stylesLoading: boolean;
  presets: StudioPreset[];
  fetchProducts: () => Promise<void>;
  fetchPersonas: () => Promise<void>;
  fetchStyles: () => Promise<void>;
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

type MultiImageReferenceModel = StudioProduct | StudioPersona | StudioStyle;

function getModelPreviewImagePaths(model: MultiImageReferenceModel | undefined, fallbackPath?: string) {
  const paths = [
    ...(model?.images ?? [])
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((image) => image.filePath),
    fallbackPath,
  ];
  const seen = new Set<string>();

  return paths.filter((path): path is string => {
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

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
  productsLoading,
  personasLoading,
  stylesLoading,
  presets: _presets,
  fetchProducts,
  fetchPersonas,
  fetchStyles,
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
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false);
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
  const getProductThumbnail = useCallback((product: ReferenceTag) => productMap.get(product.id)?.thumbnailPath ?? product.thumbnailPath, [productMap]);
  const getPersonaThumbnail = useCallback((persona: ReferenceTag) => personaMap.get(persona.id)?.thumbnailPath ?? persona.thumbnailPath, [personaMap]);
  const getStyleThumbnail = useCallback((style: ReferenceTag) => styleMap.get(style.id)?.thumbnailPath ?? style.thumbnailPath, [styleMap]);
  const getProductPreviewImagePaths = useCallback((product: ReferenceTag) => {
    const model = productMap.get(product.id);
    return getModelPreviewImagePaths(model, model?.thumbnailPath ?? product.thumbnailPath);
  }, [productMap]);
  const getPersonaPreviewImagePaths = useCallback((persona: ReferenceTag) => {
    const model = personaMap.get(persona.id);
    return getModelPreviewImagePaths(model, model?.thumbnailPath ?? persona.thumbnailPath);
  }, [personaMap]);
  const getStylePreviewImagePaths = useCallback((style: ReferenceTag) => {
    const model = styleMap.get(style.id);
    return getModelPreviewImagePaths(model, model?.thumbnailPath ?? style.thumbnailPath);
  }, [styleMap]);

  return (
    <div className="rounded-[28px] border border-border/80 bg-card/95 p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <AtSign className="h-3.5 w-3.5" />
          {t('title')}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => {
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
              thumbnailPath={getProductThumbnail(product)}
              previewImagePaths={getProductPreviewImagePaths(product)}
              fallbackIcon={<Package2 className="h-4 w-4 text-amber-600" />}
              bgColor="bg-amber-50"
              onRemove={() => onReferenceRemove('product', product.id)}
            >
              <ReferenceChip
                label={`@product ${product.name}`}
                borderColor="border-amber-400"
                bgColor="bg-amber-50"
                thumbnailUrl={getProductThumbnail(product) ? toPreviewUrl(getProductThumbnail(product)!, 64, { preset: 'mini' }) : undefined}
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
              thumbnailPath={getPersonaThumbnail(persona)}
              previewImagePaths={getPersonaPreviewImagePaths(persona)}
              fallbackIcon={<UserRound className="h-4 w-4 text-sky-600" />}
              bgColor="bg-sky-50"
              onRemove={() => onReferenceRemove('persona', persona.id)}
            >
              <ReferenceChip
                label={`@persona ${persona.name}`}
                borderColor="border-sky-400"
                bgColor="bg-sky-50"
                thumbnailUrl={getPersonaThumbnail(persona) ? toPreviewUrl(getPersonaThumbnail(persona)!, 64, { preset: 'mini' }) : undefined}
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
              thumbnailPath={getStyleThumbnail(style)}
              previewImagePaths={getStylePreviewImagePaths(style)}
              fallbackIcon={<LayoutTemplate className="h-4 w-4 text-emerald-600" />}
              bgColor="bg-emerald-50"
              onRemove={() => onReferenceRemove('style', style.id)}
            >
              <ReferenceChip
                label={`@style ${style.name}`}
                borderColor="border-emerald-400"
                bgColor="bg-emerald-50"
                thumbnailUrl={getStyleThumbnail(style) ? toPreviewUrl(getStyleThumbnail(style)!, 64, { preset: 'mini' }) : undefined}
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

      <ModelReferencePickerDialog
        open={referenceDialogOpen}
        onOpenChange={setReferenceDialogOpen}
        products={products}
        personas={personas}
        styles={styles}
        productsLoading={productsLoading}
        personasLoading={personasLoading}
        stylesLoading={stylesLoading}
        selectedProductIds={value.productRefs.map((product) => product.id)}
        selectedPersonaIds={value.personaRefs.map((persona) => persona.id)}
        selectedStyleIds={value.styleRefs.map((style) => style.id)}
        fetchProducts={fetchProducts}
        fetchPersonas={fetchPersonas}
        fetchStyles={fetchStyles}
        fileReferenceCount={value.fileRefs.length}
        onImageReferenceClick={() => {
          setMediaPicker('image');
          setCloseReferenceDialogOnPickerConfirm(true);
          setPickerOpen(true);
        }}
        onProductAdd={onProductAdd}
        onPersonaAdd={onPersonaAdd}
        onStyleAdd={onStyleAdd}
      />

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
