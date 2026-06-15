'use client';

import { useMemo, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import {
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReferencePickerDialog } from './ReferencePickerDialog';
import { ReferenceHoverCard, type ReferenceType } from './ReferenceHoverCard';
import { ModelReferencePickerDialog } from './ModelReferencePickerDialog';
import type { StudioPreset } from '../../types/presets';
import type { StudioPersona, StudioProduct, StudioStyle } from '../../types/models';
import { StudioMediaThumbnail } from '../StudioMediaThumbnail';

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
    <div
      className={cn(
        'inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-full border px-1.5 py-1 pr-1 text-foreground shadow-sm',
        borderColor,
        bgColor,
      )}
      title={label}
    >
      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border', borderColor, bgColor)}>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : thumbnailUrl ? (
          <StudioMediaThumbnail
            src={thumbnailUrl}
            alt=""
            fallback={icon}
            skeletonIcon={icon}
            className="rounded-none bg-transparent"
          />
        ) : (
          icon
        )}
      </span>
      <span className="min-w-0 truncate text-xs font-medium leading-none">{label}</span>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemove();
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

interface ReferenceRenderItem {
  key: string;
  name: string;
  type: ReferenceType;
  thumbnailPath?: string;
  previewImagePaths?: string[];
  fallbackIcon: React.ReactNode;
  bgColor: string;
  borderColor: string;
  label: string;
  chipIcon: React.ReactNode;
  thumbnailUrl?: string;
  isLoading?: boolean;
  onRemove: () => void;
}

function ReferenceTagItem({ item }: { item: ReferenceRenderItem }) {
  return (
    <ReferenceHoverCard
      name={item.name}
      type={item.type}
      thumbnailPath={item.thumbnailPath}
      previewImagePaths={item.previewImagePaths}
      fallbackIcon={item.fallbackIcon}
      bgColor={item.bgColor}
      onRemove={item.onRemove}
    >
      <ReferenceChip
        label={item.label}
        borderColor={item.borderColor}
        bgColor={item.bgColor}
        thumbnailUrl={item.thumbnailUrl}
        icon={item.chipIcon}
        onRemove={item.onRemove}
        isLoading={item.isLoading}
      />
    </ReferenceHoverCard>
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
  const referenceItems: ReferenceRenderItem[] = [
    ...value.productRefs.map((product) => {
      const thumbnailPath = getProductThumbnail(product);
      return {
        key: `product:${product.id}`,
        name: product.name,
        type: 'product' as const,
        thumbnailPath,
        previewImagePaths: getProductPreviewImagePaths(product),
        fallbackIcon: <Package2 className="h-4 w-4 text-amber-600" />,
        bgColor: 'bg-amber-50',
        borderColor: 'border-amber-400',
        label: `@product ${product.name}`,
        chipIcon: <Package2 className="h-4 w-4 text-amber-600" />,
        thumbnailUrl: thumbnailPath ? toPreviewUrl(thumbnailPath, 64, { preset: 'mini' }) : undefined,
        onRemove: () => onReferenceRemove('product', product.id),
      };
    }),
    ...value.personaRefs.map((persona) => {
      const thumbnailPath = getPersonaThumbnail(persona);
      return {
        key: `persona:${persona.id}`,
        name: persona.name,
        type: 'persona' as const,
        thumbnailPath,
        previewImagePaths: getPersonaPreviewImagePaths(persona),
        fallbackIcon: <UserRound className="h-4 w-4 text-sky-600" />,
        bgColor: 'bg-sky-50',
        borderColor: 'border-sky-400',
        label: `@persona ${persona.name}`,
        chipIcon: <UserRound className="h-4 w-4 text-sky-600" />,
        thumbnailUrl: thumbnailPath ? toPreviewUrl(thumbnailPath, 64, { preset: 'mini' }) : undefined,
        onRemove: () => onReferenceRemove('persona', persona.id),
      };
    }),
    ...value.styleRefs.map((style) => {
      const thumbnailPath = getStyleThumbnail(style);
      return {
        key: `style:${style.id}`,
        name: style.name,
        type: 'style' as const,
        thumbnailPath,
        previewImagePaths: getStylePreviewImagePaths(style),
        fallbackIcon: <LayoutTemplate className="h-4 w-4 text-emerald-600" />,
        bgColor: 'bg-emerald-50',
        borderColor: 'border-emerald-400',
        label: `@style ${style.name}`,
        chipIcon: <LayoutTemplate className="h-4 w-4 text-emerald-600" />,
        thumbnailUrl: thumbnailPath ? toPreviewUrl(thumbnailPath, 64, { preset: 'mini' }) : undefined,
        onRemove: () => onReferenceRemove('style', style.id),
      };
    }),
    ...(value.presetRef ? (() => {
      const CategoryIcon = PRESET_CATEGORY_ICONS[value.presetRef.category ?? ''] ?? Layers;
      return [{
        key: `preset:${value.presetRef.id}`,
        name: value.presetRef.name,
        type: 'preset' as const,
        thumbnailPath: value.presetRef.previewImagePath ?? undefined,
        fallbackIcon: <CategoryIcon className="h-4 w-4 text-violet-600" />,
        bgColor: 'bg-violet-50',
        borderColor: 'border-violet-400',
        label: `@studio ${value.presetRef.name}`,
        chipIcon: <CategoryIcon className="h-4 w-4 text-violet-600" />,
        thumbnailUrl: value.presetRef.previewImagePath ? toPreviewUrl(value.presetRef.previewImagePath, 64, { preset: 'mini' }) : undefined,
        onRemove: () => onReferenceRemove('preset', value.presetRef?.id || ''),
      }];
    })() : []),
    ...value.fileRefs.map((file) => ({
      key: `file:${file.id}`,
      name: file.name,
      type: 'file' as const,
      thumbnailPath: file.thumbnailPath,
      fallbackIcon: <ImageIcon className="h-4 w-4 text-rose-600" />,
      bgColor: 'bg-rose-50',
      borderColor: 'border-rose-400',
      label: `@file ${file.name}`,
      chipIcon: <ImageIcon className="h-4 w-4 text-rose-600" />,
      thumbnailUrl: file.thumbnailPath ? toPreviewUrl(file.thumbnailPath, 64, { preset: 'mini' }) : undefined,
      isLoading: file.status === 'loading',
      onRemove: () => onReferenceRemove('file', file.id),
    })),
    ...videoReferenceRefs.map((file) => ({
      key: `video:${file.id}`,
      name: file.name,
      type: 'file' as const,
      thumbnailPath: file.thumbnailPath ?? file.id,
      fallbackIcon: <FileVideo className="h-4 w-4 text-indigo-600" />,
      bgColor: 'bg-indigo-50',
      borderColor: 'border-indigo-400',
      label: `@video ${file.name}`,
      chipIcon: <FileVideo className="h-4 w-4 text-indigo-600" />,
      thumbnailUrl: toPreviewUrl(file.thumbnailPath ?? file.id, 64, { preset: 'mini' }),
      isLoading: file.status === 'loading',
      onRemove: () => onReferenceRemove('videoReference', file.id),
    })),
    ...audioReferenceRefs.map((file) => ({
      key: `audio:${file.id}`,
      name: file.name,
      type: 'file' as const,
      fallbackIcon: <Music className="h-4 w-4 text-teal-600" />,
      bgColor: 'bg-teal-50',
      borderColor: 'border-teal-400',
      label: `@audio ${file.name}`,
      chipIcon: <Music className="h-4 w-4 text-teal-600" />,
      isLoading: file.status === 'loading',
      onRemove: () => onReferenceRemove('audioReference', file.id),
    })),
    ...(videoExtendSourceRef ? [{
      key: `extend:${videoExtendSourceRef.id}`,
      name: videoExtendSourceRef.name,
      type: 'file' as const,
      thumbnailPath: videoExtendSourceRef.thumbnailPath ?? videoExtendSourceRef.id,
      fallbackIcon: <FileVideo className="h-4 w-4 text-orange-600" />,
      bgColor: 'bg-orange-50',
      borderColor: 'border-orange-400',
      label: `@extend ${videoExtendSourceRef.name}`,
      chipIcon: <FileVideo className="h-4 w-4 text-orange-600" />,
      thumbnailUrl: toPreviewUrl(videoExtendSourceRef.thumbnailPath ?? videoExtendSourceRef.id, 64, { preset: 'mini' }),
      isLoading: videoExtendSourceRef.status === 'loading',
      onRemove: () => onReferenceRemove('videoExtendSource', videoExtendSourceRef.id),
    }] : []),
  ];

  return (
    <div id="studio-prompt-bar" className="space-y-2">
      {referenceItems.length > 0 ? (
        <div className="flex max-h-[76px] flex-wrap gap-1.5 overflow-y-auto pr-1">
          {referenceItems.map((item) => (
            <ReferenceTagItem key={item.key} item={item} />
          ))}
        </div>
      ) : null}

      <div className="flex items-start gap-2">
        <textarea
          value={value.rawPrompt}
          onChange={(event) => onRawPromptChange(event.target.value)}
          onPaste={handlePaste}
          placeholder={t('placeholder')}
          rows={2}
          className="max-h-32 min-h-[52px] flex-1 resize-none rounded-2xl border border-border/80 bg-background/85 px-3 py-2.5 text-sm leading-5 text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-ring focus:ring-4 focus:ring-ring/15"
        />
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="mt-1 rounded-full"
          aria-label={t('addReference')}
          title={t('addReference')}
          onClick={() => {
            setReferenceDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {isSeedanceVideo ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => { setMediaPicker('image'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
            <ImageIcon className="h-4 w-4" />
            Image refs
            <span className="ml-auto text-xs text-muted-foreground">{value.fileRefs.length}/9</span>
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => { setMediaPicker('video'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
            <FileVideo className="h-4 w-4" />
            Video refs
            <span className="ml-auto text-xs text-muted-foreground">{videoReferenceRefs.length}/3</span>
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 justify-start rounded-full" onClick={() => { setMediaPicker('audio'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
            <Music className="h-4 w-4" />
            Audio refs
            <span className="ml-auto text-xs text-muted-foreground">{audioReferenceRefs.length}/3</span>
          </Button>
        </div>
      ) : null}

      {isVeoVideo ? (
        <div>
          <Button type="button" variant="outline" size="sm" className="h-8 w-full justify-start rounded-full sm:w-auto" onClick={() => { setMediaPicker('extendVideo'); setCloseReferenceDialogOnPickerConfirm(false); setPickerOpen(true); }}>
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
