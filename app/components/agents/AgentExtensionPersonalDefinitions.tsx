'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AgentExtensionEditorContext } from './AgentExtensionEditor';
import { agentExtensionOptionsContextUrl } from './agent-extension-options-client';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';
import { WorkflowCheckbox } from './WorkflowCheckbox';

/** Approved server identities are loaded from the actual definitions API, never derived from names or domains. */
type Props = { context: AgentExtensionEditorContext; value: readonly string[]; disabled?: boolean; onChange: (ids: string[]) => void };
export function AgentExtensionPersonalDefinitions(props: Props) {
  return <PersonalDefinitionsSession key={JSON.stringify([props.context.actorId, props.context.workspaceId,
    props.context.organizationId, props.context.projectId])} {...props} />;
}
function PersonalDefinitionsSession({ context, value, disabled, onChange }: Props) {
  const copy = useAgentExtensionCopy(), [rows, setRows] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false), [load, setLoad] = useState(0);
  const key = JSON.stringify([context.actorId, context.workspaceId, context.organizationId, context.projectId]);
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setPending(true); setError(null); setRows([]); } });
    void fetch(agentExtensionOptionsContextUrl('/api/integrations/mcp-definitions', context), { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then(async response => {
        const body = await response.json() as { success?: boolean; error?: string; data?: { organizationId?: string | null; definitions?: Array<{ id: string; name: string; enabled: boolean }> } };
        if (!response.ok || !body.success || !Array.isArray(body.data?.definitions)) throw new Error(body.error || copy('Definitionen konnten nicht geladen werden.', 'Could not load definitions.'));
        if (context.organizationId && body.data.organizationId !== context.organizationId) throw new Error(copy('Die Definitionen gehören zu einem anderen Organisationskontext.', 'The definitions belong to a different organization context.'));
        if (!controller.signal.aborted) setRows(body.data.definitions.filter(row => row.enabled && /^[a-f0-9-]{36}$/u.test(row.id)).map(({ id, name }) => ({ id, name })));
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
    // The key captures every scoped caller field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);
  return <div className="space-y-2 rounded-md border p-2.5">
    <p className="text-xs text-muted-foreground">{copy('Nutzende dürfen nur eigene Verbindungen aus diesen freigegebenen MCP-Definitionen wählen.', 'Users may choose their own connections only from these approved MCP definitions.')}</p>
    <Button type="button" size="sm" variant="outline" disabled={disabled || pending} onClick={() => setLoad(count => count + 1)}>{pending ? copy('Lädt …', 'Loading…') : copy('Freigegebene Definitionen laden', 'Load approved definitions')}</Button>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {rows.map(row => <label key={row.id} className="flex items-start gap-2 text-xs"><WorkflowCheckbox disabled={disabled} checked={value.includes(row.id)}
      onCheckedChange={checked => onChange(checked ? [...new Set([...value, row.id])] : value.filter(id => id !== row.id))} />{row.name}</label>)}
    {value.filter(id => !rows.some(row => row.id === id)).map((id, index) => <label key={id} className="flex items-start gap-2 text-xs text-muted-foreground"><WorkflowCheckbox checked disabled={disabled}
      onCheckedChange={() => onChange(value.filter(candidate => candidate !== id))} />{copy('Gespeicherte Definition', 'Saved definition')} {index + 1} · {copy('Metadaten noch nicht geladen', 'Metadata not loaded')}</label>)}
    {!pending && load > 0 && !rows.length && !error ? <p className="text-xs text-muted-foreground">{copy('Keine freigegebenen Definitionen verfügbar.', 'No approved definitions available.')}</p> : null}
  </div>;
}
