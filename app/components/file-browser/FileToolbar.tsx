'use client';

import { ChevronsDownUp, CheckSquare, FilePlus, FolderPlus, FolderTree, LayoutGrid, List, MoreHorizontal, Trash2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useFileStore, type BrowserMode } from '@/app/store/file-store';

export interface FileToolbarHandlers {
  onToggleMultiSelect: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onDelete: () => void;
  onCollapseAll: () => void;
}

interface FileToolbarProps {
  variant: 'sidebar' | 'mobile-sheet' | 'fullscreen';
  isMultiSelectMode: boolean;
  isDeleteDisabled: boolean;
  handlers: FileToolbarHandlers;
}

const VIEW_MODES: { mode: BrowserMode; Icon: typeof LayoutGrid; labelKey: string }[] = [
  { mode: 'grid', Icon: LayoutGrid, labelKey: 'browserModeGrid' },
  { mode: 'list', Icon: List, labelKey: 'browserModeList' },
  { mode: 'tree', Icon: FolderTree, labelKey: 'browserModeTree' },
];

export function FileToolbar({ variant, isMultiSelectMode, isDeleteDisabled, handlers }: FileToolbarProps) {
  const t = useTranslations('notebook');
  const { browserMode, setBrowserMode } = useFileStore();

  const isMobileSheet = variant === 'mobile-sheet';
  const isFullscreen = variant === 'fullscreen';

  if (isMobileSheet) {
    return (
      <div className="flex items-center gap-1 px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handlers.onToggleMultiSelect}
          aria-label={t('toggleSelectMode')}
        >
          <CheckSquare className={cn('h-4 w-4', isMultiSelectMode && 'text-primary')} />
          {isMultiSelectMode ? t('multiSelectDone') : t('select')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handlers.onUpload}
          aria-label={t('upload')}
        >
          <Upload className="h-4 w-4" />
          {t('upload')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handlers.onDelete}
          disabled={isDeleteDisabled}
          aria-label={t('delete')}
        >
          <Trash2 className="h-4 w-4" />
          {t('delete')}
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('moreActions')}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={8} className="w-56">
            <DropdownMenuItem onSelect={handlers.onNewFile}>
              <FilePlus className="mr-2 h-4 w-4" />
              {t('newFile')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handlers.onNewFolder}>
              <FolderPlus className="mr-2 h-4 w-4" />
              {t('newFolder')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {VIEW_MODES.map(({ mode, Icon, labelKey }) => (
              <DropdownMenuItem
                key={mode}
                onSelect={() => setBrowserMode(mode)}
                className={browserMode === mode ? 'font-semibold' : ''}
              >
                <Icon className="mr-2 h-4 w-4" />
                {t(labelKey)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handlers.onCollapseAll}>
              <ChevronsDownUp className="mr-2 h-4 w-4" />
              {t('collapseAllFolders')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  if (isFullscreen) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handlers.onToggleMultiSelect}
          aria-label={t('toggleSelectMode')}
        >
          <CheckSquare className={cn('h-4 w-4', isMultiSelectMode && 'text-primary')} />
          <span className="hidden sm:inline">{isMultiSelectMode ? t('multiSelectDone') : t('select')}</span>
        </Button>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={handlers.onNewFile} aria-label={t('newFile')}>
          <FilePlus className="h-4 w-4" />
          <span className="hidden sm:inline">{t('newFile')}</span>
        </Button>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={handlers.onNewFolder} aria-label={t('newFolder')}>
          <FolderPlus className="h-4 w-4" />
          <span className="hidden sm:inline">{t('newFolder')}</span>
        </Button>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={handlers.onUpload} aria-label={t('upload')}>
          <Upload className="h-4 w-4" />
          <span className="hidden sm:inline">{t('upload')}</span>
        </Button>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={handlers.onDelete} disabled={isDeleteDisabled} aria-label={t('delete')}>
          <Trash2 className="h-4 w-4" />
          <span className="hidden sm:inline">{t('delete')}</span>
        </Button>

        <div className="hidden h-5 w-px bg-border sm:block" />

        <div className="flex items-center rounded-md border border-border p-0.5">
          {VIEW_MODES.map(({ mode, Icon, labelKey }) => (
            <Button
              key={mode}
              variant={browserMode === mode ? 'secondary' : 'ghost'}
              size="icon-sm"
              className="h-7 w-7 rounded-sm"
              onClick={() => setBrowserMode(mode)}
              aria-label={t(labelKey)}
            >
              <Icon className="h-3.5 w-3.5" />
            </Button>
          ))}
        </div>

        {browserMode === 'tree' && (
          <Button variant="ghost" size="icon-sm" onClick={handlers.onCollapseAll} aria-label={t('collapseAllFolders')}>
            <ChevronsDownUp className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  }

  // sidebar variant
  return (
    <div className="flex items-center gap-x-2 px-3 py-2">
      <h2 className="shrink-0 text-sm font-semibold text-foreground">{t('filesTitle')}</h2>
      <TooltipProvider delayDuration={300}>
        <div className="flex min-w-0 flex-1 items-center justify-start gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handlers.onToggleMultiSelect} aria-label={t('toggleSelectMode')}>
                <CheckSquare className={cn('h-4 w-4', isMultiSelectMode && 'text-primary')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('select')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handlers.onNewFile} aria-label={t('newFile')}>
                <FilePlus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('newFile')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handlers.onNewFolder} aria-label={t('newFolder')}>
                <FolderPlus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('newFolder')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handlers.onUpload} aria-label={t('upload')}>
                <Upload className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('upload')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handlers.onDelete} disabled={isDeleteDisabled} aria-label={t('delete')}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('delete')}</TooltipContent>
          </Tooltip>

          <div className="hidden h-5 w-px bg-border sm:block" />

          <div className="flex items-center rounded-md border border-border p-0.5">
            {VIEW_MODES.map(({ mode, Icon, labelKey }) => (
              <Button
                key={mode}
                variant={browserMode === mode ? 'secondary' : 'ghost'}
                size="icon-sm"
                className="h-6 w-6 rounded-sm"
                onClick={() => setBrowserMode(mode)}
                aria-label={t(labelKey)}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            ))}
          </div>

          {browserMode === 'tree' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={handlers.onCollapseAll} aria-label={t('collapseAllFolders')}>
                  <ChevronsDownUp className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('collapseAll')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}