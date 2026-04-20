'use client';

import { useMemo, useState } from 'react';
import { AtSign, Folder, LayoutTemplate, Package2, Plus, UserRound, X } from 'lucide-react';
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
import type { StudioPreset } from '../../types/presets';
import type { StudioPersona, StudioProduct } from '../../types/models';

interface ReferenceTag {
  id: string;
  name: string;
}

interface PromptBarValue {
  rawPrompt: string;
  productRefs: ReferenceTag[];
  personaRefs: ReferenceTag[];
  presetRef: StudioPreset | null;
  negativePrompt: string;
  extraReferenceUrls: string[];
}

interface PromptBarProps {
  value: PromptBarValue;
  products: StudioProduct[];
  personas: StudioPersona[];
  presets: StudioPreset[];
  onRawPromptChange: (value: string) => void;
  onProductAdd: (product: StudioProduct) => void;
  onPersonaAdd: (persona: StudioPersona) => void;
  onPresetSelect: (preset: StudioPreset) => void;
  onReferenceRemove: (type: 'product' | 'persona' | 'preset', id: string) => void;
  onNegativePromptChange: (value: string) => void;
  onExtraReferenceUrlAdd: (value: string) => void;
  onExtraReferenceUrlRemove: (value: string) => void;
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

export function PromptBar({
  value,
  products,
  personas,
  presets,
  onRawPromptChange,
  onProductAdd,
  onPersonaAdd,
  onPresetSelect,
  onReferenceRemove,
  onNegativePromptChange,
  onExtraReferenceUrlAdd,
  onExtraReferenceUrlRemove,
}: PromptBarProps) {
  const [showOptions, setShowOptions] = useState(false);
  const [extraReferenceUrlInput, setExtraReferenceUrlInput] = useState('');

  const availableProducts = useMemo(
    () => products.filter((product) => !value.productRefs.some((selected) => selected.id === product.id)),
    [products, value.productRefs],
  );
  const availablePersonas = useMemo(
    () => personas.filter((persona) => !value.personaRefs.some((selected) => selected.id === persona.id)),
    [personas, value.personaRefs],
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
              <DropdownMenuItem disabled>
                <Folder className="h-4 w-4" />
                File
                <span className="ml-auto text-xs text-muted-foreground">Soon</span>
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

      {(value.productRefs.length > 0 || value.personaRefs.length > 0 || value.presetRef) ? (
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
          {value.presetRef ? (
            <ReferenceChip
              label={`@studio ${value.presetRef.name}`}
              colorClassName="bg-violet-100 text-violet-900 dark:bg-violet-500/15 dark:text-violet-200"
              onRemove={() => onReferenceRemove('preset', value.presetRef?.id || '')}
            />
          ) : null}
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
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Negative prompt
            </label>
            <textarea
              value={value.negativePrompt}
              onChange={(event) => onNegativePromptChange(event.target.value)}
              placeholder="What should the model avoid?"
              className="min-h-24 w-full resize-none rounded-2xl border border-border/70 bg-background/80 px-3 py-3 text-sm outline-none transition focus:border-ring focus:ring-4 focus:ring-ring/15"
            />
          </div>
          <div className="space-y-2">
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
                {value.extraReferenceUrls.map((url) => (
                  <ReferenceChip
                    key={url}
                    label={url}
                    colorClassName="bg-muted text-foreground"
                    onRemove={() => onExtraReferenceUrlRemove(url)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
