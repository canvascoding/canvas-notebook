'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, PackagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { WorkflowCheckbox as Checkbox } from './WorkflowCheckbox';
import type { AgentWorkflowPackageConfiguration } from '@/app/lib/agents/workflow-contracts';
import type { CapabilityPackagePublishedSummary } from '@/app/lib/capabilities/packages/contracts';
import type { AgentWorkflowManagementHeader, AgentWorkflowManagementPackageVersion } from '@/app/lib/agents/workflow-management-contracts';
import { readAgentWorkflowPackageVersions, type AgentWorkflowManagementContext } from './agent-workflow-management-client';
import type { AgentWorkflowManagementDraft, WorkflowDraftPackage } from './agent-workflow-management-draft';
import { useWorkflowManagementOptions, workflowManagementReadError } from './use-workflow-management-options';

const selectClass = 'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
function PackageRow({ context, header, pkg, version, disabled, onCacheVersion, onApplyVersion, onRemove, onAuthorityError }: {
  context: AgentWorkflowManagementContext; header: AgentWorkflowManagementHeader; pkg: WorkflowDraftPackage;
  version?: AgentWorkflowManagementPackageVersion; disabled: boolean;
  onCacheVersion: (version: AgentWorkflowManagementPackageVersion) => void;
  onApplyVersion: (version: AgentWorkflowManagementPackageVersion, selection: AgentWorkflowPackageConfiguration['skillSelection']) => void;
  onRemove: () => void; onAuthorityError: (error: 'conflict' | 'denied') => void;
}) {
  const t = useTranslations('agentWorkflowManagement');
  const [open, setOpen] = useState(false), [versions, setVersions] = useState<CapabilityPackagePublishedSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false), [versionsError, setVersionsError] = useState(false);
  const [nextVersion, setNextVersion] = useState('');
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const read = useWorkflowManagementOptions(context, onAuthorityError);
  useEffect(() => () => { generation.current += 1; controller.current?.abort(); }, []);
  const metadata = version && version.publishedRevisionRef === pkg.publishedRevisionRef && version.checksum === pkg.checksum ? version : undefined;
  const readVersion = async (ref: string, apply = false) => {
    const result = await read.run({ view: 'package-version', agentId: header.agentId, expectedRevision: header.revision,
      expectedWorkflowRevision: header.workflowRevision, resourceRef: pkg.resourceRef, publishedRevisionRef: ref });
    if (result?.view !== 'package-version') return;
    if (apply) {
      const selection: AgentWorkflowPackageConfiguration['skillSelection'] = pkg.skillSelection.kind === 'plugin' && result.kind === 'plugin'
        ? { kind: 'plugin' } : { kind: 'skills', relativeRoots: pkg.skillSelection.kind === 'skills'
          && pkg.skillSelection.relativeRoots.every(root => result.skillRoots.some(skill => skill.relativeRoot === root))
          ? [...pkg.skillSelection.relativeRoots] : [] };
      onApplyVersion(result, selection);
    } else onCacheVersion(result);
  };
  const loadVersions = async () => {
    controller.current?.abort(); const current = new AbortController(), id = ++generation.current;
    controller.current = current; setVersionsLoading(true); setVersionsError(false);
    try {
      const result = await readAgentWorkflowPackageVersions(context, pkg.resourceRef, current.signal);
      if (!current.signal.aborted && generation.current === id) setVersions(result);
    } catch (error) {
      if (!current.signal.aborted && generation.current === id) {
        setVersionsError(true); const kind = workflowManagementReadError(error); if (kind !== 'load') onAuthorityError(kind);
      }
    } finally { if (!current.signal.aborted && generation.current === id) setVersionsLoading(false); }
  };
  return <section className="min-w-0 rounded-xl border" data-testid="workflow-management-package">
    <div className="flex items-center gap-2 px-3 py-3 sm:px-4">
      <button type="button" className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open} disabled={disabled || read.loading} onClick={() => { const next = !open; setOpen(next); if (next && !metadata) void readVersion(pkg.publishedRevisionRef); }}>
        <span className="min-w-0"><span className="block truncate text-sm font-semibold">{metadata?.name ?? t('packages.configured')}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{metadata ? t('packages.version', { version: metadata.version }) : t('packages.pinned')}
            {' · '}{pkg.skillSelection.kind === 'plugin' ? t('packages.wholePlugin') : t('packages.skillsCount', { count: pkg.skillSelection.relativeRoots.length })}</span></span>
        <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <Button type="button" size="icon" variant="ghost" aria-label={t('packages.remove')} disabled={disabled} onClick={onRemove}><Trash2 className="size-3.5" /></Button>
    </div>
    {open ? <div className="space-y-4 border-t p-3 sm:p-4">
      {read.loading ? <p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" />{t('loading')}</p> : null}
      {read.error ? <div role="alert" className="space-y-2 text-xs"><p>{t(`errors.${read.error}`)}</p><Button type="button" size="sm" variant="outline" disabled={disabled || read.loading} onClick={() => void readVersion(pkg.publishedRevisionRef)}>{t('retry')}</Button></div> : null}
      {metadata ? <>
        {metadata.kind === 'plugin' ? <label className="block space-y-1.5 text-xs font-medium"><span>{t('packages.selection')}</span>
          <select className={selectClass} aria-label={t('packages.selection')} value={pkg.skillSelection.kind} disabled={disabled}
            onChange={event => onApplyVersion(metadata, event.target.value === 'plugin' ? { kind: 'plugin' }
              : { kind: 'skills', relativeRoots: metadata.skillRoots.map(skill => skill.relativeRoot) })}>
            <option value="plugin">{t('packages.wholePlugin')}</option><option value="skills">{t('packages.selectedSkills')}</option>
          </select>
        </label> : null}
        {pkg.skillSelection.kind === 'skills' ? <div className="space-y-2"><p className="text-xs font-medium">{t('packages.selectedSkills')}</p>
          {metadata.skillRoots.map(skill => {
            const roots = pkg.skillSelection.kind === 'skills' ? pkg.skillSelection.relativeRoots : [];
            return <label key={skill.relativeRoot} className="flex items-center gap-2 text-sm"><Checkbox checked={roots.includes(skill.relativeRoot)} disabled={disabled}
              aria-label={t('packages.skill', { name: skill.name })} onCheckedChange={value => onApplyVersion(metadata, { kind: 'skills',
                relativeRoots: value === true ? [...roots, skill.relativeRoot] : roots.filter(root => root !== skill.relativeRoot) })} /><span className="break-words">{skill.name}</span></label>;
          })}
          {!pkg.skillSelection.relativeRoots.length ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('packages.chooseSkill')}</p> : null}
        </div> : null}
        <div className="space-y-2 border-t pt-3">
          <Button type="button" size="sm" variant="outline" disabled={disabled || versionsLoading} onClick={() => void loadVersions()}>
            {versionsLoading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{t('packages.versions')}</Button>
          {versionsError ? <p role="alert" className="text-xs">{t('errors.load')}</p> : null}
          {versions.length ? <>
            <label className="block space-y-1.5 text-xs font-medium"><span>{t('packages.publishedVersion')}</span>
              <select className={selectClass} aria-label={t('packages.publishedVersion')} value={nextVersion} disabled={disabled || read.loading} onChange={event => setNextVersion(event.target.value)}>
                <option value="">{t('packages.chooseVersion')}</option>{versions.map(value => <option key={value.revisionRef} value={value.revisionRef}>{value.version}{value.revisionRef === pkg.publishedRevisionRef ? ` · ${t('packages.currentPin')}` : ''}</option>)}
              </select>
            </label>
            {nextVersion && nextVersion !== pkg.publishedRevisionRef ? <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('packages.versionChangeHint')}</p>
              <Button type="button" size="sm" disabled={disabled || read.loading} onClick={() => void readVersion(nextVersion, true)}>{t('packages.useVersion')}</Button></div> : null}
          </> : null}
        </div>
      </> : null}
    </div> : null}
  </section>;
}

export function WorkflowPackageSelectionSection({ draft, context, disabled, onCacheVersion, onApplyVersion, onRemove, onAuthorityError }: {
  draft: AgentWorkflowManagementDraft; context: AgentWorkflowManagementContext; disabled: boolean;
  onCacheVersion: (version: AgentWorkflowManagementPackageVersion) => void;
  onApplyVersion: (version: AgentWorkflowManagementPackageVersion, selection: AgentWorkflowPackageConfiguration['skillSelection']) => void;
  onRemove: (ref: string) => void; onAuthorityError: (error: 'conflict' | 'denied') => void;
}) {
  const t = useTranslations('agentWorkflowManagement'), [libraryOpen, setLibraryOpen] = useState(false), [q, setQ] = useState('');
  const [versionRef, setVersionRef] = useState<Record<string, string>>({});
  const read = useWorkflowManagementOptions(context, onAuthorityError), header = draft.base;
  const load = (page = 1) => read.run({ view: 'packages', agentId: header.agentId, expectedRevision: header.revision,
    expectedWorkflowRevision: header.workflowRevision, q, page, limit: 20 });
  const packages = read.result?.view === 'packages' ? read.result.packages : [];
  return <div className="min-w-0 space-y-3" data-testid="workflow-management-packages">
    {draft.packages.map(pkg => <PackageRow key={`${pkg.resourceRef}:${pkg.publishedRevisionRef}:${pkg.checksum}`} context={context} header={header} pkg={pkg}
      version={draft.packageVersions[pkg.resourceRef]} disabled={disabled} onCacheVersion={onCacheVersion} onApplyVersion={onApplyVersion}
      onRemove={() => onRemove(pkg.resourceRef)} onAuthorityError={onAuthorityError} />)}
    {!draft.packages.length ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('packages.empty')}</p> : null}
    <Button type="button" variant="outline" disabled={disabled || read.loading || draft.packages.length >= 32} onClick={() => { setLibraryOpen(true); void load(); }}><PackagePlus className="size-4" />{t('packages.add')}</Button>
    {libraryOpen ? <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void load(); }}>
        <input className={selectClass} aria-label={t('packages.search')} value={q} maxLength={512} disabled={disabled || read.loading} onChange={event => setQ(event.target.value)} />
        <Button type="submit" variant="outline" disabled={disabled || read.loading}>{t('search')}</Button>
      </form>
      {read.loading ? <p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" />{t('loading')}</p> : null}
      {read.error ? <p role="alert" className="text-xs">{t(`errors.${read.error}`)}</p> : null}
      {!read.loading && !read.error && !packages.length ? <p className="text-xs text-muted-foreground">{t('packages.noOptions')}</p> : null}
      {packages.map(pkg => <div key={pkg.resourceRef} className="min-w-0 space-y-2 rounded-lg border bg-background p-3">
        <p className="break-words text-sm font-medium">{pkg.displayName}</p><p className="text-xs text-muted-foreground">{t(`scope.${pkg.scopeLabel}`)}</p>
        <label className="block space-y-1.5 text-xs"><span>{t('packages.publishedVersion')}</span>
          <select className={selectClass} aria-label={t('packages.versionFor', { name: pkg.displayName })} value={versionRef[pkg.resourceRef] ?? ''} disabled={disabled || read.loading}
            onChange={event => setVersionRef(previous => ({ ...previous, [pkg.resourceRef]: event.target.value }))}>
            <option value="">{t('packages.chooseVersion')}</option>{pkg.versions.map(version => <option key={version.revisionRef} value={version.revisionRef}>{version.version}</option>)}
          </select>
        </label>
        <Button type="button" size="sm" disabled={disabled || read.loading || !versionRef[pkg.resourceRef] || draft.packages.some(value => value.resourceRef === pkg.resourceRef)}
          onClick={async () => {
            const selected = await read.run({ view: 'package-version', agentId: header.agentId, expectedRevision: header.revision,
              expectedWorkflowRevision: header.workflowRevision, resourceRef: pkg.resourceRef, publishedRevisionRef: versionRef[pkg.resourceRef] });
            if (selected?.view === 'package-version') { onApplyVersion(selected, selected.kind === 'plugin' ? { kind: 'plugin' } : { kind: 'skills', relativeRoots: [''] }); setLibraryOpen(false); }
          }}>{t('packages.addSelected')}</Button>
      </div>)}
      {read.result?.view === 'packages' && read.result.pagination.totalPages > 1 ? <div className="flex items-center justify-between gap-2 text-xs">
        <Button type="button" size="sm" variant="outline" disabled={disabled || read.loading || read.result.pagination.page <= 1} onClick={() => void load(read.result!.view === 'packages' ? read.result!.pagination.page - 1 : 1)}>{t('previous')}</Button>
        <span>{t('page', { page: read.result.pagination.page, count: read.result.pagination.totalPages })}</span>
        <Button type="button" size="sm" variant="outline" disabled={disabled || read.loading || read.result.pagination.page >= read.result.pagination.totalPages} onClick={() => void load(read.result!.view === 'packages' ? read.result!.pagination.page + 1 : 1)}>{t('next')}</Button>
      </div> : null}
    </div> : null}
  </div>;
}
