'use client';

import { useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type MemoryOwnerPickerItem = {
  id: string;
  name: string;
  detail: string;
  countLabel: string;
  statusLabel?: string;
};

type MemoryOwnerPickerProps = {
  label: string;
  value: string | null;
  items: MemoryOwnerPickerItem[];
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  testId: string;
  renderVisual: (item: MemoryOwnerPickerItem) => ReactNode;
  onValueChange: (id: string) => void;
};

export function MemoryOwnerPicker({
  label,
  value,
  items,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  testId,
  renderVisual,
  onValueChange,
}: MemoryOwnerPickerProps) {
  const selectedItem = items.find((item) => item.id === value) ?? null;
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid={testId}
            className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-input bg-background px-3 py-2 text-left shadow-xs outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {selectedItem ? renderVisual(selectedItem) : null}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{selectedItem?.name ?? placeholder}</span>
                {selectedItem?.statusLabel ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {selectedItem.statusLabel}
                  </span>
                ) : null}
              </span>
              {selectedItem ? <span className="block truncate text-xs text-muted-foreground">{selectedItem.detail}</span> : null}
            </span>
            {selectedItem ? <span className="shrink-0 text-xs font-medium text-muted-foreground">{selectedItem.countLabel}</span> : null}
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyMessage}</CommandEmpty>
              <CommandGroup>
                {items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${item.name} ${item.detail} ${item.id}`}
                    data-testid={`${testId}-option`}
                    data-current={item.id === value ? 'true' : 'false'}
                    className="gap-3 py-2.5"
                    onSelect={() => {
                      onValueChange(item.id);
                      setOpen(false);
                    }}
                  >
                    {renderVisual(item)}
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{item.name}</span>
                        {item.statusLabel ? (
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {item.statusLabel}
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.countLabel}</span>
                    <Check className={cn('size-4 shrink-0', item.id === value ? 'opacity-100' : 'opacity-0')} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
