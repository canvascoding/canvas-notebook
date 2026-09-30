'use client';

import { ChevronLeft, ChevronRight, Eye, FileText, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useDocumentReviewAvailability } from '@/app/components/file-version-center/DocumentReviewAvailabilityProvider';

import {
  fileChangeAppStatusMessageKey,
  paginateFileChangeAppEntries,
  readFileChangeAppData,
  type FileChangeAppEntryData,
} from '@/app/lib/tool-apps/file-change-data';
import { FILE_VERSION_CENTER_CONTRACT_VERSION } from '@/app/lib/file-version-center/contracts/v1';
import { openVersionCenter } from '@/app/store/file-version-center-store';
import { Button } from '@/components/ui/button';
import { useOpenChatFileReference } from './useOpenChatFileReference';

function selectionFor(entry: FileChangeAppEntryData) {
  if (!entry.proposal && entry.state === 'applied') {
    return entry.revisionId ? { kind: 'revision' as const, id: entry.revisionId } : undefined;
  }
  if (entry.operationId) return { kind: 'agent_operation' as const, id: entry.operationId };
  if (entry.revisionId) return { kind: 'revision' as const, id: entry.revisionId };
  return undefined;
}

function needsReview(entry: FileChangeAppEntryData): boolean {
  return entry.proposal?.lifecycle === 'open' || entry.state === 'review_required' || entry.state === 'conflict';
}

function ProposalEntryActions({ entry, workspaceId }: { entry: FileChangeAppEntryData; workspaceId: string }) {
  const t = useTranslations('chat.toolApp');
  const proposal = entry.proposal;
  if (!proposal) return null;
  const openSuccessor = (operationId: string) => openVersionCenter({
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'lineage', workspaceId, lineageId: proposal.lineageId },
    selectedEntry: { kind: 'agent_operation', id: operationId },
    initialView: 'reviews',
    source: 'chat',
  });
  const successorOptions = proposal.successors.map((successor, index) => <Button
    key={successor.proposalId} type="button" size="xs" variant="outline"
    className="h-auto max-w-full whitespace-normal text-left" data-testid="file-change-successor-option"
    onClick={() => openSuccessor(successor.operationId)}>
    {t('fileChangeReviewSuccessor')} {index + 1} · {t(`fileChangeSuccessorRelation_${successor.relation}`)}
    {' · '}{t(`fileChangeProposalLifecycle_${successor.lifecycle}`)}
  </Button>);
  return <div className="min-w-0 space-y-1.5 text-xs text-muted-foreground" data-testid="file-change-proposal-entry">
    <p>{t(proposal.rootProposalId === proposal.proposalId ? 'fileChangeProposalRoot' : 'fileChangeProposalBranch')}
      {' · '}{t(fileChangeAppStatusMessageKey(entry.state, true))}
      {' · '}{t(`fileChangeProposalStatus_${proposal.status}`)}</p>
    {proposal.successors.length === 1 ? <div className="flex flex-wrap gap-1.5">{successorOptions}</div> : null}
    {proposal.successors.length > 1 ? <details className="rounded-md border px-2 py-1.5">
      <summary className="cursor-pointer font-medium text-foreground">
        {t('fileChangeChooseSuccessor', { count: proposal.successors.length })}
      </summary>
      <div className="mt-2 flex flex-wrap gap-1.5">{successorOptions}</div>
    </details> : null}
    {proposal.moreSuccessors ? <p>{t('fileChangeMoreSuccessors')}</p> : null}
  </div>;
}

export function FileChangeAppActions({ data: value, refresh }: { data: unknown; refresh: () => void }) {
  const t = useTranslations('chat.toolApp');
  const { documentReviewEnabled } = useDocumentReviewAvailability();
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
    initialView: entry.proposal || needsReview(entry) ? 'reviews' : 'history',
    source: 'chat',
  });
  const page = paginateFileChangeAppEntries(data.entries, requestedPage);
  return <div className="space-y-2 border-t px-3 py-3">
    <div className="flex flex-wrap gap-2">
      {documentReviewEnabled ? <Button size="xs" variant="outline" onClick={() => openEntry(preferred)}>
        <Eye className="mr-1.5 h-3.5 w-3.5" />{t('fileChangeReview')}
      </Button> : null}
      {data.entries.length === 1 ? <Button size="xs" variant="ghost" onClick={() => void openFile(preferred.pathHint)}>
        <FileText className="mr-1.5 h-3.5 w-3.5" />{t('fileChangeOpenFile')}
      </Button> : null}
      <Button size="xs" variant="ghost" onClick={refresh} aria-label={t('reload')}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('reload')}
      </Button>
    </div>
    {documentReviewEnabled && data.entries.length === 1 ? <ProposalEntryActions entry={preferred} workspaceId={data.workspaceId} /> : null}
    {data.entries.length > 1 ? <div className="flex flex-wrap gap-1" aria-label={t('fileChangeChooseFile')}>
      {page.entries.map((entry) => <div key={entry.id} className="min-w-0 space-y-1 rounded-md border border-border/70 p-1.5">
        <Button size="xs" variant="ghost" className="h-7 max-w-52 justify-start px-2 font-normal"
          title={entry.pathHint} onClick={() => documentReviewEnabled ? openEntry(entry) : void openFile(entry.pathHint)}>
          <span className="truncate">{entry.pathHint.split('/').at(-1) || entry.pathHint}</span>
        </Button>
        {documentReviewEnabled && entry.proposal ? <ProposalEntryActions entry={entry} workspaceId={data.workspaceId} /> : null}
      </div>)}
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
