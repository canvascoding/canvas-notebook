'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, LockKeyhole, RefreshCw, Route } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AgentWorkflowDescriptor, AgentWorkflowConnectionOption } from '@/app/lib/agents/workflow-contracts';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AgentWorkflowClientError, readAgentWorkflow, retainWorkflowDrafts, saveAgentWorkflowChoice, workflowSelectionValue } from './agent-workflow-client';
import type { AgentWorkflowPersonalSelectionInput } from './agent-workflow-client';
import { AgentWorkflowPersonalChoicePicker } from './AgentWorkflowPersonalChoicePicker';

function WorkflowOptionSummary({ option }: { option?: AgentWorkflowConnectionOption }) {
  const t = useTranslations('agentWorkflow');
  return <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span className="min-w-0 break-words">{option?.label || t('noSelection')}</span>
    {option?.scopeLabel ? <span className="rounded border px-1.5 py-0.5">{t(`scope.${option.scopeLabel}`)}</span> : null}
    {option ? <span>{t(`status.${option.status}`)}</span> : null}
  </div>;
}

function AgentWorkflowChoices({ agentId, workspaceId }: { agentId: string; workspaceId: string | null }) {
  const t = useTranslations('agentWorkflow');
  const [descriptor, setDescriptor] = useState<AgentWorkflowDescriptor | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<'conflict' | 'denied' | 'load' | 'save' | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const packagesUnavailable = (descriptor?.unavailablePackageCount ?? 0) > 0;
  const load = useCallback(async (preserveDrafts: boolean) => {
    controller.current?.abort();
    const currentController = new AbortController(), currentSequence = ++sequence.current;
    controller.current = currentController; setLoading(true); setSavedKey(null);
    try {
      const next = await readAgentWorkflow(agentId, workspaceId, currentController.signal);
      if (sequence.current !== currentSequence || currentController.signal.aborted) return;
      setDescriptor(next); setDrafts(previous => retainWorkflowDrafts(preserveDrafts ? previous : {}, next)); setError(null);
    } catch (failure) {
      if (sequence.current !== currentSequence || currentController.signal.aborted) return;
      setError(failure instanceof AgentWorkflowClientError && [403, 404].includes(failure.status) ? 'denied' : 'load');
      // A failed refresh keeps the old draft, but may never make its CAS writable.
    } finally { if (sequence.current === currentSequence && !currentController.signal.aborted) setLoading(false); }
  }, [agentId, workspaceId]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(false); });
    return () => { cancelled = true; sequence.current += 1; controller.current?.abort(); };
  }, [load]);
  const save = async (key: string, personalSelection?: AgentWorkflowPersonalSelectionInput): Promise<boolean> => {
    if (!descriptor || savingKey || error || loading || packagesUnavailable || !descriptor.access.canUse) return false;
    const value = drafts[key], capability = descriptor.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities)).find(entry => entry.capabilityKey === key);
    const choice = capability?.choices.find(entry => `choice:${encodeURIComponent(entry.choiceId)}` === value);
    if (!personalSelection && value !== 'default' && choice?.availability !== 'available') return false;
    const currentSequence = sequence.current, currentController = new AbortController(); controller.current = currentController;
    setSavingKey(key); setSavedKey(null);
    try {
      const next = await saveAgentWorkflowChoice({ agentId, workspaceId, capabilityKey: key, expectedWorkflowRevision: descriptor.workflowRevision,
        expectedPreferenceRevision: descriptor.preferenceRevision, ...(personalSelection ? { personalSelection } : { choiceId: value === 'default' ? null : choice!.choiceId }) }, currentController.signal);
      if (sequence.current !== currentSequence || currentController.signal.aborted) return false;
      const savedCapability = next.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities)).find(entry => entry.capabilityKey === key);
      setDescriptor(next); setDrafts(previous => retainWorkflowDrafts({ ...previous, ...(savedCapability ? { [key]: workflowSelectionValue(savedCapability) } : {}) }, next));
      setSavedKey(key);
      return true;
    } catch (failure) {
      if (sequence.current !== currentSequence || currentController.signal.aborted) return false;
      setError(failure instanceof AgentWorkflowClientError && failure.status === 409 ? 'conflict'
        : failure instanceof AgentWorkflowClientError && [403, 404].includes(failure.status) ? 'denied' : 'save');
      return false;
    } finally { if (sequence.current === currentSequence && !currentController.signal.aborted) setSavingKey(null); }
  };
  const slots = descriptor?.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities.map(capability => ({ pkg, capability })))) ?? [];
  return <div className="min-h-0 space-y-4" data-testid="agent-workflow-choices">
    {error ? <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <p>{t(`errors.${error}`)}</p>
      <Button type="button" size="sm" variant="outline" disabled={loading || Boolean(savingKey)} onClick={() => void load(true)}>
        <RefreshCw className="size-3.5" />{t('reload')}
      </Button>
    </div> : null}
    {packagesUnavailable ? <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <p>{t('packagesUnavailable')}</p>
      <Button type="button" size="sm" variant="outline" disabled={loading || Boolean(savingKey)} onClick={() => void load(true)}>
        <RefreshCw className="size-3.5" />{t('reload')}
      </Button>
    </div> : null}
    {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('loading')}</p> : null}
    {!loading && descriptor && descriptor.workflowVersion !== 1 ? <p className="text-sm text-muted-foreground">{t('notConfigured')}</p> : null}
    {!loading && descriptor?.workflowVersion === 1 && !slots.length && !packagesUnavailable ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('noSlots')}</p> : null}
    {slots.map(({ pkg, capability }) => {
      const initial = workflowSelectionValue(capability), draft = drafts[capability.capabilityKey] ?? initial;
      const selectable = capability.selectionMode === 'selectable';
      return <section key={capability.capabilityKey} className="min-w-0 space-y-3 rounded-xl border p-4" data-testid="agent-workflow-capability">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-[0.13em] text-muted-foreground break-words">{pkg.name}</p>
            <h3 className="mt-1 text-sm font-semibold capitalize break-words">{capability.application}</h3>
            <WorkflowOptionSummary option={capability.selectedConnection} />
          </div>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">{!selectable ? <LockKeyhole className="size-3" /> : null}{t(selectable ? 'selectable' : 'fixed')}</span>
        </div>
        {!selectable ? <p className="text-xs leading-relaxed text-muted-foreground">{t('fixedDescription')}</p> : <>
          <label className="block space-y-1.5 text-xs font-medium"><span>{t('connection')}</span>
            <select aria-label={t('connectionFor', { application: capability.application })} value={draft}
              disabled={loading || Boolean(savingKey) || Boolean(error) || packagesUnavailable || !descriptor?.access.canUse}
              className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={event => { setDrafts(previous => ({ ...previous, [capability.capabilityKey]: event.target.value })); setSavedKey(null); }}>
              <option value="default">{t('defaultChoice')}</option>
              {initial === 'unavailable' ? <option value="unavailable" disabled>{t('unavailableSelection')}</option> : null}
              {initial === 'personal' ? <option value="personal" disabled>{t('currentPersonal')}</option> : null}
              {capability.choices.map(choice => <option key={choice.choiceId} value={`choice:${encodeURIComponent(choice.choiceId)}`} disabled={choice.availability !== 'available'}>
                {choice.label}{choice.scopeLabel ? ` · ${t(`scope.${choice.scopeLabel}`)}` : ''}{choice.availability === 'unavailable' ? ` · ${t('unavailable')}` : ''}
              </option>)}
            </select>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{t('defaultHint')}</p>
            <Button type="button" size="sm" disabled={loading || Boolean(savingKey) || Boolean(error) || packagesUnavailable || draft === initial || !descriptor?.access.canUse || ['personal', 'unavailable'].includes(draft)}
              onClick={() => void save(capability.capabilityKey)}>
              {savingKey === capability.capabilityKey ? <Loader2 className="size-3.5 animate-spin" /> : savedKey === capability.capabilityKey ? <Check className="size-3.5" /> : null}
              {t(savedKey === capability.capabilityKey ? 'saved' : 'save')}
            </Button>
          </div>
          {capability.personalChoiceAllowed ? <AgentWorkflowPersonalChoicePicker key={`${capability.capabilityKey}:${descriptor?.workflowRevision}`}
            agentId={agentId} workspaceId={workspaceId} capabilityKey={capability.capabilityKey} workflowRevision={descriptor!.workflowRevision}
            disabled={loading || Boolean(savingKey) || Boolean(error) || packagesUnavailable || !descriptor?.access.canUse} onSave={selection => save(capability.capabilityKey, selection)}
            onConflict={() => setError('conflict')} /> : null}
        </>}
      </section>;
    })}
  </div>;
}

export function AgentWorkflowChoiceDialog({ open, agentId, agentName, onOpenChange, onRestoreFocus }: {
  open: boolean; agentId: string; agentName: string; onOpenChange: (open: boolean) => void; onRestoreFocus?: () => void;
}) {
  const t = useTranslations('agentWorkflow'), workspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-xl" data-testid="agent-workflow-dialog"
      onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus(); } }}>
      <DialogHeader className="pr-5"><DialogTitle className="flex min-w-0 items-center gap-2"><Route className="size-4 shrink-0" />{t('title')}</DialogTitle>
        <DialogDescription className="break-words">{t('description', { agent: agentName })}</DialogDescription></DialogHeader>
      {open ? <AgentWorkflowChoices key={`${agentId}:${workspaceId || ''}`} agentId={agentId} workspaceId={workspaceId} /> : null}
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
