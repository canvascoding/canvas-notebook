'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Loader2, Package, RefreshCw, Route, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import type { AgentWorkflowPackageConfiguration } from '@/app/lib/agents/workflow-contracts';
import type { AgentWorkflowManagementPackageVersion } from '@/app/lib/agents/workflow-management-contracts';
import { agentWorkflowManagementContextKey, readAgentWorkflowManagement, type AgentWorkflowManagementContext,
  type AgentWorkflowManagementSaveInput, type AgentWorkflowManagementSaveResult } from './agent-workflow-management-client';
import { applyWorkflowPackageVersion, buildAgentWorkflowConfigurationPayload, createAgentWorkflowManagementDraft,
  isAgentWorkflowManagementDraftDirty, removeWorkflowPackage, type AgentWorkflowManagementDraft, type WorkflowDraftPackage } from './agent-workflow-management-draft';
import { workflowManagementReadError, type WorkflowManagementReadError } from './use-workflow-management-options';
import { WorkflowPackageSelectionSection } from './WorkflowPackageSelectionSection';
import { WorkflowCapabilityBindingSection } from './WorkflowCapabilityBindingSection';

export type AgentWorkflowManagementDialogProps = {
  open: boolean; onOpenChange: (open: boolean) => void; agentId: string; agentName: string; ownerUserId: string | null;
  context: AgentWorkflowManagementContext; selectionEpoch: number;
  saveBlocked?: boolean;
  waitForPendingSave: (agentId: string) => Promise<void>;
  commit: (input: AgentWorkflowManagementSaveInput, captured: { context: AgentWorkflowManagementContext; selectionEpoch: number }) => Promise<AgentWorkflowManagementSaveResult>;
  onRestoreFocus?: () => void; onOpenNativeTools?: () => void;
  onDraftStateChange?: (state: { dirty: boolean; pending: boolean }) => void;
};
type Confirmation = 'close' | 'reload' | 'clear' | 'rebuild' | 'tools';

function ManagementSession({ open, onOpenChange, agentName, ownerUserId, context, selectionEpoch, waitForPendingSave, commit,
  onRestoreFocus, onOpenNativeTools, onDraftStateChange, saveBlocked = false }: AgentWorkflowManagementDialogProps) {
  const t = useTranslations('agentWorkflowManagement');
  const [draft, setDraft] = useState<AgentWorkflowManagementDraft | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState<WorkflowManagementReadError | null>(null), [saved, setSaved] = useState(false);
  const [fence, setFence] = useState<'conflict' | 'denied' | null>(null);
  const [completedNeedsReload, setCompletedNeedsReload] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [section, setSection] = useState<'packages' | 'bindings' | 'operations' | null>('packages');
  const generation = useRef(0), controller = useRef<AbortController | null>(null), savingNow = useRef(false), mounted = useRef(false);
  const load = useCallback(async (isAfterSave = false) => {
    controller.current?.abort();
    const current = new AbortController(), id = ++generation.current;
    controller.current = current; setLoading(true);
    try {
      await waitForPendingSave(context.agentId);
      if (current.signal.aborted || generation.current !== id) return;
      const snapshot = await readAgentWorkflowManagement(context, current.signal);
      if (current.signal.aborted || generation.current !== id) return;
      setDraft(createAgentWorkflowManagementDraft(snapshot)); setError(snapshot.access.canEdit ? null : 'denied');
      setFence(snapshot.access.canEdit ? null : 'denied');
      setCompletedNeedsReload(false); setSaved(isAfterSave);
    } catch (failure) {
      if (!current.signal.aborted && generation.current === id) {
        const kind = workflowManagementReadError(failure); setError(kind); if (kind !== 'load') setFence(kind);
      }
    } finally { if (!current.signal.aborted && generation.current === id) setLoading(false); }
  }, [context, waitForPendingSave]);
  useEffect(() => {
    let cancelled = false; mounted.current = true;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; mounted.current = false; generation.current += 1; controller.current?.abort(); };
  }, [load]);
  const dirty = Boolean(draft && isAgentWorkflowManagementDraftDirty(draft));
  useEffect(() => {
    onDraftStateChange?.({ dirty, pending: saving });
    return () => onDraftStateChange?.({ dirty: false, pending: false });
  }, [dirty, saving, onDraftStateChange]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, saving]);
  const authorityError = useCallback((kind: 'conflict' | 'denied') => { setError(kind); setFence(kind); setSaved(false); }, []);
  const locked = loading || saving || Boolean(fence) || completedNeedsReload || !draft?.base.access.canEdit;
  const change = (update: (current: AgentWorkflowManagementDraft) => AgentWorkflowManagementDraft) => {
    if (locked) return;
    setDraft(current => current ? update(current) : current); setSaved(false);
  };
  const cacheVersion = (version: AgentWorkflowManagementPackageVersion) => setDraft(current => {
    if (!current || version.agentId !== current.base.agentId || version.revision !== current.base.revision
      || version.workflowRevision !== current.base.workflowRevision) return current;
    return { ...current, packageVersions: { ...current.packageVersions, [version.resourceRef]: version } };
  });
  const applyVersion = (version: AgentWorkflowManagementPackageVersion, selection: AgentWorkflowPackageConfiguration['skillSelection']) => change(current => applyWorkflowPackageVersion(current, version, selection));
  const changePackage = (pkg: WorkflowDraftPackage) => change(current => ({ ...current, workflowIntent: 'replace',
    packages: current.packages.map(value => value.resourceRef === pkg.resourceRef ? pkg : value) }));
  const confirm = (action: Confirmation) => {
    if (savingNow.current || loading && action !== 'close') return;
    if (action === 'close' || action === 'reload' || action === 'tools') {
      if (dirty && !completedNeedsReload) { setConfirmation(action); return; }
      perform(action); return;
    }
    setConfirmation(action);
  };
  const perform = (action: Confirmation) => {
    setConfirmation(null);
    if (action === 'close' || action === 'tools') { onOpenChange(false); if (action === 'tools') onOpenNativeTools?.(); }
    else if (action === 'reload') void load();
    else if (action === 'clear') change(current => ({ ...current, workflowIntent: 'clear' }));
    else change(current => ({ ...current, workflowIntent: 'replace', packages: [], packageVersions: {} }));
  };
  const build = draft ? buildAgentWorkflowConfigurationPayload(draft) : null;
  const issues = build && !build.valid ? [...new Set(build.issues.map(value => value.split('|')[0]))].filter(value => value !== 'no_changes') : [];
  const save = async () => {
    if (!draft || locked || saveBlocked || savingNow.current || !build?.valid || !dirty) return;
    const input = structuredClone(build.input), captured = { context: Object.freeze({ ...context }), selectionEpoch };
    if (input.agentId !== captured.context.agentId) return;
    const id = generation.current; savingNow.current = true; setSaving(true); setSaved(false);
    try {
      // The parent owns the durable request ticket. Switching agents never aborts an already sent write.
      await commit(input, captured);
      if (generation.current !== id) return;
      setCompletedNeedsReload(true); setError(null); setSaved(true);
      // Retained handles bind the old revisions. Always replace them with a new management read after an acknowledged write.
      await load(true);
    } catch (failure) {
      if (generation.current !== id) return;
      const completed = failure && typeof failure === 'object' && Reflect.get(failure, 'mutationCompleted') === true;
      if (completed) setCompletedNeedsReload(true);
      const kind = workflowManagementReadError(failure); setError(kind); if (kind !== 'load') setFence(kind);
    } finally { savingNow.current = false; if (mounted.current) setSaving(false); }
  };
  const active = draft?.workflowIntent === 'clear' ? 'legacy' : draft?.workflowIntent === 'replace' ? 'available' : draft?.base.configurationState;
  const sectionButton = (value: 'packages' | 'bindings' | 'operations', icon: ReactNode, title: string, description: string) => <button type="button"
    data-testid={`workflow-management-${value}-toggle`} aria-expanded={section === value} className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onClick={() => setSection(current => current === value ? null : value)}>
    <span className="shrink-0 text-muted-foreground">{icon}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span>
      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span></span><ChevronDown className={`size-4 shrink-0 ${section === value ? 'rotate-180' : ''}`} />
  </button>;
  return <>
    <Dialog open={open} onOpenChange={value => { if (!value) confirm('close'); }}>
      <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}
        data-testid="agent-workflow-management-dialog" onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus(); } }}
        onEscapeKeyDown={event => { if (savingNow.current) event.preventDefault(); }} onInteractOutside={event => { if (savingNow.current) event.preventDefault(); }}>
        <DialogHeader className="border-b px-5 py-4 text-left sm:px-6"><DialogTitle className="flex items-center gap-2"><Route className="size-4" />{t('title')}</DialogTitle>
          <DialogDescription className="break-words">{t('description', { agent: agentName })}</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {loading ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{t('loading')}</p> : null}
          {error ? <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm" data-testid="workflow-management-error">
            <p>{t(`errors.${error}`)}</p><p className="text-xs text-muted-foreground">{t(completedNeedsReload ? 'errors.completedNeedsReload' : error === 'conflict' ? 'errors.reloadDiscard' : 'errors.draftRetained')}</p>
          </div> : null}
          {!loading && draft ? <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t(`scope.${draft.base.profile.scopeType === 'user' ? 'personal' : draft.base.profile.scopeType}`)}</span>
              <span>{t('revision', { revision: draft.base.revision })}</span><span>{t('workflowRevision', { revision: draft.base.workflowRevision })}</span></div>
            {active === 'legacy' ? <section className="space-y-3 rounded-xl border bg-muted/20 p-4" data-testid="workflow-management-legacy"><h3 className="text-sm font-semibold">{t('legacy.title')}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{t('legacy.description')}</p><Button type="button" variant="outline" size="sm" disabled={locked}
                onClick={() => change(current => ({ ...current, workflowIntent: 'replace', packages: [], packageVersions: {} }))}>{t('legacy.configure')}</Button></section>
              : active === 'blocked' ? <section role="alert" className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" data-testid="workflow-management-blocked">
                <h3 className="text-sm font-semibold">{t('blocked.title')}</h3><p className="text-sm text-muted-foreground">{t('blocked.description')}</p>
                <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => confirm('rebuild')}>{t('blocked.rebuild')}</Button></section> : null}
            {(draft.base.unavailablePackageCount > 0 || draft.base.unavailableConnectionCount > 0) && active === 'available' ? <p role="alert" className="rounded-lg border p-3 text-xs text-muted-foreground">{t('unavailable')}</p> : null}
            {active === 'available' ? <div className="divide-y rounded-xl border">
              <div>{sectionButton('packages', <Package className="size-4" />, t('packages.title'), t('packages.description'))}
                {section === 'packages' ? <div className="px-3 pb-4"><WorkflowPackageSelectionSection draft={draft} context={context} disabled={locked}
                  onCacheVersion={cacheVersion} onApplyVersion={applyVersion} onRemove={ref => change(current => removeWorkflowPackage(current, ref))} onAuthorityError={authorityError} /></div> : null}</div>
              <div>{sectionButton('bindings', <Route className="size-4" />, t('bindings.title'), t('bindings.description'))}
                {section === 'bindings' ? <div className="px-3 pb-4"><WorkflowCapabilityBindingSection draft={draft} context={context} disabled={locked} ownerUserId={ownerUserId}
                  onCacheVersion={cacheVersion} onChangePackage={changePackage} onAuthorityError={authorityError} /></div> : null}</div>
              <div>{sectionButton('operations', <Wrench className="size-4" />, t('operations.title'), t('operations.description'))}
                {section === 'operations' ? <section className="space-y-3 px-3 pb-4" data-testid="workflow-management-operations"><p className="text-xs text-muted-foreground">{t('operations.hint')}</p>
                  <p className="break-words rounded-md border bg-muted/20 p-3 font-mono text-xs">{draft.base.profile.enabledTools === null || draft.base.profile.enabledTools.length === 0 ? t('operations.defaults')
                    : draft.base.profile.enabledTools.every(value => value.trim() === '__none__') ? t('operations.none') : draft.base.profile.enabledTools.join(', ')}</p>
                  {onOpenNativeTools ? <Button type="button" size="sm" variant="outline" disabled={loading || saving} onClick={() => confirm('tools')}>{t('operations.open')}</Button> : null}</section> : null}</div>
            </div> : null}
            <section className="space-y-2 rounded-lg bg-muted/30 p-3" data-testid="workflow-management-review"><p className="text-xs leading-relaxed text-muted-foreground">{t(draft.workflowIntent === 'clear' ? 'review.clear' : active === 'available' && !draft.packages.length ? 'review.empty' : 'review.hint')}</p>
              {dirty && issues.length ? <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300">{issues.map(value => <li key={value}>{t(`validation.${['access_denied', 'configuration_blocked', 'invalid_packages', 'missing_version', 'invalid_roots', 'invalid_declarations', 'invalid_capabilities', 'required_binding', 'required_downgrade', 'invalid_choices', 'invalid_target', 'required_tool_cap', 'retained_target_changed', 'invalid_personal_policy', 'missing_mcp_mapping'].includes(value) ? value : 'invalid_target'}`)}</li>)}</ul> : null}
            </section>
            {draft.base.workflowVersion === 1 && draft.workflowIntent !== 'clear' ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => confirm('clear')}>{t('clear')}</Button> : null}
          </> : null}
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t px-4 py-3 sm:px-6">
          <Button type="button" variant="ghost" size="sm" data-testid="workflow-management-reload" disabled={loading || saving} onClick={() => confirm('reload')}><RefreshCw className="size-3.5" />{t('reload')}</Button>
          <div className="ml-auto flex items-center gap-2">{saved && !error ? <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" />{t('saved')}</span> : null}
            <Button type="button" variant="outline" disabled={saving} onClick={() => confirm('close')}>{t('close')}</Button>
            <Button type="button" data-testid="workflow-management-save" disabled={locked || saveBlocked || !dirty || !build?.valid} onClick={() => void save()}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : null}{t('save')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmation !== null} onOpenChange={value => { if (!value) setConfirmation(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t(confirmation === 'clear' ? 'confirm.clearTitle' : confirmation === 'rebuild' ? 'confirm.rebuildTitle' : 'confirm.discardTitle')}</AlertDialogTitle>
        <AlertDialogDescription>{t(confirmation === 'clear' ? 'confirm.clearDescription' : confirmation === 'rebuild' ? 'confirm.rebuildDescription' : 'confirm.discardDescription')}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>{t('confirm.cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => { if (confirmation) perform(confirmation); }}>{t(confirmation === 'clear' ? 'confirm.clear' : confirmation === 'rebuild' ? 'confirm.rebuild' : 'confirm.discard')}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
    </AlertDialog>
  </>;
}

/** A different actor, scope or selection epoch gets a new session; late responses never rehydrate it. */
export function AgentWorkflowManagementDialog(props: AgentWorkflowManagementDialogProps) {
  const { agentId } = props, { workspaceId, projectId, organizationId, actorId } = props.context;
  const context = useMemo(() => Object.freeze({ agentId, workspaceId, projectId, organizationId, actorId }),
    [agentId, workspaceId, projectId, organizationId, actorId]);
  const key = `${agentWorkflowManagementContextKey(context)}:${props.selectionEpoch}`;
  return props.open ? <ManagementSession key={key} {...props} context={context} /> : null;
}
