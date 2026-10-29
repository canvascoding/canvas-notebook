'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { WorkspaceLinkReadIndex } from '@/app/lib/markdown/workspace-document-link-index-contract';
import { workspaceLinkIndexDiagnostics } from '@/app/lib/markdown/workspace-link-index-diagnostics';
import { cn } from '@/lib/utils';

const MAX_DETAILS = 8;

export function WorkspaceLinkIndexStatus({ index, className }: { index: WorkspaceLinkReadIndex; className?: string }) {
  const t = useTranslations('documentLinkIndex'), diagnostics = workspaceLinkIndexDiagnostics(index);
  const sourcePaths = [...new Set(diagnostics.sourceGaps.map(gap => gap.path).filter(Boolean))];
  const groups = [
    ...(!diagnostics.sourcesComplete ? [{ key: 'sources', label: t('incomplete'),
      details: sourcePaths.length ? sourcePaths : [t('workspaceSource')], warning: true }] : []),
    ...(diagnostics.metadataErrors.length ? [{ key: 'metadata', label: t('metadata', { count: diagnostics.metadataErrors.length }),
      details: diagnostics.metadataErrors, warning: false }] : []),
    ...(diagnostics.htmlSources.length ? [{ key: 'html', label: t('html', { count: diagnostics.htmlSources.length }),
      details: diagnostics.htmlSources, warning: false }] : []),
    ...(index.brokenLinks.length ? [{ key: 'targets', label: t('targets', { count: index.brokenLinks.length }),
      details: index.brokenLinks.map(link => `${link.sourcePath} → ${link.targetLiteral}`), warning: false }] : []),
  ];
  if (!groups.length) return null;
  return <div role="status" className={cn('grid min-w-0 gap-2 text-xs text-muted-foreground', className)}>
    {groups.map(group => <details key={group.key} className="min-w-0 rounded-lg border border-current/15 bg-muted/20 p-2.5">
      <summary className={cn('cursor-pointer break-words', group.warning && 'font-medium')}>
        {group.warning ? <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden="true" /> : null}
        {group.label}
      </summary>
      <ul className="mt-2 grid min-w-0 grid-cols-1 list-disc gap-1 pl-5">
        {group.details.slice(0, MAX_DETAILS).map((detail, index) => <li key={index} className="min-w-0 break-words">{detail}</li>)}
      </ul>
      {group.details.length > MAX_DETAILS ? <p className="mt-1">{t('more', { count: group.details.length - MAX_DETAILS })}</p> : null}
    </details>)}
  </div>;
}
