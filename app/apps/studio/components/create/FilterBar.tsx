'use client';

import { useState, useMemo } from 'react';
import { ArrowDownUp, CheckSquare, Download, Filter, SlidersHorizontal, Star, Trash2, X } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import type { StudioCreator } from '../../types/generation';
import type { OutputMediaFilter, OutputDateFilter, OutputSortOrder } from './OutputGrid';

const MEDIA_OPTIONS: { value: OutputMediaFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'sound', label: 'Sounds' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'generating', label: 'Generating' },
  { value: 'failed', label: 'Failed' },
];

const DATE_OPTIONS: { value: OutputDateFilter; label: string }[] = [
  { value: 'all', label: 'All dates' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'older', label: 'Older' },
];

interface FilterBarProps {
  mediaFilter: OutputMediaFilter;
  onMediaFilterChange: (value: OutputMediaFilter) => void;
  dateFilter: OutputDateFilter;
  onDateFilterChange: (value: OutputDateFilter) => void;
  sortOrder: OutputSortOrder;
  onSortOrderChange: (value: OutputSortOrder) => void;
  creatorFilter: string | null;
  onCreatorFilterChange: (value: string | null) => void;
  creators: StudioCreator[];
  selectionEnabled: boolean;
  onToggleSelection: () => void;
  selectedCount: number;
  onCancelSelection: () => void;
  onImportToWorkspace: () => void;
  onDeleteSelected?: () => void;
  onFavoriteSelected?: () => void;
  onDownloadSelected?: () => void;
}

function PillButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-sm transition whitespace-nowrap ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card/80 text-foreground hover:bg-accent'
      }`}
    >
      {children}
    </button>
  );
}

function FilterContent({
  mediaFilter,
  onMediaFilterChange,
  dateFilter,
  onDateFilterChange,
  creatorFilter,
  onCreatorFilterChange,
  creators,
}: {
  mediaFilter: OutputMediaFilter;
  onMediaFilterChange: (value: OutputMediaFilter) => void;
  dateFilter: OutputDateFilter;
  onDateFilterChange: (value: OutputDateFilter) => void;
  creatorFilter: string | null;
  onCreatorFilterChange: (value: string | null) => void;
  creators: StudioCreator[];
}) {
  const hasCreatorOptions = creators.length > 1 || creatorFilter !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {MEDIA_OPTIONS.map((opt) => (
          <PillButton
            key={opt.value}
            active={mediaFilter === opt.value}
            onClick={() => onMediaFilterChange(opt.value)}
          >
            {opt.label}
          </PillButton>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Date
        </span>
        {DATE_OPTIONS.map((opt) => (
          <PillButton
            key={opt.value}
            active={dateFilter === opt.value}
            onClick={() => onDateFilterChange(opt.value)}
          >
            {opt.label}
          </PillButton>
        ))}
      </div>

      {hasCreatorOptions ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Creator
          </span>
          <select
            value={creatorFilter ?? ''}
            onChange={(event) => onCreatorFilterChange(event.target.value || null)}
            className="h-9 rounded-full border border-border bg-card/80 px-3 text-sm text-foreground outline-none transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All creators</option>
            {creators.map((creator) => (
              <option key={creator.id} value={creator.id}>
                {creator.name || creator.email || creator.id}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

export function FilterBar({
  mediaFilter,
  onMediaFilterChange,
  dateFilter,
  onDateFilterChange,
  sortOrder,
  onSortOrderChange,
  creatorFilter,
  onCreatorFilterChange,
  creators,
  selectionEnabled,
  onToggleSelection,
  selectedCount,
  onCancelSelection,
  onImportToWorkspace,
  onDeleteSelected,
  onFavoriteSelected,
  onDownloadSelected,
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const activeCount = useMemo(() => {
    let count = 0;
    if (mediaFilter !== 'all') count++;
    if (dateFilter !== 'all') count++;
    if (creatorFilter !== null) count++;
    return count;
  }, [mediaFilter, dateFilter, creatorFilter]);

  const activeChips = useMemo(() => {
    const chips: { label: string; onRemove: () => void }[] = [];
    if (mediaFilter !== 'all') {
      const opt = MEDIA_OPTIONS.find((o) => o.value === mediaFilter);
      if (opt) chips.push({ label: opt.label, onRemove: () => onMediaFilterChange('all') });
    }
    if (dateFilter !== 'all') {
      const opt = DATE_OPTIONS.find((o) => o.value === dateFilter);
      if (opt) chips.push({ label: opt.label, onRemove: () => onDateFilterChange('all') });
    }
    if (creatorFilter !== null) {
      const creator = creators.find((item) => item.id === creatorFilter);
      chips.push({
        label: creator?.name || creator?.email || 'Creator',
        onRemove: () => onCreatorFilterChange(null),
      });
    }
    return chips;
  }, [mediaFilter, dateFilter, creatorFilter, creators, onMediaFilterChange, onDateFilterChange, onCreatorFilterChange]);

  return (
    <>
      {/* --- Desktop: Collapsible --- */}
      <div className="hidden md:sticky md:top-0 md:z-30 md:block border-b border-border/70 bg-background/90 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span>Filter</span>
                {activeCount > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 rounded-full px-1.5 text-xs">
                    {activeCount}
                  </Badge>
                )}
              </button>
            </CollapsibleTrigger>

            {activeChips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={chip.onRemove}
                className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary transition hover:bg-primary/20"
              >
                {chip.label}
                <X className="h-3 w-3" />
              </button>
            ))}

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => onSortOrderChange(sortOrder === 'newest' ? 'oldest' : 'newest')}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
              >
                <ArrowDownUp className="h-4 w-4" />
                {sortOrder === 'newest' ? 'Newest' : 'Oldest'}
              </button>
              <button
                type="button"
                onClick={onToggleSelection}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                  selectionEnabled
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card/80 text-foreground hover:bg-accent'
                }`}
              >
                <CheckSquare className="h-4 w-4" />
                Select
              </button>
            </div>
          </div>

          <CollapsibleContent>
            <div className="mt-3">
              <FilterContent
                mediaFilter={mediaFilter}
                onMediaFilterChange={(v) => { onMediaFilterChange(v); }}
                dateFilter={dateFilter}
                onDateFilterChange={(v) => { onDateFilterChange(v); }}
                creatorFilter={creatorFilter}
                onCreatorFilterChange={onCreatorFilterChange}
                creators={creators}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {selectionEnabled && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-2xl border border-border bg-card/80 px-3 py-2">
            <div className="text-sm font-medium">{selectedCount} selected</div>
            <div className="flex gap-2">
              {onDeleteSelected && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50 disabled:opacity-50"
                  onClick={onDeleteSelected}
                  disabled={selectedCount === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              )}
              {onFavoriteSelected && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                  onClick={onFavoriteSelected}
                  disabled={selectedCount === 0}
                >
                  <Star className="h-4 w-4" />
                  Favorite
                </button>
              )}
              {onDownloadSelected && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                  onClick={onDownloadSelected}
                  disabled={selectedCount === 0}
                >
                  <Download className="h-4 w-4" />
                  Download
                </button>
              )}
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent"
                onClick={onCancelSelection}
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
              <button
                type="button"
                className="rounded-full bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={onImportToWorkspace}
                disabled={selectedCount === 0}
              >
                Import to workspace
              </button>
            </div>
          </div>
        )}
      </div>

      {/* --- Mobile: Sheet --- */}
      <div className="md:sticky md:top-0 md:z-30 md:hidden border-b border-border/70 bg-background/90 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/80 px-2.5 py-1.5 text-sm text-foreground transition hover:bg-accent"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {activeCount > 0 && (
              <Badge variant="secondary" className="h-5 min-w-5 rounded-full px-1.5 text-xs">
                {activeCount}
              </Badge>
            )}
          </button>

          {activeChips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={chip.onRemove}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary transition hover:bg-primary/20"
            >
              {chip.label}
              <X className="h-3 w-3" />
            </button>
          ))}

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onSortOrderChange(sortOrder === 'newest' ? 'oldest' : 'newest')}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card/80 px-2 py-1.5 text-xs text-foreground transition hover:bg-accent"
            >
              <ArrowDownUp className="h-3.5 w-3.5" />
              {sortOrder === 'newest' ? 'New' : 'Old'}
            </button>
            <button
              type="button"
              onClick={onToggleSelection}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1.5 text-xs transition ${
                selectionEnabled
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card/80 text-foreground hover:bg-accent'
              }`}
            >
              <CheckSquare className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {selectionEnabled && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-2xl border border-border bg-card/80 px-3 py-2">
            <div className="text-sm font-medium">{selectedCount}</div>
            <div className="flex gap-1.5">
              {onDeleteSelected && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50 disabled:opacity-50"
                  onClick={onDeleteSelected}
                  disabled={selectedCount === 0}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              {onFavoriteSelected && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  onClick={onFavoriteSelected}
                  disabled={selectedCount === 0}
                >
                  <Star className="h-3.5 w-3.5" />
                </button>
              )}
              {onDownloadSelected && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  onClick={onDownloadSelected}
                  disabled={selectedCount === 0}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
                onClick={onCancelSelection}
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded-full bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={onImportToWorkspace}
                disabled={selectedCount === 0}
              >
                Import
              </button>
            </div>
          </div>
        )}
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={false}>
          <SheetHeader className="pb-2">
            <SheetTitle className="text-base">Filters</SheetTitle>
            <SheetDescription className="text-xs text-muted-foreground">
              Filter outputs by media type and date
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <FilterContent
              mediaFilter={mediaFilter}
              onMediaFilterChange={(v) => {
                onMediaFilterChange(v);
              }}
              dateFilter={dateFilter}
              onDateFilterChange={(v) => {
                onDateFilterChange(v);
              }}
              creatorFilter={creatorFilter}
              onCreatorFilterChange={onCreatorFilterChange}
              creators={creators}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
