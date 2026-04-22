'use client';

import { useMemo, useState } from 'react';
import { AtSign, LayoutTemplate, Package2, Plus, UserRound, X, Image as ImageIcon } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { ReferencePickerDialog } from './ReferencePickerDialog';
import type { StudioReferenceUrl } from '../../types/generation';
import type { StudioPreset } from '../../types/presets';
import type { StudioPersona, StudioProduct, StudioStyle } from '../../types/models';

interface ReferenceTag {
  id: string;
  name: string;
}

interface PromptBarValue {
  rawPrompt: string;
  productRefs: ReferenceTag[];
  personaRefs: ReferenceTag[];
  styleRefs: ReferenceTag[];
  presetRef: StudioPreset | null;
  extraReferenceUrls: StudioReferenceUrl[];
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
  onExtraReferenceUrlAdd: (value: string) => void;
  onExtraReferenceUrlRemove: (value: string) => void;
  onFileAdd: (paths: string[]) => void;
}

function ReferenceChip({
  label,
  colorClassName,
  onRemove,
}: {
  label: string;
  colorClassName: string;
  onRemove: () => void;
}) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${colorClassName}`}>
      {label}
      <button type="button" onClick={onRemove} className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function ReferenceUrlChip({
  reference,
  onRemove,
}: {
  reference: StudioReferenceUrl;
  onRemove: () => void;
}) {
  if (reference.status === 'loading') {
    return (
      <div className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs bg-muted text-muted-foreground">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span className="max-w-[150px] truncate">{reference.originalUrl}</span>
        <button type="button" onClick={onRemove} className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10">
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  if (reference.status === 'error') {
    return (
      <div className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300">
        <div className="h-8 w-8 rounded bg-red-200 dark:bg-red-800 flex items-center justify-center text-[10px]">!</div>
        <span className="max-w-[150px] truncate" title={reference.errorMessage}>
          {reference.errorMessage || 'Failed'}
        </span>
        <button type="button" onClick={onRemove} className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10">
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs bg-muted text-foreground">
       {/* eslint-disable-next-line @next/next/no-img-element */}
       <img
        src={reference.localUrl}
        alt=""
        className="h-8 w-8 rounded object-cover"
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
      <span className="max-w-[150px] truncate">{reference.originalUrl}</span>
      <button type="button" onClick={onRemove} className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function PromptBar({
  value,
  products,
  personas,
  styles,
  presets,
  onRawPromptChange,
  onProductAdd,
  onPersonaAdd,
  onStyleAdd,
  onPresetSelect,
  onReferenceRemove,
  onExtraReferenceUrlAdd,
  onExtraReferenceUrlRemove,
  onFileAdd,
}: PromptBarProps) {
  const [showOptions, setShowOptions] = useState(false);
  const [extraReferenceUrlInput, setExtraReferenceUrlInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const availableProducts = useMemo(
    () => (products ?? []).filter((product) => !(value.productRefs ?? []).some((selected) => selected.id === product.id)),
    [products, value.productRefs],
  );
  const availablePersonas = useMemo(
    () => (personas ?? []).filter((persona) => !(value.personaRefs ?? []).some((selected) => selected.id === persona.id)),
    [personas, value.personaRefs],
  );
  const availableStyles = useMemo(
    () => (styles ?? []).filter((style) => !(value.styleRefs ?? []).some((selected) => selected.id === style.id)),
    [styles, value.styleRefs],
  );

  return (
    <div className="rounded-[28px] border border-border/70 bg-card/90 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <AtSign className="h-3.5 w-3.5" />
          Prompt Bar
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="rounded-full">
                <AtSign className="h-4 w-4" />
                Add reference
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>Reference categories</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPickerOpen(true)}>
                <ImageIcon className="h-4 w-4 mr-2" />
                Bildreferenz
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Package2 className="h-4 w-4" />
                  Product
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {availableProducts.length === 0 ? (
                    <DropdownMenuItem disabled>No products available</DropdownMenuItem>
                  ) : (
                    availableProducts.map((product) => (
                      <DropdownMenuItem key={product.id} onSelect={() => onProductAdd(product)}>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{product.name}</div>
                          {product.description ? (
                            <div className="truncate text-xs text-muted-foreground">{product.description}</div>
                          ) : null}
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <UserRound className="h-4 w-4" />
                  Persona
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {availablePersonas.length === 0 ? (
                    <DropdownMenuItem disabled>No personas available</DropdownMenuItem>
                  ) : (
                    availablePersonas.map((persona) => (
                      <DropdownMenuItem key={persona.id} onSelect={() => onPersonaAdd(persona)}>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{persona.name}</div>
                          {persona.description ? (
                            <div className="truncate text-xs text-muted-foreground">{persona.description}</div>
                          ) : null}
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <LayoutTemplate className="h-4 w-4" />
                  Style
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {availableStyles.length === 0 ? (
                    <DropdownMenuItem disabled>No styles available</DropdownMenuItem>
                  ) : (
                    availableStyles.map((style) => (
                      <DropdownMenuItem key={style.id} onSelect={() => onStyleAdd(style)}>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{style.name}</div>
                          {style.description ? (
                            <div className="truncate text-xs text-muted-foreground">{style.description}</div>
                          ) : null}
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <LayoutTemplate className="h-4 w-4" />
                  Studio
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {presets.length === 0 ? (
                    <DropdownMenuItem disabled>No presets available</DropdownMenuItem>
                  ) : (
                    presets.map((preset) => (
                      <DropdownMenuItem key={preset.id} onSelect={() => onPresetSelect(preset)}>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{preset.name}</div>
                          <div className="truncate text-xs text-muted-foreground capitalize">
                            {preset.category || 'uncategorized'}
                          </div>
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => setShowOptions((current) => !current)}
          >
            <Plus className="h-4 w-4" />
            More options
          </Button>
        </div>
      </div>

      {(value.productRefs.length > 0 || value.personaRefs.length > 0 || value.styleRefs.length > 0 || value.presetRef || value.fileRefs.length > 0) ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {value.productRefs.map((product) => (
            <ReferenceChip
              key={product.id}
              label={`@product ${product.name}`}
              colorClassName="bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
              onRemove={() => onReferenceRemove('product', product.id)}
            />
          ))}
          {value.personaRefs.map((persona) => (
            <ReferenceChip
              key={persona.id}
              label={`@persona ${persona.name}`}
              colorClassName="bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-200"
              onRemove={() => onReferenceRemove('persona', persona.id)}
            />
          ))}
          {value.styleRefs.map((style) => (
            <ReferenceChip
              key={style.id}
              label={`@style ${style.name}`}
              colorClassName="bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200"
              onRemove={() => onReferenceRemove('style', style.id)}
            />
          ))}
          {value.presetRef ? (
            <ReferenceChip
              label={`@studio ${value.presetRef.name}`}
              colorClassName="bg-violet-100 text-violet-900 dark:bg-violet-500/15 dark:text-violet-200"
              onRemove={() => onReferenceRemove('preset', value.presetRef?.id || '')}
            />
          ) : null}
          {value.fileRefs.map((file) => (
            <ReferenceChip
              key={file.id}
              label={`@file ${file.name}`}
              colorClassName="bg-rose-100 text-rose-900 dark:bg-rose-500/15 dark:text-rose-200"
              onRemove={() => onReferenceRemove('file', file.id)}
            />
          ))}
        </div>
      ) : null}

      <textarea
        value={value.rawPrompt}
        onChange={(event) => onRawPromptChange(event.target.value)}
        placeholder="Describe the scene, subject, and intended output..."
        className="min-h-28 w-full resize-y rounded-3xl border border-border/70 bg-background/70 px-4 py-4 text-sm leading-6 text-foreground outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/15"
      />

      {showOptions ? (
        <div className="mt-3 grid gap-3 rounded-3xl border border-border/70 bg-background/60 p-3 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Additional reference URLs
            </label>
            <div className="flex gap-2">
              <Input
                value={extraReferenceUrlInput}
                onChange={(event) => setExtraReferenceUrlInput(event.target.value)}
                placeholder="https://example.com/reference.jpg"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const trimmed = extraReferenceUrlInput.trim();
                  if (!trimmed) return;
                  onExtraReferenceUrlAdd(trimmed);
                  setExtraReferenceUrlInput('');
                }}
              >
                Add
              </Button>
            </div>
            {value.extraReferenceUrls.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {value.extraReferenceUrls.map((ref) => (
                  <ReferenceUrlChip
                    key={ref.originalUrl}
                    reference={ref}
                    onRemove={() => onExtraReferenceUrlRemove(ref.originalUrl)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <ReferencePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onConfirm={(paths) => {
          onFileAdd(paths);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
