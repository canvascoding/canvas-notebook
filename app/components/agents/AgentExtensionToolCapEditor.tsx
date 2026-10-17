'use client';

import { useState } from 'react';
import { WorkflowCheckbox } from './WorkflowCheckbox';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';

export const agentExtensionSelectClass = 'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function AgentExtensionToolCapEditor({ value, disabled, onChange }: { value: string[] | null; disabled?: boolean;
  onChange: (value: string[] | null) => void }) {
  const copy = useAgentExtensionCopy(), [editing, setEditing] = useState({ key: JSON.stringify(value), text: value?.join('\n') ?? '' });
  return <details className="rounded-md border bg-background/50 p-2.5"><summary className="cursor-pointer text-xs font-medium">{copy('Werkzeuggrenze', 'Tool limit')}
    <span className="ml-2 font-normal text-muted-foreground">{value === null ? copy('Erben', 'Inherit') : value.length === 0 ? copy('Keine Werkzeuge', 'No tools') : `${value.length}`}</span></summary>
    <div className="mt-3 space-y-2"><label className="flex items-start gap-2 text-xs"><WorkflowCheckbox checked={value !== null} disabled={disabled}
      onCheckedChange={checked => onChange(checked ? [] : null)} />{copy('Auf diese Werkzeuge beschränken', 'Limit to these tools')}</label>
      {value !== null ? <label className="block space-y-1 text-xs"><span>{copy('Ein exakter Werkzeugname pro Zeile', 'One exact tool name per line')}</span><textarea
        className="min-h-20 w-full rounded-md border bg-background p-2 font-mono text-xs" disabled={disabled} maxLength={65_536}
        value={editing.key === JSON.stringify(value) ? editing.text : value.join('\n')} onChange={event => {
          const next = [...new Set(event.target.value.split(/[\n,]/u).map(name => name.trim()).filter(Boolean))];
          setEditing({ key: JSON.stringify(next), text: event.target.value }); onChange(next);
        }} /></label> : <p className="text-xs text-muted-foreground">{copy('Die vorhandenen Berechtigungen und übergeordneten Grenzen gelten weiterhin.', 'Existing permissions and parent limits still apply.')}</p>}
    </div>
  </details>;
}
