'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Route } from 'lucide-react';
import { isAgentIconId } from '@/app/lib/agents/icons';
import { authClient } from '@/app/lib/auth-client';
import { AgentWorkflowManagementDialog } from '@/app/components/agents/AgentWorkflowManagementDialog';
import { agentWorkflowManagementContextKey, saveAgentWorkflowManagement, type AgentWorkflowManagementContext,
  type AgentWorkflowManagementSaveInput } from '@/app/components/agents/agent-workflow-management-client';
import { AgentWorkflowClientError } from '@/app/components/agents/agent-workflow-client';
import { Button } from '@/components/ui/button';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { workspaceRequest } from './plugin-workspace-client';
import { usePluginEditorNavigationGuard } from './plugin-navigation-guard';

type AgentChoice = { agentId: string; name: string; iconId?: string | null; type: string; access: { canEdit: boolean } };
type Props = { workspaceId: string; resourceRef: string; packageName: string };

/** This optional step configures an actual agent through the existing versioned workflow manager. */
export function PackageAgentSetup(props: Props) {
  const { data: session, isPending, error } = authClient.useSession();
  if (isPending || error || !session?.user.id || !session.session.id) return null;
  return <AgentSetupSession key={JSON.stringify([session.user.id, session.session.id, props.workspaceId, props.resourceRef])}
    {...props} actorId={session.user.id} sessionId={session.session.id} />;
}

function AgentSetupSession({ workspaceId, resourceRef, packageName, actorId, sessionId }: Props & { actorId: string; sessionId: string }) {
  const t = useTranslations('skills.workspace.setup');
  const [expanded, setExpanded] = useState(false), [agents, setAgents] = useState<AgentChoice[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const [selected, setSelected] = useState(''), [open, setOpen] = useState(false);
  const [draftState, setDraftState] = useState({ dirty: false, pending: false });
  const [epoch, setEpoch] = useState(0);
  const alive = useRef(false), generation = useRef(0), trigger = useRef<HTMLButtonElement>(null);
  const ticket = useRef<{ agentId: string; settled: Promise<void>; settle: () => void } | null>(null);
  const selection = useRef({ selected, epoch });
  useLayoutEffect(() => { selection.current = { selected, epoch }; }, [selected, epoch]);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  usePluginEditorNavigationGuard({ dirty: draftState.dirty, pending: () => draftState.pending || ticket.current !== null });
  const onDraftStateChange = useCallback((value: { dirty: boolean; pending: boolean }) => { if (alive.current) setDraftState(value); }, []);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController(), current = ++generation.current;
    void workspaceRequest<{ agents: AgentChoice[] }>('/api/agents', workspaceId, { signal: controller.signal }, { purpose: 'configure' })
      .then(value => {
        if (!alive.current || controller.signal.aborted || generation.current !== current) return;
        if (!Array.isArray(value.agents) || value.agents.some(agent => typeof agent.agentId !== 'string' || typeof agent.name !== 'string'
          || typeof agent.access?.canEdit !== 'boolean')) throw new Error('Invalid agent list');
        const choices = value.agents.filter(agent => agent.type !== 'main' && agent.access.canEdit);
        setAgents(choices); setSelected(choices.length === 1 ? choices[0].agentId : '');
      }).catch(() => { if (alive.current && !controller.signal.aborted && generation.current === current) setError(true); })
      .finally(() => { if (alive.current && !controller.signal.aborted && generation.current === current) setLoading(false); });
    return () => { controller.abort(); generation.current += 1; };
  }, [expanded, workspaceId]);
  const agent = agents.find(value => value.agentId === selected);
  const context = useMemo<AgentWorkflowManagementContext>(() => Object.freeze({ agentId: selected, workspaceId, actorId }), [selected, workspaceId, actorId]);
  const waitForPendingSave = useCallback(async (agentId: string) => { const pending = ticket.current; if (pending?.agentId === agentId) await pending.settled; }, []);
  const commit = useCallback(async (input: AgentWorkflowManagementSaveInput, captured: { context: AgentWorkflowManagementContext; selectionEpoch: number }) => {
    if (!alive.current || ticket.current || input.agentId !== selection.current.selected || captured.selectionEpoch !== selection.current.epoch
      || input.agentId !== captured.context.agentId || agentWorkflowManagementContextKey(captured.context) !== agentWorkflowManagementContextKey(context)) {
      throw new AgentWorkflowClientError(409, 'AGENT_WORKFLOW_REVISION_CONFLICT');
    }
    const current = await authClient.getSession();
    if (!alive.current || ticket.current || current.data?.user.id !== actorId || current.data?.session.id !== sessionId
      || input.agentId !== selection.current.selected || captured.selectionEpoch !== selection.current.epoch) throw new AgentWorkflowClientError(403, 'AGENT_ACCESS_DENIED');
    let settle!: () => void;
    const pending = { agentId: input.agentId, settled: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle() };
    ticket.current = pending;
    try { return await saveAgentWorkflowManagement(captured.context, input); }
    finally { if (ticket.current === pending) ticket.current = null; pending.settle(); }
  }, [context, actorId, sessionId]);
  return <section className="space-y-3 border-t pt-4" data-testid="package-agent-setup" data-resource-ref={resourceRef}>
    <Button type="button" variant="ghost" className="px-0" aria-expanded={expanded} disabled={open || draftState.pending} data-testid="package-agent-setup-expand"
      onClick={() => { if (!expanded) { setLoading(true); setError(false); setAgents([]); } setExpanded(value => !value); }}><Route className="size-4" />{t('agentUse')}</Button>
    {expanded ? <div className="space-y-3 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">{t('agentHint', { name: packageName })}</p>
      {loading ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{t('loading')}</p>
        : error ? <InlineNotice variant="warning">{t('loadError')}</InlineNotice> : !agents.length ? <p className="text-sm text-muted-foreground">{t('noAgents')}</p>
          : <>
            {agents.length > 1 ? <label className="block space-y-1 text-sm">{t('agentSelect')}
              <select className="h-9 w-full rounded-md border bg-background px-3" value={selected} data-testid="package-agent-setup-select"
                onChange={event => { setSelected(event.target.value); setEpoch(value => value + 1); }}>
                <option value="">{t('agentSelect')}</option>{agents.map(value => <option key={value.agentId} value={value.agentId}>{value.name}</option>)}
              </select></label> : null}
            {agent ? <div className="flex min-w-0 items-center gap-3"><PluginExtensionAvatar name={agent.name} identity={JSON.stringify([agent.agentId, workspaceId])} size="md"
              icon={isAgentIconId(agent.iconId) ? {url: `/images/agents/origami/${agent.iconId}.svg`, sourceKey: JSON.stringify([agent.agentId, agent.iconId])} : undefined} />
              <p className="min-w-0 break-words text-sm font-medium">{agent.name}</p></div> : null}
            <Button ref={trigger} type="button" variant="outline" disabled={!agent} data-testid="package-agent-setup-open"
              onClick={() => { setEpoch(value => value + 1); setOpen(true); }}>{t('agentConfigure')}</Button>
          </>}
      {agent ? <AgentWorkflowManagementDialog open={open} onOpenChange={setOpen} agentId={agent.agentId} agentName={agent.name}
        ownerUserId={actorId} context={context} selectionEpoch={epoch} waitForPendingSave={waitForPendingSave} commit={commit}
        onDraftStateChange={onDraftStateChange} onRestoreFocus={() => trigger.current?.focus()} /> : null}
    </div> : null}
  </section>;
}
