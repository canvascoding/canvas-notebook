'use client';

import { ChevronLeft, ChevronRight, Eye, FileText, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  paginateFileChangeAppEntries,
  readFileChangeAppData,
  type FileChangeAppEntryData,
} from '@/app/lib/tool-apps/file-change-data';
import { FILE_VERSION_CENTER_CONTRACT_VERSION } from '@/app/lib/file-version-center/contracts/v1';
import { openVersionCenter } from '@/app/store/file-version-center-store';
import { Button } from '@/components/ui/button';
import { useOpenChatFileReference } from './useOpenChatFileReference';

function selectionFor(entry: FileChangeAppEntryData) {
  if (entry.operationId) return { kind: 'agent_operation' as const, id: entry.operationId };
  if (entry.revisionId) return { kind: 'revision' as const, id: entry.revisionId };
  return undefined;
}

function needsReview(entry: FileChangeAppEntryData): boolean {
  return entry.state === 'review_required' || entry.state === 'conflict';
}

export function FileChangeAppActions({ data: value, refresh }: { data: unknown; refresh: () => void }) {
  const t = useTranslations('chat.toolApp');
  const [requestedPage, setRequestedPage] = useState(0);
  const openFile = useOpenChatFileReference();
  const data = readFileChangeAppData(value);
  if (!data) return null;
  const preferred = data.entries.find(needsReview) ?? data.entries[0]!;
  const openEntry = (entry: FileChangeAppEntryData) => openVersionCenter({
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: {
      kind: 'change_group',
      workspaceId: data.workspaceId,
      changeGroupId: data.id,
      entryId: entry.id,
    },
    selectedEntry: selectionFor(entry),
    initialView: needsReview(entry) ? 'reviews' : 'history',
    source: 'chat',
  });
  const page = paginateFileChangeAppEntries(data.entries, requestedPage);
  return <div className="space-y-2 border-t px-3 py-3">
    <div className="flex flex-wrap gap-2">
      <Button size="xs" variant="outline" onClick={() => openEntry(preferred)}>
        <Eye className="mr-1.5 h-3.5 w-3.5" />{t('fileChangeReview')}
      </Button>
      {data.entries.length === 1 ? <Button size="xs" variant="ghost" onClick={() => void openFile(preferred.pathHint)}>
        <FileText className="mr-1.5 h-3.5 w-3.5" />{t('fileChangeOpenFile')}
      </Button> : null}
      <Button size="xs" variant="ghost" onClick={refresh} aria-label={t('reload')}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('reload')}
      </Button>
    </div>
    {data.entries.length > 1 ? <div className="flex flex-wrap gap-1" aria-label={t('fileChangeChooseFile')}>
      {page.entries.map((entry) => <Button key={entry.id} size="xs" variant="ghost"
        className="h-7 max-w-52 justify-start px-2 font-normal" title={entry.pathHint}
        onClick={() => openEntry(entry)}>
        <span className="truncate">{entry.pathHint.split('/').at(-1) || entry.pathHint}</span>
      </Button>)}
      {page.pageCount > 1 ? <span className="flex items-center gap-0.5 self-center text-[11px] text-muted-foreground">
        <Button size="icon-xs" variant="ghost" aria-label={t('fileChangePrevious')}
          disabled={page.pageIndex === 0} onClick={() => setRequestedPage(page.pageIndex - 1)}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        {t('fileChangePage', { page: page.pageIndex + 1, pages: page.pageCount })}
        <Button size="icon-xs" variant="ghost" aria-label={t('fileChangeNext')}
          disabled={page.pageIndex === page.pageCount - 1} onClick={() => setRequestedPage(page.pageIndex + 1)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </span> : null}
    </div> : null}
  </div>;
}
