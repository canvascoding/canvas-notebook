'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, LockKeyhole, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { WorkflowCheckbox as Checkbox } from './WorkflowCheckbox';
import type { AgentWorkflowTarget } from '@/app/lib/agents/workflow-contracts';
import type { AgentWorkflowManagementConnection, AgentWorkflowManagementHeader, AgentWorkflowManagementBindingSummary } from '@/app/lib/agents/workflow-management-contracts';
import type { AgentWorkflowPersonalProviderOption } from '@/app/lib/agents/workflow-personal-options';
import type { AgentWorkflowManagementContext } from './agent-workflow-management-client';
import { useWorkflowManagementOptions } from './use-workflow-management-options';

export type WorkflowTargetSlot = { resourceRef: string; publishedRevisionRef: string; declarationPath: string;
  capabilityId: string; alternativeKey: string };
const inputClass = 'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function WorkflowTargetSelector({ context, header, slot, target, summary, disabled, allowPersonal, ownerUserId, onChange, onAuthorityError }: {
  context: AgentWorkflowManagementContext; header: AgentWorkflowManagementHeader; slot: WorkflowTargetSlot;
  target: AgentWorkflowTarget | null; disabled: boolean; allowPersonal: boolean; ownerUserId: string | null;
  summary?: AgentWorkflowManagementBindingSummary;
  onChange: (target: AgentWorkflowTarget | null) => void; onAuthorityError: (error: 'conflict' | 'denied') => void;
}) {
  const t = useTranslations('agentWorkflowManagement');
  const [mode, setMode] = useState<'shared' | 'personal' | null>(null);
  const [shared, setShared] = useState<AgentWorkflowManagementConnection | null>(null), [confirmed, setConfirmed] = useState(false);
  const [provider, setProvider] = useState<AgentWorkflowPersonalProviderOption | null>(null), [accountRef, setAccountRef] = useState('');
  const [providerOptions, setProviderOptions] = useState<AgentWorkflowPersonalProviderOption[]>([]);
  const read = useWorkflowManagementOptions(context, onAuthorityError);
  const selectors = { agentId: header.agentId, expectedRevision: header.revision, expectedWorkflowRevision: header.workflowRevision, ...slot };
  const open = async (next: 'shared' | 'personal') => {
    setMode(next); setShared(null); setConfirmed(false); setProvider(null); setAccountRef('');
    const result = await read.run(next === 'shared' ? { view: 'connections', ...selectors, page: 1, limit: 50 }
      : { view: 'personal-connections', ...selectors });
    if (result?.view === 'personal-connections') setProviderOptions(result.alternatives.find(value => value.alternativeKey === slot.alternativeKey)?.providers ?? []);
  };
  const connections = mode === 'shared' && read.result?.view === 'connections' ? read.result.connections : [];
  const providers = mode === 'personal' ? providerOptions : [];
  const pagination = mode === 'shared' && read.result?.view === 'connections' ? read.result.pagination : null;
  const selectedAccount = provider?.accounts?.find(value => value.accountSelectionRef === accountRef && value.selectable);
  const source = slot.alternativeKey.startsWith('mcp:') ? 'mcp' : 'composio';
  const personalUsable = provider && !['unavailable', 'setup_required'].includes(provider.status)
    && (source === 'mcp' || provider.noAuth === true || Boolean(selectedAccount));
  return <div className="min-w-0 space-y-3" data-testid="workflow-management-target">
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
      {target?.kind === 'retained' ? <><LockKeyhole className="size-3.5 shrink-0" /><span>{t('target.retained')}</span></>
        : <span>{target ? t(target.kind === 'shared' ? 'target.sharedSelected' : 'target.personalSelected') : t('target.missing')}</span>}
      {target && summary ? <><span className="min-w-0 break-words">{summary.label}</span><span className="rounded border px-1.5 py-0.5">{t(`scope.${summary.scopeLabel}`)}</span>
        <span>{t(summary.status === 'setup_required' ? 'target.setupRequired' : 'target.unknown')}</span></> : null}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled || read.loading} onClick={() => void open('shared')}>{t('target.shared')}</Button>
      {allowPersonal && ownerUserId ? <Button type="button" size="sm" variant="outline" disabled={disabled || read.loading} onClick={() => void open('personal')}>{t('target.personal')}</Button> : null}
    </div>
    {mode ? <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      {read.loading ? <p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" />{t('loading')}</p> : null}
      {read.error ? <div role="alert" className="space-y-2 text-xs"><p>{t(`errors.${read.error}`)}</p>
        {mode === 'personal' && read.error === 'load' ? <Link href="/settings?tab=secrets" className="underline underline-offset-4">{t('checkCredentials')}</Link> : null}
        <Button type="button" size="sm" variant="outline" disabled={disabled || read.loading} onClick={() => void open(mode)}><RefreshCw className="size-3" />{t('retry')}</Button>
      </div> : null}
      {!read.loading && !read.error && mode === 'shared' ? <>
        <label className="block space-y-1.5 text-xs font-medium"><span>{t('target.shared')}</span>
          <select className={inputClass} aria-label={t('target.shared')} disabled={disabled} value={shared?.connectionRef ?? ''}
            onChange={event => { setShared(connections.find(value => value.connectionRef === event.target.value) ?? null); setConfirmed(false); onChange(null); }}>
            <option value="">{t('target.choose')}</option>
            {connections.map(value => <option key={value.connectionRef} value={value.connectionRef}>{value.label} · {t(`scope.${value.scopeLabel}`)}{value.ownershipLabel ? ` · ${value.ownershipLabel}` : ''}</option>)}
          </select>
        </label>
        {!connections.length ? <p className="text-xs text-muted-foreground">{t('target.empty')}</p> : null}
        {pagination && pagination.totalPages > 1 ? <div className="flex items-center justify-between gap-2 text-xs">
          <Button type="button" size="sm" variant="outline" disabled={disabled || pagination.page <= 1} onClick={() => { setShared(null); setConfirmed(false); void read.run({ view: 'connections', ...selectors, page: pagination.page - 1, limit: 50 }); }}>{t('previous')}</Button>
          <span>{t('page', { page: pagination.page, count: pagination.totalPages })}</span>
          <Button type="button" size="sm" variant="outline" disabled={disabled || pagination.page >= pagination.totalPages} onClick={() => { setShared(null); setConfirmed(false); void read.run({ view: 'connections', ...selectors, page: pagination.page + 1, limit: 50 }); }}>{t('next')}</Button>
        </div> : null}
        {shared?.status === 'setup_required' ? <p className="text-xs text-muted-foreground">{t('target.setupRequired')}</p> : null}
        {shared?.mappingRequired ? <label className="flex items-start gap-2 text-xs leading-relaxed">
          <Checkbox checked={confirmed} disabled={disabled} onCheckedChange={value => setConfirmed(value === true)} /><span>{t('target.confirmMapping')}</span>
        </label> : null}
        <Button type="button" size="sm" disabled={disabled || !shared || shared.mappingRequired && !confirmed}
          onClick={() => { if (shared) { onChange({ kind: 'shared', source: shared.source, connectionRef: shared.connectionRef,
            bindingRevision: shared.bindingRevision, ...(shared.mappingRequired ? { mcpMapping: { kind: 'manager_confirmation' } } : {}) }); setMode(null); } }}>{t('target.use')}</Button>
      </> : null}
      {!read.loading && !read.error && mode === 'personal' ? <>
        <label className="block space-y-1.5 text-xs font-medium"><span>{t('target.provider')}</span>
          <select className={inputClass} aria-label={t('target.provider')} disabled={disabled} value={provider?.providerRef ?? ''}
            onChange={async event => {
              const selected = providers.find(value => value.providerRef === event.target.value);
              setProvider(null); setAccountRef(''); onChange(null);
              if (!selected) return;
              if (source === 'mcp') { setProvider(selected); return; }
              const next = await read.run({ view: 'personal-connections', ...selectors, providerRef: selected.providerRef });
              if (next?.view === 'personal-connections') setProvider(next.alternatives.find(value => value.alternativeKey === slot.alternativeKey)?.providers
                .find(value => value.providerRef === selected.providerRef) ?? null);
            }}>
            <option value="">{t('target.chooseProvider')}</option>
            {providers.map(value => <option key={value.providerRef} value={value.providerRef} disabled={['unavailable', 'setup_required'].includes(value.status)}>{value.label}</option>)}
          </select>
        </label>
        {!providers.length ? <p className="text-xs text-muted-foreground">{t('target.noProviders')}</p> : null}
        {provider && source === 'composio' && provider.noAuth !== true ? <label className="block space-y-1.5 text-xs font-medium"><span>{t('target.account')}</span>
          <select className={inputClass} aria-label={t('target.account')} value={accountRef} disabled={disabled} onChange={event => setAccountRef(event.target.value)}>
            <option value="">{t('target.chooseAccount')}</option>
            {provider.accounts?.map(value => <option key={value.accountSelectionRef} value={value.accountSelectionRef} disabled={!value.selectable}>{value.label}</option>)}
          </select>
          {!provider.accounts?.some(value => value.selectable) ? <span className="block font-normal text-muted-foreground">{t('target.noAccounts')}</span> : null}
        </label> : null}
        <Button type="button" size="sm" disabled={disabled || !personalUsable || !ownerUserId}
          onClick={() => { if (provider && ownerUserId) { onChange({ kind: 'personal', source, ownerUserId, providerRef: provider.providerRef,
            ...(selectedAccount ? { accountSelectionRef: selectedAccount.accountSelectionRef } : {}) }); setMode(null); } }}>{t('target.use')}</Button>
      </> : null}
    </div> : null}
  </div>;
}
