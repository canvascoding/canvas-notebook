'use client';

import { AgentExtensionOptionsClientError } from './agent-extension-options-client';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';

export function AgentExtensionRequestErrorNotice({ error }: { error: Error }) {
  const copy = useAgentExtensionCopy();
  return <div role="alert" className="space-y-1 text-xs text-destructive"><p>{error.message}</p>
    {error instanceof AgentExtensionOptionsClientError && (error.status === 403 || error.status === 409) ? <p>{copy('Berechtigung oder Ausgangsstand hat sich geändert. Lade den Agenten im aktuellen Bereich neu, bevor du die Auswahl übernimmst.', 'Permissions or the saved version changed. Reload the agent in the current scope before applying this selection.')}</p> : null}
    {error instanceof AgentExtensionOptionsClientError && ['COMPOSIO_NOT_CONFIGURED', 'ENV_VARIABLE_MISSING', 'MISSING_API_KEY'].includes(error.code)
      ? <a className="inline-block underline underline-offset-2" href="/settings?tab=secrets" target="_blank" rel="noopener noreferrer">{copy('Secrets in den Einstellungen öffnen', 'Open Secrets in settings')}</a> : null}
  </div>;
}
