type EmailActionScope =
  | { scope: 'personal'; workspaceId: null }
  | { scope: 'workspace'; workspaceId: string };

export type MobileEmailAction = EmailActionScope & (
  | { kind: 'review'; draftId: string; subject: string | null }
  | { kind: 'queue'; subject: string | null }
);

const REVIEW_TOOLS = new Set(['email_create_outbox_draft', 'email_update_outbox_draft']);
const QUEUE_TOOL = 'email_list_outbox_drafts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 200 && /^[-A-Za-z0-9_]+$/u.test(value) ? value : null;
}

function subject(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 1_000 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return undefined;
  return value.trim() || null;
}

function failed(value: Record<string, unknown>): boolean {
  return (value.isError !== undefined && value.isError !== false)
    || (value.error !== undefined && value.error !== null && value.error !== false)
    || value.success === false;
}

/** Project only server-created email destinations; text, args and URLs are never targets. */
function projectToolAction(toolName: unknown, details: unknown): MobileEmailAction | null {
  if (typeof toolName !== 'string' || (!REVIEW_TOOLS.has(toolName) && toolName !== QUEUE_TOOL)
    || !isRecord(details) || failed(details) || !isRecord(details.uiIntent)) return null;
  const intent = details.uiIntent;
  const kind = REVIEW_TOOLS.has(toolName) ? 'review' : 'queue';
  if (intent.view !== (kind === 'review' ? 'review-draft' : 'review-center')) return null;
  let scope: EmailActionScope;
  if (intent.scope === 'personal') {
    // Personal mailboxes can be used from an organization chat. The client
    // chooses an authorized personal workspace; the chat workspace is not it.
    scope = { scope: 'personal', workspaceId: null };
  } else if (intent.scope === 'workspace') {
    const workspaceId = identifier(intent.workspaceId);
    if (!workspaceId) return null;
    scope = { scope: 'workspace', workspaceId };
  } else return null;
  const projectedSubject = subject(intent.subject);
  if (projectedSubject === undefined) return null;
  if (kind === 'queue') return { ...scope, kind, subject: projectedSubject };
  const draftId = identifier(intent.draftId);
  return draftId ? { ...scope, kind, draftId, subject: projectedSubject } : null;
}

/** Read the original persisted tool result before general display compaction. */
export function projectMobileEmailAction(message: unknown): MobileEmailAction | null {
  if (!isRecord(message) || message.role !== 'toolResult' || failed(message)) return null;
  return projectToolAction(message.toolName, message.details);
}

/** Add the same safe action to completed live results, replacing untrusted input. */
export function projectMobileEmailAgentEvent(event: Record<string, unknown>): Record<string, unknown> {
  const { emailAction: _untrustedAction, ...safeEvent } = event;
  const action = event.type === 'tool_execution_end' && !failed(event) && isRecord(event.result) && !failed(event.result)
    ? projectToolAction(event.toolName, event.result.details)
    : null;
  return action ? { ...safeEvent, emailAction: action } : safeEvent;
}
