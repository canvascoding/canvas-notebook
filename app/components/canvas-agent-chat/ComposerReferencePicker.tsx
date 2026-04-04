'use client';

import type { ReactNode } from 'react';

export interface ComposerReferencePickerItem<T = unknown> {
  id: string;
  kind: 'file' | 'skill';
  icon: ReactNode;
  label: string;
  payload: T;
  secondaryLabel?: string;
}

interface ComposerReferencePickerProps<T = unknown> {
  emptyState: string;
  header: string;
  items: ComposerReferencePickerItem<T>[];
  onSelect: (item: ComposerReferencePickerItem<T>) => void;
  pickerRef?: React.RefObject<HTMLDivElement | null>;
  selectedIndex: number;
}

export function ComposerReferencePicker<T = unknown>({
  emptyState,
  header,
  items,
  onSelect,
  pickerRef,
  selectedIndex,
}: ComposerReferencePickerProps<T>) {
  return (
    <div
      ref={pickerRef}
      data-testid="chat-reference-picker"
      className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-full overflow-y-auto border border-border bg-background shadow-lg"
    >
      <div className="border-b border-border p-2 text-xs text-muted-foreground">
        {header}
      </div>
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          data-testid="chat-reference-item"
          data-reference-kind={item.kind}
          onClick={() => onSelect(item)}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
            index === selectedIndex ? 'bg-accent' : ''
          }`}
        >
          <span data-testid="chat-reference-icon" className="flex h-4 w-4 items-center justify-center">
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate">{item.label}</div>
            {item.secondaryLabel ? (
              <div className="truncate text-xs text-muted-foreground">{item.secondaryLabel}</div>
            ) : null}
          </div>
          {index === selectedIndex ? <span className="text-xs text-muted-foreground">↵</span> : null}
        </button>
      ))}
      {items.length === 0 ? (
        <div className="p-3 text-center text-sm text-muted-foreground">
          {emptyState}
        </div>
      ) : null}
    </div>
  );
}
