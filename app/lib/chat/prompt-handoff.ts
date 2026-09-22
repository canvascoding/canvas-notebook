import { deriveUploadAttachmentPreview } from '@/app/lib/chat/attachment-preview';
import { isRecord } from '@/app/lib/chat/message-content';
import type { Attachment } from '@/app/lib/chat/types';
import type { OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

type HandoffAuth = Pick<OpenedDocumentAuthScope, 'userId' | 'sessionId'>;
type HandoffStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type PromptHandoff = {
  handoffId: string;
  workspaceId: string;
  prompt: string;
  attachments: Attachment[];
  agentId: string | null;
  auth?: HandoffAuth;
};

function attachment(value: unknown): Attachment | null {
  if (!isRecord(value) || (value.contentKind !== 'image' && value.contentKind !== 'document')
    || typeof value.name !== 'string' || typeof value.id !== 'string' || !value.name || !value.id) return null;
  return deriveUploadAttachmentPreview({
    name: value.name, id: value.id, contentKind: value.contentKind,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
    category: typeof value.category === 'string' ? value.category : undefined,
    filePath: typeof value.filePath === 'string' ? value.filePath : undefined,
    previewUrl: typeof value.previewUrl === 'string' ? value.previewUrl : undefined,
    mediaUrl: typeof value.mediaUrl === 'string' ? value.mediaUrl : undefined,
  });
}

export function createPromptHandoff(input: {
  prompt: string; attachments: Attachment[]; agentId: string | null; workspaceId: string;
  auth?: HandoffAuth | null; handoffId?: string;
}): PromptHandoff {
  if (!input.workspaceId.trim()) throw new Error('Select a workspace before starting this chat.');
  return {
    handoffId: input.handoffId ?? crypto.randomUUID(), workspaceId: input.workspaceId,
    prompt: input.prompt, attachments: input.attachments, agentId: input.agentId,
    ...(input.auth ? { auth: { userId: input.auth.userId, sessionId: input.auth.sessionId } } : {}),
  };
}

export function persistPromptHandoff(storage: HandoffStorage, key: string, payload: PromptHandoff): void {
  const serialized = JSON.stringify(payload);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error('The prompt could not be saved. Please try again.');
}

/** Upgrade legacy payloads once, before any send, so retries retain their identity. */
export function readPromptHandoff(storage: HandoffStorage, key: string, context: {
  workspaceId: string; requestedHandoffId?: string | null; auth?: HandoffAuth | null;
}): PromptHandoff | null {
  const stored = storage.getItem(key);
  if (!stored) return null;
  let value: unknown;
  try { value = JSON.parse(stored); } catch { value = { prompt: stored }; }
  if (!isRecord(value)) throw new Error('The saved prompt is invalid.');
  const prompt = typeof value.prompt === 'string' ? value.prompt : '';
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(attachment).filter((entry): entry is Attachment => Boolean(entry)) : [];
  if (!prompt.trim() && attachments.length === 0) throw new Error('The saved prompt is empty.');
  if (value.handoffId !== undefined && (typeof value.handoffId !== 'string'
    || !/^[a-zA-Z0-9:_-]{1,128}$/u.test(value.handoffId))) throw new Error('The saved prompt identity is invalid.');
  const handoffId = typeof value.handoffId === 'string' ? value.handoffId : crypto.randomUUID();
  if (context.requestedHandoffId && context.requestedHandoffId !== handoffId) {
    throw new Error('The saved prompt does not match this notebook request.');
  }
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : context.workspaceId;
  if (workspaceId !== context.workspaceId) throw new Error('Open the original workspace to send this saved prompt.');
  if (value.auth !== undefined && (!isRecord(value.auth) || typeof value.auth.userId !== 'string'
    || typeof value.auth.sessionId !== 'string')) throw new Error('The saved prompt account is invalid.');
  const auth = value.auth as HandoffAuth | undefined;
  if (auth && (!context.auth || auth.userId !== context.auth.userId || auth.sessionId !== context.auth.sessionId)) {
    throw new Error('This prompt belongs to another sign-in session.');
  }
  const rawAgentId = typeof value.agentId === 'string' ? value.agentId.trim().toLowerCase() : '';
  const payload = createPromptHandoff({ prompt, attachments, handoffId, workspaceId,
    agentId: /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(rawAgentId) ? rawAgentId : null,
    auth: auth ?? context.auth });
  if (stored !== JSON.stringify(payload)) persistPromptHandoff(storage, key, payload);
  return payload;
}

/** An acknowledgement for an older request must never consume a newer prompt. */
export function consumePromptHandoff(storage: HandoffStorage, key: string, handoffId: string): void {
  const stored = storage.getItem(key);
  if (!stored) return;
  let value: unknown;
  try { value = JSON.parse(stored); } catch { return; }
  if (isRecord(value) && value.handoffId === handoffId) storage.removeItem(key);
}

/** Stored failures cannot take over a later unrelated document/chat navigation. */
export function isPromptHandoffForNavigation(storage: Pick<Storage, 'getItem'>, key: string, context: {
  search: string; workspaceId?: string | null;
}): boolean {
  try {
    const stored = storage.getItem(key);
    if (!stored) return false;
    const params = new URLSearchParams(context.search);
    let value: unknown;
    try { value = JSON.parse(stored); } catch { value = { prompt: stored }; }
    if (!isRecord(value)) return false;
    if (typeof value.handoffId === 'string') {
      return params.get('handoff') === value.handoffId
        && typeof value.workspaceId === 'string'
        && params.get('workspaceId') === value.workspaceId
        && (!context.workspaceId || context.workspaceId === value.workspaceId)
        && !params.get('session') && !params.get('path');
    }
    // Legacy home links had no explicit navigation target.
    return !params.get('handoff') && !params.get('session') && !params.get('path') && !params.get('chat')
      && (typeof value.workspaceId !== 'string' || !context.workspaceId || value.workspaceId === context.workspaceId);
  } catch { return false; }
}
