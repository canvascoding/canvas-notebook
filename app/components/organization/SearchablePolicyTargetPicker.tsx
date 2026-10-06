'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger, ScopedPopover, ScopedPopoverContent, ScopedPopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type PolicyTargetOption = {
  id: string;
  label: string;
  description: string | null;
};

type SearchablePolicyTargetPickerProps = {
  id: string;
  value: string;
  options: PolicyTargetOption[];
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  disabled?: boolean;
  portalContainer?: HTMLElement | null;
  testId: string;
  onValueChange: (value: string) => void;
};

export function SearchablePolicyTargetPicker({
  id,
  value,
  options,
  label,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  disabled = false,
  portalContainer,
  testId,
  onValueChange,
}: SearchablePolicyTargetPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => options.find((option) => option.id === value) || null,
    [options, value],
  );
  const PickerPopover = portalContainer ? ScopedPopover : Popover;
  const PickerTrigger = portalContainer ? ScopedPopoverTrigger : PopoverTrigger;
  const PickerContent = portalContainer ? ScopedPopoverContent : PopoverContent;

  return (
    <PickerPopover open={disabled ? false : open} onOpenChange={(nextOpen) => {
      if (!disabled) setOpen(nextOpen);
    }}>
      <PickerTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={!disabled && open}
          disabled={disabled}
          data-testid={testId}
          className="h-9 w-full min-w-0 justify-between px-3 font-normal"
        >
          <span className={cn('min-w-0 truncate text-left', !selected && 'text-muted-foreground')}>
            {selected?.label || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PickerTrigger>
      <PickerContent
        portalContainer={portalContainer}
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
      >
        <Command>
          <CommandInput aria-label={searchPlaceholder} placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.description || ''} ${option.id}`}
                  data-testid={`${testId}-option-${option.id}`}
                  className="items-start py-2.5"
                  onSelect={() => {
                    onValueChange(option.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mt-0.5 h-4 w-4', value === option.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{option.description}</span>
                    ) : null}
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">{option.id}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PickerContent>
    </PickerPopover>
  );
}
