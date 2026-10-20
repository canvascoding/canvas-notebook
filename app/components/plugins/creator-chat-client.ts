import { openedDocumentAuthScope, isOpenedDocumentAuthCurrent } from '@/app/lib/collaboration/opened-document-registry';
import { createPromptHandoff, persistPromptHandoff } from '@/app/lib/chat/prompt-handoff';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, clearCanvasChatActiveSessionStorage } from '@/app/lib/chat/constants';
import { capabilityPackageCreatorChatSchema, capabilityPackageCreatorOptionsSchema, capabilityPackageCreatorChatIntentSchema,
  type CreatorChatIntent } from '@/app/lib/capabilities/packages/creator-chat-contracts';
import { workspaceRequest } from './plugin-workspace-client';

export type CreatorChatNavigation = { pathname: '/notebook'; query: { workspaceId: string; chat: 'open'; handoff: string } };
export async function readCapabilityPackageCreatorOptions(workspaceId: string, signal?: AbortSignal) {
  const data = capabilityPackageCreatorOptionsSchema.parse(await workspaceRequest('/api/capabilities/packages/creator', workspaceId, { signal }));
  if (data.workspaceId !== workspaceId) throw new Error('The current Creator workspace changed.');
  return data;
}

/** Normal auth-bound chat handoff. The unsent inline body remains subject to fresh send-time validation. */
export async function startCapabilityPackageCreatorChat(workspaceId: string, intent: CreatorChatIntent,
  navigate: (href: CreatorChatNavigation) => void, options: { signal?: AbortSignal; isCurrent?: () => boolean } = {}): Promise<void> {
  const auth = openedDocumentAuthScope();
  if (!auth) throw new Error('Sign in before opening the Creator.');
  const data = capabilityPackageCreatorChatSchema.parse(await workspaceRequest('/api/capabilities/packages/creator', workspaceId,
    { method: 'POST', signal: options.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(capabilityPackageCreatorChatIntentSchema.parse(intent)) }));
  if (data.workspaceId !== workspaceId || !isOpenedDocumentAuthCurrent(auth)) throw new Error('The current Creator context changed.');
  if (options.isCurrent?.() === false) throw new DOMException('The Creator navigation was cancelled.', 'AbortError');
  const payload = createPromptHandoff({ prompt: data.prompt, body: data.body, attachments: [], agentId: data.agentId,
    workspaceId, auth, mode: 'compose' });
  persistPromptHandoff(window.sessionStorage, CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, payload);
  clearCanvasChatActiveSessionStorage(workspaceId);
  navigate({ pathname: '/notebook', query: { workspaceId, chat: 'open', handoff: payload.handoffId } });
}
