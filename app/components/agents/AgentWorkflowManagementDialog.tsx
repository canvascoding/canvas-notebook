'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, RefreshCw, Route, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { AgentExtensionEditor, clearAgentExtensionEditorDraft, type AgentExtensionEditorDraft,
  type AgentExtensionEditorValidation } from './AgentExtensionEditor';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';
import { agentWorkflowManagementContextKey, readAgentExtensionManagement, type AgentExtensionManagementSnapshot,
  type AgentWorkflowManagementContext, type AgentWorkflowManagementSaveInput,
  type AgentWorkflowManagementSaveResult } from './agent-workflow-management-client';
import { workflowManagementReadError, type WorkflowManagementReadError } from './use-workflow-management-options';

export type AgentWorkflowManagementDialogProps = {
  open: boolean; onOpenChange: (open: boolean) => void; agentId: string; agentName: string; ownerUserId: string | null;
  context: AgentWorkflowManagementContext; selectionEpoch: number; saveBlocked?: boolean;
  waitForPendingSave: (agentId: string) => Promise<void>;
  commit: (input: AgentWorkflowManagementSaveInput, captured: { context: AgentWorkflowManagementContext; selectionEpoch: number }) => Promise<AgentWorkflowManagementSaveResult>;
  onRestoreFocus?: () => void; onOpenNativeTools?: () => void;
  onDraftStateChange?: (state: { dirty: boolean; pending: boolean }) => void;
};

function ManagementSession({ open, onOpenChange, agentName, context, selectionEpoch, waitForPendingSave, commit,
  onRestoreFocus, onOpenNativeTools, onDraftStateChange, saveBlocked = false }: AgentWorkflowManagementDialogProps) {
  const t = useTranslations('agentWorkflowManagement'), copy = useAgentExtensionCopy();
  const [snapshot, setSnapshot] = useState<AgentExtensionManagementSnapshot | null>(null);
  const [draft, setDraft] = useState<AgentExtensionEditorDraft>({ intent: 'keep', configuration: null });
  const [validation, setValidation] = useState<AgentExtensionEditorValidation>({ pending: true, blocked: true, preview: null, error: null });
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState<WorkflowManagementReadError | null>(null);
  const [fence, setFence] = useState<'conflict' | 'denied' | null>(null);
  const [completedNeedsReload, setCompletedNeedsReload] = useState(false), [saved, setSaved] = useState(false);
  const [requiresFreshSnapshot, setRequiresFreshSnapshot] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  const savingNow = useRef(false), mounted = useRef(false);
  const load = useCallback(async (afterSave = false) => {
    controller.current?.abort();
    const current = new AbortController(), id = ++generation.current;
    controller.current = current; setLoading(true);
    try {
      await waitForPendingSave(context.agentId);
      if (current.signal.aborted || generation.current !== id) return;
      const next = await readAgentExtensionManagement(context, current.signal);
      if (current.signal.aborted || generation.current !== id) return;
      setSnapshot(next); setDraft({ intent: 'keep', configuration: next.extensions.configuration });
      setValidation({ pending: true, blocked: true, preview: null, error: null });
      setError(next.access.canEdit ? null : 'denied'); setFence(next.access.canEdit ? null : 'denied');
      setRequiresFreshSnapshot(false); setCompletedNeedsReload(false); setSaved(afterSave);
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
  const dirty = draft.intent === 'replace' && !completedNeedsReload;
  useEffect(() => {
    onDraftStateChange?.({ dirty, pending: saving });
    return () => onDraftStateChange?.({ dirty: false, pending: false });
  }, [dirty, saving, onDraftStateChange]);
  const target = snapshot ? { kind: 'existing' as const, agentId: context.agentId,
    expectedRevision: snapshot.extensions.revision, expectedWorkflowRevision: snapshot.extensions.workflowRevision } : null;
  const locked = loading || saving || Boolean(fence) || requiresFreshSnapshot || completedNeedsReload || !snapshot?.access.canEdit;
  const save = async () => {
    if (!snapshot || !target || locked || saveBlocked || savingNow.current || !dirty || !draft.configuration
      || validation.pending || validation.blocked) return;
    const input: AgentWorkflowManagementSaveInput = { agentId: context.agentId, expectedRevision: target.expectedRevision,
      expectedWorkflowRevision: target.expectedWorkflowRevision, extensions: structuredClone(draft.configuration) };
    const captured = { context: Object.freeze({ ...context }), selectionEpoch }, id = generation.current;
    savingNow.current = true; setSaving(true); setSaved(false);
    try {
      // The parent owns the write ticket: closing/switching does not abort an already sent mutation.
      await commit(input, captured);
      clearAgentExtensionEditorDraft(context, target);
      if (generation.current !== id) return;
      setCompletedNeedsReload(true); setError(null); setSaved(true);
      // Replace acknowledged revision/retained handles by a genuine inspection before another save.
      await load(true);
    } catch (failure) {
      if (generation.current !== id) return;
      if (failure && typeof failure === 'object' && Reflect.get(failure, 'mutationCompleted') === true) setCompletedNeedsReload(true);
      const kind = workflowManagementReadError(failure); setError(kind); if (kind !== 'load') setFence(kind);
    } finally { savingNow.current = false; if (mounted.current) setSaving(false); }
  };
  return <><Dialog open={open} onOpenChange={value => { if (!savingNow.current) onOpenChange(value); }}>
    <DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-3xl" data-testid="agent-workflow-management-dialog"
      onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus(); } }}>
      <DialogHeader className="pr-5"><DialogTitle className="flex items-center gap-2"><Route className="size-4" />
        {copy('Erweiterungen und Werkzeuge', 'Extensions and tools')}</DialogTitle>
        <DialogDescription>{copy(`Dauerhaft für ${agentName}. Pakete und einzelne Verbindungen werden gemeinsam verwaltet.`,
          `Permanent for ${agentName}. Manage packages and individual connections together.`)}</DialogDescription></DialogHeader>
      <div className="flex justify-end"><Button type="button" size="sm" variant="outline" disabled={loading || saving}
        onClick={() => { if (dirty) setConfirmReload(true); else void load(saved); }}><RefreshCw className="size-3.5" />{t('reload')}</Button></div>
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('loading')}</p> : null}
      {error ? <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 p-3 text-sm"><p>{t(`errors.${error}`)}</p>
        {completedNeedsReload ? <p>{copy('Die Änderung wurde bereits angenommen. Lade den gespeicherten Stand neu.', 'The change was already accepted. Reload the saved configuration.')}</p> : null}
      </div> : null}
      {snapshot && target && !loading ? <AgentExtensionEditor key={`${target.expectedRevision}:${target.expectedWorkflowRevision}`}
        target={target} context={context} value={draft} onChange={value => { setDraft(value); setSaved(false); }}
        enabledTools={snapshot.agent.enabledTools} bindingSummaries={snapshot.extensions.bindingSummaries} standaloneSummaries={snapshot.extensions.standaloneSummaries}
        disabled={locked} onValidationChange={setValidation} /> : null}
      {onOpenNativeTools ? <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">{copy('Erweiterte Einstellungen', 'Advanced settings')}</summary>
        <Button type="button" className="mt-3" size="sm" variant="outline" disabled={saving || saveBlocked}
          onClick={() => { onOpenChange(false); onOpenNativeTools(); }}><Wrench className="size-3.5" />{copy('Native Werkzeuge bearbeiten', 'Edit native tools')}</Button></details> : null}
      {saved ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Check className="size-4" />{t('saved')}</p> : null}
      <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>{t('close')}</Button>
        <Button type="button" disabled={locked || saveBlocked || !dirty || validation.pending || validation.blocked || !draft.configuration} onClick={() => void save()}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}{t('save')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
    <AlertDialog open={confirmReload} onOpenChange={setConfirmReload}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t('confirm.discardTitle')}</AlertDialogTitle>
        <AlertDialogDescription>{t('confirm.discardDescription')}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>{t('confirm.cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => {
        if (target) clearAgentExtensionEditorDraft(context, target);
        setRequiresFreshSnapshot(true); setConfirmReload(false); void load(saved);
      }}>{t('confirm.discard')}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}

/** A different actor/workspace/agent/selection epoch gets a separate delivery session. */
export function AgentWorkflowManagementDialog(props: AgentWorkflowManagementDialogProps) {
  const { agentId } = props, { workspaceId, projectId, organizationId, actorId } = props.context;
  const context = useMemo(() => Object.freeze({ agentId, workspaceId, projectId, organizationId, actorId }),
    [agentId, workspaceId, projectId, organizationId, actorId]);
  const key = `${agentWorkflowManagementContextKey(context)}:${props.selectionEpoch}`;
  return props.open ? <ManagementSession key={key} {...props} context={context} /> : null;
}
