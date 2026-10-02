'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { WorkspaceOperationBatchPublic } from '@/app/lib/files/workspace-operation-batch-public';

export function WorkspaceOperationBatchDetails({ batch, onOpenDocument }: {
  batch: WorkspaceOperationBatchPublic; onOpenDocument?: (path: string, workspaceId: string) => void;
}) {
  const t = useTranslations('workspaceOperationReview');
  const preview = batch.preview;
  const running = batch.status === 'queued' || batch.status === 'applying';
  const applied = batch.status === 'applied' || batch.status === 'undone';
  const affected = new Map<string, 'file' | 'directory'>();
  for (const mapping of preview.pathMappings) affected.set(mapping.sourceIdentity, mapping.sourceKind);
  for (const entry of preview.deletedPaths) affected.set(entry.identity, entry.kind);
  const fileCount = [...affected.values()].filter((kind) => kind === 'file').length;
  const folderCount = affected.size - fileCount;
  const linksBySource = new Map<string, typeof preview.linkEdits>();
  for (const edit of preview.linkEdits) {
    const edits = linksBySource.get(edit.sourcePathBefore) ?? [];
    edits.push(edit);
    linksBySource.set(edit.sourcePathBefore, edits);
  }
  const changedReviews = preview.changedReviews ?? [];
  const pendingIssues = preview.issues.filter((issue) => /pending|unaccepted/iu.test(issue.code));
  const ordinaryIssues = preview.issues.filter((issue) => !pendingIssues.includes(issue) && issue.code !== 'incomplete-index');
  const changes = <div className="space-y-5">
    <section aria-label={t('pathChanges')} data-testid="workspace-operation-batch-paths">
      <h3 className="mb-2 text-sm font-semibold">{t('pathChanges')}</h3>
      <div className="space-y-2">
        {preview.actions.flatMap((action) => action.selections.map((selection) => {
          const children = [
            ...preview.pathMappings.filter((mapping) => mapping.sourcePath.startsWith(`${selection.sourcePath}/`))
              .map((mapping) => ({ path: mapping.sourcePath, destination: mapping.destinationPath })),
            ...preview.deletedPaths.filter((entry) => entry.path.startsWith(`${selection.sourcePath}/`))
              .map((entry) => ({ path: entry.path, destination: '' })),
          ];
          return <div key={`${action.reviewId}:${selection.sourcePath}`} className="min-w-0 rounded-lg border p-3">
            <p className="mb-1 text-xs font-semibold text-muted-foreground">{t(`kind_${action.kind}`)}</p>
            <p className="break-all font-mono text-sm">{selection.sourcePath}{selection.destinationPath ? ` → ${selection.destinationPath}` : ''}</p>
            {children.length > 0 ? <details className="mt-2" data-testid="workspace-operation-path-children">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('containedPaths', { count: children.length })}</summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto border-l pl-3 font-mono text-xs">
                {children.map((entry, index) => <li key={`${entry.path}:${index}`} className="break-all">{entry.path}{entry.destination ? ` → ${entry.destination}` : ''}</li>)}
              </ul>
            </details> : null}
          </div>;
        }))}
      </div>
    </section>

    {preview.linkAssessment.restoredLinks?.length ? <section className="space-y-2 rounded-lg border border-emerald-500/35 bg-emerald-500/[0.05] p-3 text-sm"
      data-testid="workspace-operation-restored-links">
      <h3 className="font-semibold">{t('restoredLinks', { count: preview.linkAssessment.restoredLinks.length })}</h3>
      <ul className="space-y-2 text-xs">{preview.linkAssessment.restoredLinks.map((link, index) => <li key={`${link.sourcePath}:${index}`} className="break-all">
        <p className="font-mono">{link.sourcePathAfter ?? link.sourcePath}</p>
        <p>{link.targetLiteral} → {link.targetPath}</p>
      </li>)}</ul>
    </section> : null}
    <section aria-label={t('linkChanges')} data-testid="workspace-operation-batch-links">
      <h3 className="mb-2 text-sm font-semibold">{t('linkChanges')} ({preview.linkEdits.length})</h3>
      {linksBySource.size > 0 ? <div className="space-y-3">
        {Array.from(linksBySource, ([sourcePath, edits]) => <div key={sourcePath} className="min-w-0 overflow-hidden rounded-lg border text-xs">
          <p className="break-all bg-muted/35 px-3 py-2 font-mono font-semibold">{sourcePath}
            {edits[0].sourcePathAfter !== sourcePath ? ` → ${edits[0].sourcePathAfter}` : ''}</p>
          <div className="divide-y">
            {edits.map((edit, index) => <div key={`${edit.targetRange.startUtf16}:${index}`} className="space-y-2 px-3 py-3">
              <p className="break-all font-mono text-destructive"><span className="font-sans text-muted-foreground">{t('before')}: </span>{edit.previousTargetLiteral}</p>
              <p className="break-all font-mono text-emerald-800 dark:text-emerald-200"><span className="font-sans text-muted-foreground">{t('after')}: </span>
                {edit.changeKind === 'unlink' ? t('linkRemoved') : edit.nextTargetLiteral}</p>
              <details>
                <summary className="cursor-pointer text-muted-foreground">{t('linkContext')}</summary>
                <div className="mt-2 space-y-2">
                  <pre className="whitespace-pre-wrap break-all rounded bg-destructive/[0.05] p-2 font-mono">{edit.snippet.before}</pre>
                  <pre className="whitespace-pre-wrap break-all rounded bg-emerald-500/[0.05] p-2 font-mono">{edit.snippet.after}</pre>
                </div>
              </details>
            </div>)}
          </div>
        </div>)}
      </div> : <p className="text-sm text-muted-foreground">{t('noLinkChanges')}</p>}
    </section>
  </div>;

  return <div className="space-y-5 px-4 py-4 sm:px-6" data-testid="workspace-operation-batch-details">
    <section className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm" data-testid="workspace-operation-batch-status" role="status" aria-live="polite">
      <h2 className="font-semibold">{t(`batchStatus_${batch.status}`)}</h2>
      {applied ? <p data-testid="workspace-operation-batch-receipt">{t(batch.status === 'undone' ? 'batchUndoneSummary' : 'batchAppliedSummary', {
        files: fileCount, folders: folderCount, links: preview.linkEdits.length,
      })}</p> : <p>{t('batchScopeSummary', { actions: preview.actions.length, files: fileCount, folders: folderCount, links: preview.linkEdits.length })}</p>}
      {running ? <>
        <p>{t('batchProgress', { completed: batch.completedActions, total: batch.totalActions })} · {t(`batchPhase_${batch.phase}`)}</p>
        <progress className="h-2 w-full" aria-label={t('batchProgressLabel')} max={Math.max(1, batch.totalActions)} value={batch.completedActions} />
        <p className="text-xs text-muted-foreground">{t('batchContinuesAfterClose')}</p>
      </> : null}
      {batch.status === 'needs_review' ? <p>{t('batchNeedsReviewHelp')}</p> : null}
      {batch.status === 'needs_recovery' ? <p>{t('batchNeedsRecoveryHelp')}</p> : null}
      {batch.status === 'failed' ? <p>{t('batchFailedHelp')}</p> : null}
    </section>

    {changedReviews.length > 0 && !running && !applied ? <section className="space-y-2 rounded-lg border border-amber-500/35 p-3 text-sm"
      data-testid="workspace-operation-batch-changes">
      <h3 className="font-semibold">{t('changedSincePreview')}</h3>
      <p className="text-xs text-muted-foreground">{t('changedSincePreviewHelp')}</p>
      <ul className="space-y-1 text-xs">{changedReviews.map((change) => <li key={change.reviewId} className="break-words">{change.detail}</li>)}</ul>
    </section> : null}

    {pendingIssues.length > 0 ? <section className="rounded-lg border border-amber-500/35 p-3 text-sm" data-testid="workspace-operation-pending-changes">
      <h3 className="font-semibold">{t('pendingChanges')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('pendingChangesHelp')}</p>
      <ul className="mt-2 space-y-1 text-xs">{pendingIssues.map((issue, index) => <li key={`${issue.path}:${index}`} className="break-all">{issue.path}: {issue.detail}</li>)}</ul>
    </section> : null}

    {preview.linkAssessment.blockers.length > 0 && !applied ? <section data-testid="workspace-operation-link-blockers" aria-label={t('linkBlockers')}>
      <h3 className="mb-2 text-sm font-semibold">{t('linkBlockers')}</h3>
      <ul className="max-h-48 space-y-3 overflow-y-auto rounded-lg border border-destructive/30 p-3 text-xs">
        {preview.linkAssessment.blockers.map((item, index) => <li key={`${item.sourcePath}:${index}`} className="space-y-1">
          <p className="break-all font-mono">{item.sourcePath}{item.targetLiteral ? ` → ${item.targetLiteral}` : ''}</p>
          <p className="text-muted-foreground">{t(`linkBlocker_${item.reason}`)}</p>
          {onOpenDocument ? <Button size="sm" variant="outline" data-testid={`workspace-operation-blocker-open-${index}`}
            onClick={() => onOpenDocument(item.sourcePath, item.workspaceId ?? batch.workspaceId)}>{t('openDocument')}</Button> : null}
        </li>)}
      </ul>
    </section> : null}
    {ordinaryIssues.length > 0 && !applied ? <section className="space-y-2 rounded-lg border border-destructive/30 p-3 text-xs" aria-label={t('issues')}>
      <h3 className="font-semibold">{t('issues')}</h3>
      <ul className="space-y-1">{ordinaryIssues.map((issue, index) => <li key={`${issue.code}:${index}`} className="break-words">{issue.path ? `${issue.path}: ` : ''}{issue.detail}</li>)}</ul>
    </section> : null}

    {applied ? <details><summary className="cursor-pointer text-sm text-muted-foreground">{t('completedChanges')}</summary><div className="mt-3">{changes}</div></details> : changes}

    <details className="space-y-3 rounded-lg border p-3" data-testid="workspace-operation-technical-details">
      <summary className="cursor-pointer text-sm text-muted-foreground">{t('technicalDetails')}</summary>
      <dl className="space-y-2 text-xs">
        <div><dt>{t('planId')}</dt><dd className="break-all font-mono" data-testid="workspace-operation-plan-id">{batch.planId}</dd></div>
        <div><dt>{t('batchId')}</dt><dd className="break-all font-mono">{batch.batchId}</dd></div>
        {batch.errorCode ? <div><dt>{t('errorCode')}</dt><dd className="break-all font-mono">{batch.errorCode}</dd></div> : null}
      </dl>
      {preview.linkAssessment.warnings.length > 0 ? <details data-testid="workspace-operation-link-warnings">
        <summary className="cursor-pointer text-xs">{t('linkWarnings')} ({preview.linkAssessment.warnings.length})</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t('linkWarningsHelp')}</p>
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-xs">
          {preview.linkAssessment.warnings.map((item, index) => <li key={`${item.sourcePath}:${index}`} className="break-all">{item.sourcePath}: {item.targetLiteral} ({item.status})</li>)}
        </ul>
      </details> : null}
      <details data-testid="workspace-operation-link-coverage">
        <summary className="cursor-pointer text-xs">{t('coverage')}: {t(preview.coverage.complete ? 'coverageComplete' : 'coverageIncomplete')}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t('globalCoverageHelp')}</p>
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-xs">
          {preview.coverage.omittedSources.map((item, index) => <li key={`omitted:${index}`} className="break-all">{item.path}: {item.reason}</li>)}
          {preview.coverage.unresolvedLinks.map((item, index) => <li key={`unresolved:${index}`} className="break-all">{item.sourcePath}: {item.targetLiteral} ({item.status})</li>)}
        </ul>
      </details>
      <ul className="space-y-1 font-mono text-xs">{preview.issues.map((issue, index) => <li key={`${issue.code}:${index}`} className="break-all">{issue.code}: {issue.path} · {issue.detail}</li>)}</ul>
    </details>
  </div>;
}
