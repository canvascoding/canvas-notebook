'use client';

import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { ImageThumbnailIcon } from '@/app/components/shared/ImageThumbnailIcon';
import { isImageFile } from '@/app/lib/files/file-icons';

export interface ComposerReferencePickerItem<T = unknown> {
  id: string;
  kind: 'file' | 'skill';
  icon: ReactNode;
  label: string;
  payload: T;
  secondaryLabel?: string;
}

interface ComposerReferencePickerProps<T = unknown> {
  className?: string;
  emptyState: string;
  isLoading?: boolean;
  header: string;
  items: ComposerReferencePickerItem<T>[];
  onSelect: (item: ComposerReferencePickerItem<T>) => void;
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSearchValueChange?: (value: string) => void;
  searchAutoFocus?: boolean;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  searchPlaceholder?: string;
  searchValue?: string;
  pickerRef?: React.RefObject<HTMLDivElement | null>;
  selectedIndex: number;
}

type FileReferencePayload = {
  isImage?: unknown;
  name?: unknown;
  path?: unknown;
  type?: unknown;
};

function getImageReferencePayload(payload: unknown): { name: string; path: string } | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const file = payload as FileReferencePayload;
  const name = typeof file.name === 'string' ? file.name : '';
  const path = typeof file.path === 'string' ? file.path : '';
  const type = typeof file.type === 'string' ? file.type : 'file';
  const isImage = file.isImage === true || isImageFile(path) || isImageFile(name);

  if (!path || type === 'directory' || !isImage) {
    return null;
  }

  return {
    name: name || path.split('/').pop() || path,
    path,
  };
}

function ReferencePickerIcon<T>({ item }: { item: ComposerReferencePickerItem<T> }) {
  const imagePayload = item.kind === 'file' ? getImageReferencePayload(item.payload) : null;

  if (imagePayload) {
    return (
      <ImageThumbnailIcon
        path={imagePayload.path}
        name={imagePayload.name}
        className="h-8 w-8 rounded-sm"
        fallbackIcon={item.icon}
      />
    );
  }

  return item.icon;
}

export function ComposerReferencePicker<T = unknown>({
  className,
  emptyState,
  isLoading = false,
  header,
  items,
  onSelect,
  onSearchKeyDown,
  onSearchValueChange,
  pickerRef,
  searchAutoFocus = false,
  searchInputRef,
  searchPlaceholder,
  searchValue,
  selectedIndex,
}: ComposerReferencePickerProps<T>) {
  const showSearch = Boolean(onSearchValueChange);

  return (
    <div
      ref={pickerRef}
      data-testid="chat-reference-picker"
      className={`absolute bottom-full left-0 z-50 mb-1 max-h-60 w-full overflow-y-auto border border-border bg-background shadow-lg ${className || ''}`}
    >
      <div className="border-b border-border p-2">
        <div className="text-xs text-muted-foreground">{header}</div>
        {showSearch ? (
          <input
            ref={searchInputRef}
            type="search"
            value={searchValue || ''}
            onChange={(event) => onSearchValueChange?.(event.target.value)}
            onKeyDown={onSearchKeyDown}
            autoFocus={searchAutoFocus}
            placeholder={searchPlaceholder}
            className="mt-2 h-8 w-full border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
          />
        ) : null}
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
          <span data-testid="chat-reference-icon" className="flex h-8 w-8 shrink-0 items-center justify-center">
            <ReferencePickerIcon item={item} />
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
          {isLoading ? '...' : emptyState}
        </div>
      ) : null}
    </div>
  );
}
