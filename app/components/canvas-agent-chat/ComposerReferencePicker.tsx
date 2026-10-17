'use client';

import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { ChatReferenceSourceStatus } from './useComposerReferences';
import { ImageThumbnailIcon } from '@/app/components/shared/ImageThumbnailIcon';
import { isImageFile } from '@/app/lib/files/file-icons';

export interface ComposerReferencePickerItem<T = unknown> {
  id: string;
  kind: 'file' | 'plugin' | 'skill' | 'integration' | 'mcp';
  icon: ReactNode;
  label: string;
  payload: T;
  secondaryLabel?: string;
  /** Optional chat grouping; file-only callers keep their existing presentation. */
  section?: 'ready' | 'files' | 'catalog';
  catalogAction?: 'install' | 'connect' | 'setup';
}

interface ComposerReferencePickerProps<T = unknown> {
  className?: string;
  locale?: string;
  emptyState: string;
  isLoading?: boolean;
  header: string;
  headerActions?: ReactNode;
  notice?: string | null;
  items: ComposerReferencePickerItem<T>[];
  onSelect: (item: ComposerReferencePickerItem<T>) => void;
  onConfigure?: (item: ComposerReferencePickerItem<T>) => void;
  canConfigure?: (item: ComposerReferencePickerItem<T>) => boolean;
  sourceStatuses?: readonly ChatReferenceSourceStatus[];
  onRetrySource?: (source: ChatReferenceSourceStatus['source']) => void;
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSearchValueChange?: (value: string) => void;
  searchAutoFocus?: boolean;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  searchPlaceholder?: string;
  searchValue?: string;
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
  locale = 'en',
  emptyState,
  isLoading = false,
  header,
  headerActions,
  notice,
  items,
  onSelect,
  onConfigure,
  canConfigure,
  sourceStatuses = [],
  onRetrySource,
  onSearchKeyDown,
  onSearchValueChange,
  searchAutoFocus = false,
  searchInputRef,
  searchPlaceholder,
  searchValue,
  selectedIndex,
}: ComposerReferencePickerProps<T>) {
  const copy = (de: string, en: string) => locale.startsWith('de') ? de : en;
  const showSearch = Boolean(onSearchValueChange);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedItemId = items[selectedIndex]?.id ?? null;

  useEffect(() => {
    itemRefs.current.length = items.length;
  }, [items.length]);

  useEffect(() => {
    const pickerElement = pickerRef.current;
    const selectedItem = itemRefs.current[selectedIndex];
    if (!pickerElement || !selectedItem) {
      return;
    }

    const itemTop = selectedItem.offsetTop;
    const itemBottom = itemTop + selectedItem.offsetHeight;
    const visibleTop = pickerElement.scrollTop;
    const visibleBottom = visibleTop + pickerElement.clientHeight;

    if (itemTop < visibleTop) {
      pickerElement.scrollTo({ top: itemTop });
      return;
    }

    if (itemBottom > visibleBottom) {
      pickerElement.scrollTo({ top: itemBottom - pickerElement.clientHeight });
    }
  }, [items.length, selectedIndex, selectedItemId]);

  return (
    <div
      ref={pickerRef}
      data-testid="chat-reference-picker"
      className={`absolute bottom-full left-0 z-50 mb-1 max-h-60 w-full overflow-y-auto border border-border bg-background shadow-lg ${className || ''}`}
    >
      <div className="border-b border-border p-2">
        <div className="text-xs text-muted-foreground">{header}</div>
        {headerActions}
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
      {items.map((item, index) => <Fragment key={item.id}>
        {item.section && item.section !== items[index - 1]?.section ? <div data-testid={`chat-reference-section-${item.section}`}
          className="border-t border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {item.section === 'ready' ? copy('Jetzt verfügbar', 'Available now') : item.section === 'files' ? copy('Dateien', 'Files') : copy('Weitere Angebote', 'More to discover')}
        </div> : null}
        <div className="flex items-center">
        <button
          ref={(element) => {
            itemRefs.current[index] = element;
          }}
          type="button"
          data-testid="chat-reference-item"
          data-reference-id={item.id}
          data-reference-kind={item.kind}
          data-reference-section={item.section}
          data-active={index === selectedIndex ? 'true' : 'false'}
          onClick={() => onSelect(item)}
          className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
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
          {item.catalogAction ? <span className="shrink-0 text-xs text-muted-foreground">
            {item.catalogAction === 'install' ? copy('Installieren', 'Install') : item.catalogAction === 'connect' ? copy('Verbinden', 'Connect') : copy('Einrichtung prüfen', 'Check setup')}
          </span> : null}
          {index === selectedIndex ? <span className="text-xs text-muted-foreground">↵</span> : null}
        </button>
        {onConfigure && (item.kind === 'plugin' || item.kind === 'skill') && (!canConfigure || canConfigure(item)) ? <button type="button" onClick={() => onConfigure(item)}
          className="shrink-0 px-2 py-2 text-xs text-muted-foreground hover:text-foreground" aria-label={`${copy('Anpassen', 'Customize')} ${item.label}`}>{copy('Anpassen', 'Customize')}</button> : null}
      </div></Fragment>)}
      {items.length === 0 ? (
        <div className="p-3 text-center text-sm text-muted-foreground">
          {isLoading || sourceStatuses.some(row => row.status === 'loading') ? copy('Wird geladen …', 'Loading…')
            : sourceStatuses.some(row => row.status === 'paused') ? copy('Weitere Treffer können geladen werden.', 'More results can be loaded.') : emptyState}
        </div>
      ) : null}
      {notice && items.length > 0 ? <p role="status" className="border-t px-3 py-2 text-xs text-muted-foreground">{notice}</p> : null}
      {sourceStatuses.map(row => row.status !== 'complete' ? <div role="status" key={row.source} className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>{row.source === 'local' ? copy('Lokale Quellen', 'Local sources') : row.source === 'connected' ? copy('Verbundene Integrationen', 'Connected integrations') : row.source === 'remote' ? copy('Weitere Angebote', 'More to discover') : copy('Dateien', 'Files')}: {row.status === 'loading' ? copy('Wird geladen …', 'Loading…') : row.status === 'paused' ? copy('Weitere Treffer vorhanden. Weiterladen oder Suche eingrenzen.', 'More results available. Continue loading or narrow your search.') : row.message ?? copy('Nicht verfügbar', 'Unavailable')}</span>
        {(row.status === 'unavailable' || row.status === 'paused') && onRetrySource ? <button type="button" className="shrink-0 underline" onClick={() => onRetrySource(row.source)}>{row.status === 'paused' ? copy('Weiterladen', 'Continue loading') : copy('Erneut versuchen', 'Try again')}</button> : null}
      </div> : null)}
    </div>
  );
}
