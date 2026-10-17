import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { composerDraftScope, loadComposerDraft, loadComposerDraftBody, saveComposerDraft } from './draft-storage';
import { parseChatBody, projectChatBodyText, type ChatBodyV1 } from './chat-body-contracts';
import { createTextChatBody } from './body-state';
import type { PromptHandoff } from './prompt-handoff';

/** Reload reads the current account/workspace draft, never the consumed handoff. */
export function readNewChatComposerDraft(workspaceId: string): ChatBodyV1 | null {
  const scope = composerDraftScope(workspaceId);
  const body = loadComposerDraftBody('__new__', scope);
  if (body) return body;
  const text = loadComposerDraft('__new__', scope);
  return text ? createTextChatBody(text) : null;
}

/** A compose acknowledgement requires durable local draft bytes, not a delayed React autosave. */
export function persistComposePromptHandoff(handoff: PromptHandoff, workspaceId: string): ChatBodyV1 {
  const auth = openedDocumentAuthScope();
  if (handoff.mode !== 'compose' || handoff.workspaceId !== workspaceId || !auth || !handoff.auth
    || handoff.auth.userId !== auth.userId || handoff.auth.sessionId !== auth.sessionId) throw new Error('The saved composer context changed.');
  const body = parseChatBody(handoff.body ?? createTextChatBody(handoff.prompt));
  if (projectChatBodyText(body) !== handoff.prompt) throw new Error('The saved composer body changed.');
  const scope = composerDraftScope(workspaceId);
  if (!scope) throw new Error('The composer account is unavailable.');
  saveComposerDraft('__new__', handoff.prompt, scope, body);
  if (JSON.stringify(loadComposerDraftBody('__new__', scope)) !== JSON.stringify(body)) {
    throw new Error('The composer draft could not be saved. Please try again.');
  }
  return body;
}
