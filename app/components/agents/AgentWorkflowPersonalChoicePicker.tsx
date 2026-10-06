'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AgentWorkflowPersonalOptions, AgentWorkflowPersonalProviderOption } from '@/app/lib/agents/workflow-personal-options';
import { Button } from '@/components/ui/button';
import { AgentWorkflowClientError, readAgentWorkflowPersonalOptions, type AgentWorkflowPersonalSelectionInput } from './agent-workflow-client';

export function AgentWorkflowPersonalChoicePicker({ agentId, workspaceId, capabilityKey, workflowRevision, disabled, onSave, onConflict }: {
  agentId: string; workspaceId: string | null; capabilityKey: string; workflowRevision: number; disabled: boolean;
  onSave: (selection: AgentWorkflowPersonalSelectionInput) => Promise<boolean>;
  onConflict: () => void;
}) {
  const t = useTranslations('agentWorkflow');
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<AgentWorkflowPersonalOptions | null>(null);
  const [selected, setSelected] = useState<{ alternativeKey: string; source: 'mcp' | 'composio'; provider: AgentWorkflowPersonalProviderOption } | null>(null);
  const [accountRef, setAccountRef] = useState(''), [error, setError] = useState<'load' | 'conflict' | null>(null);
  const controller = useRef<AbortController | null>(null), sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; controller.current?.abort(); }, []);
  const read = async (selection?: { alternativeKey: string; source: 'mcp' | 'composio'; provider: AgentWorkflowPersonalProviderOption }) => {
    controller.current?.abort(); const current = new AbortController(), id = ++sequence.current; controller.current = current;
    setLoading(true); setError(null); setAccountRef(''); setSelected(null);
    try {
      const result = await readAgentWorkflowPersonalOptions({ agentId, workspaceId, capabilityKey, expectedWorkflowRevision: workflowRevision,
        ...(selection ? { alternativeKey: selection.alternativeKey, providerRef: selection.provider.providerRef } : {}) }, current.signal);
      if (current.signal.aborted || id !== sequence.current) return;
      if (!selection) setOptions(result);
      else {
        const alternative = result.alternatives.find(entry => entry.alternativeKey === selection.alternativeKey && entry.source === selection.source);
        const provider = alternative?.providers.find(entry => entry.providerRef === selection.provider.providerRef);
        if (!provider) { setError('load'); return; }
        setSelected({ ...selection, provider });
      }
    } catch (failure) {
      if (!current.signal.aborted && id === sequence.current) {
        const conflict = failure instanceof AgentWorkflowClientError && failure.status === 409;
        setError(conflict ? 'conflict' : 'load'); if (conflict) onConflict();
      }
    } finally { if (!current.signal.aborted && id === sequence.current) setLoading(false); }
  };
  const providers = options?.alternatives.flatMap(alternative => alternative.providers.map(provider => ({ alternativeKey: alternative.alternativeKey, source: alternative.source, provider }))) ?? [];
  const providerValue = (entry: { alternativeKey: string; provider: AgentWorkflowPersonalProviderOption }) => JSON.stringify([entry.alternativeKey, entry.provider.providerRef]);
  const accounts = selected?.provider.accounts ?? [];
  const availableAccount = accounts.find(account => account.accountSelectionRef === accountRef && account.selectable);
  const usable = selected && !['setup_required', 'unavailable'].includes(selected.provider.status)
    && (selected.source === 'mcp' || selected.provider.noAuth === true || Boolean(availableAccount));
  return <div className="space-y-3 border-t pt-3" data-testid="agent-workflow-personal-choice">
    <Button type="button" variant="ghost" size="sm" disabled={disabled || loading} onClick={() => {
      if (open) { controller.current?.abort(); sequence.current += 1; setLoading(false); setOpen(false); }
      else { setOpen(true); void read(); }
    }}><UserRound className="size-3.5" />{t(open ? 'personal.hide' : 'personal.open')}</Button>
    {open ? <div className="space-y-3 rounded-lg bg-muted/30 p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('personal.description')}</p>
      {loading ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('personal.loading')}</p> : null}
      {error ? <div role="alert" className="space-y-2 text-xs"><p>{t(error === 'conflict' ? 'errors.conflict' : 'personal.error')}</p>
        {error === 'load' ? <p><Link href="/settings?tab=secrets" className="font-medium underline underline-offset-4">{t('personal.checkCredentials')}</Link></p> : null}
        <Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={() => void read()}>{t('personal.reload')}</Button></div> : null}
      {options && !error ? <>
        {!providers.length ? <p className="text-xs text-muted-foreground">{t('personal.empty')}</p> : <label className="block space-y-1.5 text-xs font-medium">
          <span>{t('personal.provider')}</span><select aria-label={t('personal.provider')} value={selected ? providerValue(selected) : ''}
            disabled={disabled || loading} className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={event => {
              const choice = providers.find(entry => providerValue(entry) === event.target.value);
              if (!choice) { setSelected(null); setAccountRef(''); return; }
              setAccountRef('');
              if (choice.source === 'composio') void read(choice); else setSelected(choice);
            }}>
            <option value="">{t('personal.chooseProvider')}</option>
            {providers.map(entry => <option key={providerValue(entry)} value={providerValue(entry)} disabled={['setup_required', 'unavailable'].includes(entry.provider.status)}>
              {entry.provider.label}{entry.provider.profileLabel ? ` · ${entry.provider.profileLabel}` : ''}{` · ${entry.source === 'mcp' ? 'MCP' : 'Composio'}`}
            </option>)}
          </select></label>}
        {selected?.source === 'composio' && selected.provider.noAuth !== true && !loading ? <label className="block space-y-1.5 text-xs font-medium">
          <span>{t('personal.account')}</span><select aria-label={t('personal.account')} value={accountRef} disabled={disabled || Boolean(error)}
            className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={event => setAccountRef(event.target.value)}>
            <option value="">{t('personal.chooseAccount')}</option>
            {accounts.map(account => <option key={account.accountSelectionRef} value={account.accountSelectionRef} disabled={!account.selectable}>{account.label}{!account.selectable ? ` · ${t('unavailable')}` : ''}</option>)}
          </select>
          {!accounts.some(account => account.selectable) ? <p className="font-normal text-muted-foreground">{t('personal.noAccounts')}</p> : null}
        </label> : null}
        {selected && !loading ? <div className="flex justify-end"><Button type="button" size="sm" disabled={disabled || Boolean(error) || !usable}
          onClick={async () => {
            const saved = await onSave({ alternativeKey: selected.alternativeKey, target: { kind: 'personal', source: selected.source,
              providerRef: selected.provider.providerRef, ...(availableAccount ? { accountSelectionRef: availableAccount.accountSelectionRef } : {}) } });
            if (saved) setOpen(false);
          }}>{t('personal.use')}</Button></div> : null}
      </> : null}
    </div> : null}
  </div>;
}
