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
  Layers,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
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
  products: StudioProduct[];
  personas: StudioPersona[];
  styles: StudioStyle[];
  presets: StudioPreset[];
  onRawPromptChange: (value: string) => void;
  onProductAdd: (product: StudioProduct) => void;
  onPersonaAdd: (persona: StudioPersona) => void;
  onStyleAdd: (style: StudioStyle) => void;
  onPresetSelect: (preset: StudioPreset) => void;
  onReferenceRemove: (type: 'product' | 'persona' | 'style' | 'preset' | 'file', id: string) => void;
  onFileAdd: (paths: string[]) => void;
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
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
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


export function PromptBar({ value, products, personas, styles, presets: _presets, onRawPromptChange, onProductAdd, onPersonaAdd, onStyleAdd, onPresetSelect: _onPresetSelect, onReferenceRemove, onFileAdd, onPasteImage }: PromptBarProps) {
  const t = useTranslations('studio.promptBar');
  const [pickerOpen, setPickerOpen] = useState(false);

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

  return (
    <div className="rounded-[28px] border border-border/80 bg-card/95 p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <AtSign className="h-3.5 w-3.5" />
          {t('title')}
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="rounded-full"><AtSign className="h-4 w-4" />{t('addReference')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>{t('referenceCategories')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPickerOpen(true)}><ImageIcon className="h-4 w-4 mr-2" />{t('imageReference')}</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><Package2 className="h-4 w-4" />{t('product')}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {availableProducts.length === 0 ? <DropdownMenuItem disabled>{t('noProducts')}</DropdownMenuItem> : availableProducts.map((product) => (
                    <DropdownMenuItem key={product.id} onSelect={() => onProductAdd(product)} className="flex items-center gap-3">
                      {product.thumbnailPath ? (
                        <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border border-border/50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={toPreviewUrl(product.thumbnailPath, 64, { preset: 'mini' })} alt="" className="h-full w-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        </div>
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border border-border/50 bg-muted flex items-center justify-center">
                          <Package2 className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium">{product.name}</div>
                        {product.description ? <div className="truncate text-xs text-muted-foreground">{product.description}</div> : null}
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><UserRound className="h-4 w-4" />{t('persona')}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {availablePersonas.length === 0 ? <DropdownMenuItem disabled>{t('noPersonas')}</DropdownMenuItem> : availablePersonas.map((persona) => (
                    <DropdownMenuItem key={persona.id} onSelect={() => onPersonaAdd(persona)} className="flex items-center gap-3">
                      {persona.thumbnailPath ? (
                        <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border border-border/50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={toPreviewUrl(persona.thumbnailPath, 64, { preset: 'mini' })} alt="" className="h-full w-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        </div>
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border border-border/50 bg-muted flex items-center justify-center">
                          <UserRound className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium">{persona.name}</div>
                        {persona.description ? <div className="truncate text-xs text-muted-foreground">{persona.description}</div> : null}
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><LayoutTemplate className="h-4 w-4" />{t('style')}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {availableStyles.length === 0 ? <DropdownMenuItem disabled>{t('noStyles')}</DropdownMenuItem> : availableStyles.map((style) => (
                    <DropdownMenuItem key={style.id} onSelect={() => onStyleAdd(style)} className="flex items-center gap-3">
                      {style.thumbnailPath ? (
                        <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border border-border/50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={toPreviewUrl(style.thumbnailPath, 64, { preset: 'mini' })} alt="" className="h-full w-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        </div>
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-md overflow-hidden border border-border/50 bg-muted flex items-center justify-center">
                          <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium">{style.name}</div>
                        {style.description ? <div className="truncate text-xs text-muted-foreground">{style.description}</div> : null}
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Unified references above textarea */}
      {(value.productRefs.length > 0 || value.personaRefs.length > 0 || value.styleRefs.length > 0 || value.presetRef || value.fileRefs.length > 0) ? (
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

        </div>
      ) : null}

      <textarea value={value.rawPrompt} onChange={(event) => onRawPromptChange(event.target.value)} onPaste={handlePaste} placeholder={t('placeholder')} className="min-h-24 w-full resize-y rounded-3xl border border-border/80 bg-background/95 px-4 py-4 text-sm leading-6 text-foreground outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/15" />

      <ReferencePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onConfirm={(paths) => { onFileAdd(paths); setPickerOpen(false); }} />
    </div>
  );
}
