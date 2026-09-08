'use client';

import { useRef, useState } from 'react';
import { Check, FileText, List, LoaderCircle, Undo2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function NotebookDocumentMenu({ paths, activePath, canReopen, onSelect, onReopen, onCloseAll }: {
  paths: string[];
  activePath: string | null;
  canReopen: boolean;
  onSelect: (path: string) => void;
  onReopen: () => void;
  onCloseAll: () => Promise<boolean>;
}) {
  const t = useTranslations('notebook');
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeAll = async () => {
    if (closingRef.current || paths.length === 0) return;
    closingRef.current = true;
    setClosing(true);
    try {
      if (await onCloseAll()) setOpen(false);
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1.5 px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          data-testid="notebook-documents-menu" aria-label={t('openDocumentsCount', { count: paths.length })} title={t('openDocuments')}>
          <List className="h-4 w-4" />
          <span className="text-xs tabular-nums text-muted-foreground">{paths.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-1">
          <DropdownMenuLabel>{t('openDocuments')} <span className="tabular-nums text-muted-foreground">· {paths.length}</span></DropdownMenuLabel>
          <DropdownMenuItem asChild variant="destructive" disabled={closing || paths.length === 0}
            onSelect={(event) => { event.preventDefault(); void closeAll(); }}>
            <button type="button" disabled={closing || paths.length === 0}
              data-testid="notebook-close-all-documents" aria-label={t('closeAllDocuments')}
              aria-busy={closing}
              className="ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:min-h-11">
              {closing ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
              <span aria-live="polite">{closing ? t('closingDocuments') : t('closeAll')}</span>
            </button>
          </DropdownMenuItem>
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <div className="min-h-0 max-h-72 overflow-y-auto">
          {paths.map((path) => (
            <DropdownMenuItem key={path} disabled={closing} onSelect={() => onSelect(path)} title={path}>
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{path.split('/').pop()}</span>
                <span className="block truncate text-xs text-muted-foreground">{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : t('workspaceRoot')}</span>
              </span>
              {path === activePath ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
            </DropdownMenuItem>
          ))}
          {paths.length === 0 ? <p className="px-2 py-3 text-xs text-muted-foreground">{t('noOpenDocuments')}</p> : null}
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <DropdownMenuItem className="shrink-0" disabled={!canReopen || closing} onSelect={onReopen}>
          <Undo2 className="h-4 w-4" />{t('reopenClosedDocument')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
