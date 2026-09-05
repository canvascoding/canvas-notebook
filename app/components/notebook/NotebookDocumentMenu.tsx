'use client';

import { Check, FileText, List, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function NotebookDocumentMenu({ paths, activePath, canReopen, onSelect, onReopen }: {
  paths: string[];
  activePath: string | null;
  canReopen: boolean;
  onSelect: (path: string) => void;
  onReopen: () => void;
}) {
  const t = useTranslations('notebook');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1.5 px-2"
          data-testid="notebook-documents-menu" aria-label={t('openDocuments')} title={t('openDocuments')}>
          <List className="h-4 w-4" />
          <span className="text-xs tabular-nums text-muted-foreground">{paths.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{t('openDocuments')}</DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {paths.map((path) => (
            <DropdownMenuItem key={path} onSelect={() => onSelect(path)} title={path}>
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
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canReopen} onSelect={onReopen}>
          <Undo2 className="h-4 w-4" />{t('reopenClosedDocument')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
