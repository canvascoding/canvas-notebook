'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, LockKeyhole, RefreshCw, Route } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AgentWorkflowDescriptor, AgentWorkflowConnectionOption } from '@/app/lib/agents/workflow-contracts';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AgentWorkflowClientError, readAgentWorkflow, retainWorkflowDrafts, saveAgentWorkflowChoice, workflowSelectionValue } from './agent-workflow-client';
import type { AgentWorkflowChoiceContext } from './agent-workflow-client';
import { AgentExtensionConnectionChooser } from './AgentExtensionConnectionChooser';
import { agentWorkflowChoiceSelection, type AgentWorkflowChoiceSelection } from './agent-workflow-choice-input';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';

function WorkflowOptionSummary({ option }: { option?: AgentWorkflowConnectionOption }) {
  const t = useTranslations('agentWorkflow');
  return <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span className="min-w-0 break-words">{option?.label || t('noSelection')}</span>
    {option?.scopeLabel ? <span className="rounded border px-1.5 py-0.5">{t(`scope.${option.scopeLabel}`)}</span> : null}
    {option ? <span>{t(`status.${option.status}`)}</span> : null}
  </div>;
}

type WorkflowChoiceSlot = {
  selectedConnection?: AgentWorkflowConnectionOption;
  selectionOrigin: 'fixed' | 'default' | 'user' | 'stale' | 'missing';
};

function workflowChoiceIssue(capability: WorkflowChoiceSlot): 'missing' | 'stale' | 'setup_required' | 'unavailable' | null {
  if (capability.selectionOrigin === 'stale') return 'stale';
  if (capability.selectionOrigin === 'missing' || !capability.selectedConnection) return 'missing';
  if (capability.selectedConnection.status === 'setup_required') return 'setup_required';
  if (capability.selectedConnection.availability === 'unavailable' || capability.selectedConnection.status === 'unavailable') return 'unavailable';
  return null;
}

function AgentWorkflowChoices({ agentId, context }: { agentId: string; context: AgentWorkflowChoiceContext }) {
  const t = useTranslations('agentWorkflow');
  const copy = useAgentExtensionCopy();
  const [descriptor, setDescriptor] = useState<AgentWorkflowDescriptor | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [personalOpen, setPersonalOpen] = useState<string | null>(null);
  const [error, setError] = useState<'conflict' | 'denied' | 'load' | 'save' | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const savingNow = useRef(false);
  const packagesUnavailable = (descriptor?.unavailablePackageCount ?? 0) > 0;
  const load = useCallback(async (preserveDrafts: boolean) => {
    controller.current?.abort();
    const currentController = new AbortController(), currentSequence = ++sequence.current;
    controller.current = currentController; setLoading(true); setSavedKey(null);
    try {
      const next = await readAgentWorkflow(agentId, context, currentController.signal);
      if (sequence.current !== currentSequence || currentController.signal.aborted) return;
      setDescriptor(next); setDrafts(previous => retainWorkflowDrafts(preserveDrafts ? previous : {}, next)); setError(null);
    } catch (failure) {
      if (sequence.current !== currentSequence || currentController.signal.aborted) return;
      setError(failure instanceof AgentWorkflowClientError && [403, 404].includes(failure.status) ? 'denied' : 'load');
      // A failed refresh keeps the old draft, but may never make its CAS writable.
    } finally { if (sequence.current === currentSequence && !currentController.signal.aborted) setLoading(false); }
  }, [agentId, context]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(false); });
    return () => { cancelled = true; sequence.current += 1; controller.current?.abort(); };
  }, [load]);
  const slots = descriptor ? [
    ...descriptor.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities.map(capability => ({
      label: pkg.name, application: capability.application, capability })))),
    ...(descriptor.standalone ?? []).map(capability => ({ label: capability.source === 'composio' ? 'Composio' : 'MCP',
      application: capability.toolkit || capability.selectedConnection?.label || capability.source, capability })),
  ] : [];
  const requiredSetupMissing = slots.some(({ capability }) => capability.required && workflowChoiceIssue(capability));
  const save = async (key: string, selection?: AgentWorkflowChoiceSelection): Promise<boolean> => {
    if (!descriptor || savingNow.current || savingKey || error || loading || packagesUnavailable || !descriptor.access.canUse) return false;
    const value = drafts[key], capability = slots.find(entry => entry.capability.capabilityKey === key)?.capability;
    const choice = capability?.choices.find(entry => `choice:${encodeURIComponent(entry.choiceId)}` === value);
    if (!selection && value !== 'default' && choice?.availability !== 'available') return false;
    const currentSequence = sequence.current, currentController = new AbortController(); controller.current = currentController;
    savingNow.current = true; setSavingKey(key); setSavedKey(null);
    try {
      const next = await saveAgentWorkflowChoice({ agentId, context, capabilityKey: key, expectedWorkflowRevision: descriptor.workflowRevision,
        expectedPreferenceRevision: descriptor.preferenceRevision, ...(selection ?? { choiceId: value === 'default' ? null : choice!.choiceId }) }, currentController.signal);
      if (sequence.current !== currentSequence || currentController.signal.aborted) return false;
      const savedCapabilities = [...next.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities)), ...(next.standalone ?? [])];
      const savedCapability = savedCapabilities.find(entry => entry.capabilityKey === key);
      setDescriptor(next); setDrafts(previous => retainWorkflowDrafts({ ...previous, ...(savedCapability ? { [key]: workflowSelectionValue(savedCapability) } : {}) }, next));
      setSavedKey(key);
      return true;
    } catch (failure) {
      if (sequence.current !== currentSequence || currentController.signal.aborted) return false;
      setError(failure instanceof AgentWorkflowClientError && failure.status === 409 ? 'conflict'
        : failure instanceof AgentWorkflowClientError && [403, 404].includes(failure.status) ? 'denied' : 'save');
      return false;
    } finally { savingNow.current = false; if (sequence.current === currentSequence && !currentController.signal.aborted) setSavingKey(null); }
  };
  return <div className="min-h-0 min-w-0 space-y-4" data-testid="agent-workflow-choices">
    <div className="flex justify-end"><Button type="button" size="sm" variant="outline" disabled={loading || Boolean(savingKey)} onClick={() => void load(true)}>
      <RefreshCw className="size-3.5" />{t('reload')}</Button></div>
    {error ? <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <p>{t(`errors.${error}`)}</p>
    </div> : null}
    {packagesUnavailable ? <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <p>{t('packagesUnavailable')}</p>
    </div> : null}
    {!loading && !error && requiredSetupMissing ? <p role="status" data-testid="agent-workflow-required-setup"
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm leading-relaxed">
      {copy('Erforderliche Verbindungen sind noch nicht vollständig nutzbar. Externe Workflow-Aktionen bleiben gesperrt; erlaubte lokale Skills sind weiterhin verfügbar.',
        'Required connections are not fully usable yet. External workflow actions remain blocked; permitted local skills are still available.')}
    </p> : null}
    {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('loading')}</p> : null}
    {!loading && descriptor?.workflowVersion === null ? <p className="text-sm text-muted-foreground">{t('notConfigured')}</p> : null}
    {!loading && descriptor && descriptor.workflowVersion !== null && !slots.length && !packagesUnavailable ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('noSlots')}</p> : null}
    {slots.map(({ label, application, capability }) => {
      const initial = workflowSelectionValue(capability), draft = drafts[capability.capabilityKey] ?? initial;
      const selectable = capability.selectionMode === 'selectable';
      const personalAllowed = 'personalChoiceAllowed' in capability ? capability.personalChoiceAllowed : Boolean(capability.personalPolicy);
      const issue = workflowChoiceIssue(capability);
      return <section key={capability.capabilityKey} className="min-w-0 space-y-3 rounded-xl border p-4" data-testid="agent-workflow-capability">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-[0.13em] text-muted-foreground break-words">{label}</p>
            <h3 className="mt-1 text-sm font-semibold capitalize break-words">{application}</h3>
            <WorkflowOptionSummary option={capability.selectedConnection} />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
            {capability.required ? <span>{copy('Erforderlich', 'Required')}</span> : null}
            <span className="flex items-center gap-1">{!selectable ? <LockKeyhole className="size-3" /> : null}{t(selectable ? 'selectable' : 'fixed')}</span>
          </div>
        </div>
        {issue ? <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed" data-testid="agent-workflow-choice-issue">
          <p className="font-medium">{issue === 'stale' ? copy('Auswahl veraltet', 'Selection needs confirmation')
            : issue === 'setup_required' ? copy('Verbindung einrichten', 'Connection setup required')
              : issue === 'unavailable' ? copy('Verbindung derzeit nicht nutzbar', 'Connection currently unavailable')
                : personalAllowed && selectable ? copy('Meine Verbindung einrichten', 'Set up my connection')
                  : copy('Keine Verbindung ausgewählt', 'No connection selected')}</p>
          <p>{!selectable ? copy('Diese Verbindung ist in der Agent-Konfiguration festgelegt. Bitte die verantwortliche Person, sie zu prüfen.',
            'This connection is fixed in the agent configuration. Ask its owner to review it.')
            : issue === 'stale' ? copy('Die gespeicherte Auswahl passt nicht mehr zur aktuellen Konfiguration. Wähle und bestätige eine zulässige Verbindung erneut.',
              'The saved choice no longer matches the current configuration. Choose and confirm a permitted connection again.')
              : issue === 'missing' ? copy('Es ist noch keine Verbindung gespeichert. Wähle eine zulässige Verbindung und bestätige die Auswahl.',
                'No connection is saved yet. Choose a permitted connection and confirm the choice.')
                : issue === 'setup_required' ? copy('Die gespeicherte Verbindung benötigt Einrichtung. Öffne die passende Einrichtung oder wähle eine andere zulässige Verbindung.',
                  'The saved connection needs setup. Open its setup or choose another permitted connection.')
                  : copy('Prüfe den aktuellen Verbindungsstatus oder wähle eine andere zulässige Verbindung. Die Anzeige verlangt kein automatisches Neuverbinden.',
                    'Check the current connection status or choose another permitted connection. This status does not require automatic reconnection.')}</p>
        </div> : null}
        {!selectable ? <p className="text-xs leading-relaxed text-muted-foreground">{t('fixedDescription')}</p> : <>
          <label className="block space-y-1.5 text-xs font-medium"><span>{t('connection')}</span>
            <select aria-label={t('connectionFor', { application })} value={draft}
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
          {personalAllowed && descriptor ? <div className="rounded-lg border p-3">
            <Button type="button" size="sm" variant="outline" aria-expanded={personalOpen === capability.capabilityKey}
              disabled={loading || Boolean(savingKey) || Boolean(error) || packagesUnavailable || !descriptor.access.canUse}
              onClick={() => setPersonalOpen(previous => previous === capability.capabilityKey ? null : capability.capabilityKey)}>{issue === 'missing'
                ? copy('Meine Verbindung einrichten', 'Set up my connection') : copy('Eigene Verbindung wählen', 'Choose my connection')}</Button>
            {personalOpen === capability.capabilityKey && !loading && !error && !packagesUnavailable && descriptor.access.canUse ? <div className="mt-3"><AgentExtensionConnectionChooser key={`${capability.capabilityKey}:${descriptor.workflowRevision}:${descriptor.preferenceRevision}`}
              target={{ kind: 'user_choice', agentId, capabilityKey: capability.capabilityKey,
                expectedWorkflowRevision: descriptor.workflowRevision, expectedPreferenceRevision: descriptor.preferenceRevision }}
              selector={{ kind: 'slot' }} context={context}
              disabled={loading || Boolean(savingKey) || Boolean(error) || packagesUnavailable || !descriptor.access.canUse}
              onSelect={async selected => {
                const accepted = await save(capability.capabilityKey, agentWorkflowChoiceSelection(capability, selected));
                if (!accepted) throw new Error(copy('Die Verbindung wurde nicht bestätigt. Lade den aktuellen Stand neu.', 'The connection was not confirmed. Reload the current configuration.'));
              }} /></div> : null}
          </div> : null}
        </>}
      </section>;
    })}
  </div>;
}

export function AgentWorkflowChoiceDialog({ open, agentId, agentName, context, onOpenChange, onRestoreFocus }: {
  open: boolean; agentId: string; agentName: string; context?: AgentWorkflowChoiceContext;
  onOpenChange: (open: boolean) => void; onRestoreFocus?: () => void;
}) {
  const t = useTranslations('agentWorkflow'), activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const workspaceId = context === undefined ? activeWorkspaceId : context.workspaceId;
  const organizationId = context?.organizationId ?? null, projectId = context?.projectId ?? null, actorId = context?.actorId ?? null;
  const capturedContext = useMemo<AgentWorkflowChoiceContext>(() => Object.freeze({ workspaceId, organizationId, projectId, actorId }),
    [workspaceId, organizationId, projectId, actorId]);
  const contextKey = JSON.stringify([agentId, workspaceId, organizationId, projectId, actorId]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] min-w-0 grid-cols-1 overflow-y-auto sm:max-w-xl" data-testid="agent-workflow-dialog"
      onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus(); } }}>
      <DialogHeader className="pr-5"><DialogTitle className="flex min-w-0 items-center gap-2"><Route className="size-4 shrink-0" />{t('title')}</DialogTitle>
        <DialogDescription className="break-words">{t('description', { agent: agentName })}</DialogDescription></DialogHeader>
      {open ? <AgentWorkflowChoices key={contextKey} agentId={agentId} context={capturedContext} /> : null}
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
