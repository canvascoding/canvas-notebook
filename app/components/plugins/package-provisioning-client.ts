import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { extensionPackagePinSchema, type ExtensionPackagePin } from '@/app/lib/capabilities/extensions/contracts';
import { requestChatExtensionOptions } from '@/app/lib/chat/extension-options-client';
import { parseChatBody, projectChatBodyText } from '@/app/lib/chat/chat-body-contracts';
import { openedDocumentAuthScope, isOpenedDocumentAuthCurrent } from '@/app/lib/collaboration/opened-document-registry';
import { createPromptHandoff, persistPromptHandoff } from '@/app/lib/chat/prompt-handoff';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, clearCanvasChatActiveSessionStorage } from '@/app/lib/chat/constants';
import type { PluginNavigation } from '@/app/lib/plugins/plugin-navigation';
import type { CreatorChatNavigation } from './creator-chat-client';

export function publishedPackageNavigationPatch(pin: ExtensionPackagePin): Partial<PluginNavigation> {
  return { view: 'browse', resourceRef: pin.resourceRef, publishedRevisionRef: pin.publishedRevisionRef,
    publishedChecksum: pin.checksum, draftRef: undefined, plugin: undefined, skill: undefined, source: undefined, task: 'sharing', file: undefined };
}
export function publishedPackageNavigation(pin: ExtensionPackagePin, workspaceId?: string | null): string {
  return `/plugins?${new URLSearchParams({ view: 'browse', resourceRef: pin.resourceRef, publishedRevisionRef: pin.publishedRevisionRef,
    publishedChecksum: pin.checksum, task: 'sharing', ...(workspaceId ? { workspaceId } : {}) })}`;
}

/** Fresh exact-version options precede the ordinary unsent inline handoff. Connection selection stays in the existing chooser. */
export async function startPublishedPackageChat(workspaceId: string, rawPin: ExtensionPackagePin,
  locale: string, navigate: (href: CreatorChatNavigation) => void, isCurrent: () => boolean): Promise<void> {
  const auth = openedDocumentAuthScope(), pin = extensionPackagePinSchema.parse(rawPin);
  if (!auth) throw new Error('CHAT_EXTENSION_OPTIONS_UNAVAILABLE');
  const target = { kind: 'draft_turn' as const, agentId: DEFAULT_AGENT_ID, workspaceId };
  const result = await requestChatExtensionOptions({ operation: 'package_version', target, ...pin });
  if (result.package.pin.resourceRef !== pin.resourceRef || result.package.pin.publishedRevisionRef !== pin.publishedRevisionRef || result.package.pin.checksum !== pin.checksum || !isOpenedDocumentAuthCurrent(auth) || !isCurrent()) {
    throw new Error('CHAT_EXTENSION_OPTIONS_CONTEXT_CHANGED');
  }
  const selection = result.package.kind === 'plugin'
    ? { kind: 'plugin' as const, package: pin, skillSelection: { kind: 'all' as const } }
    : { kind: 'skill' as const, package: pin, origin: 'standalone' as const, relativeRoot: '' };
  const bundleId = crypto.randomUUID();
  const body = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: crypto.randomUUID(), bundleId },
    { type: 'text', text: locale.startsWith('de') ? '\n\nNutze diese Version. Aufgabe: ' : '\n\nUse this version. Task: ' }],
  bundles: [{ id: bundleId, caption: result.package.displayName || result.package.name,
    primary: { selection, requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] });
  const payload = createPromptHandoff({ prompt: projectChatBodyText(body), body, attachments: [], agentId: DEFAULT_AGENT_ID, workspaceId, auth, mode: 'compose' });
  persistPromptHandoff(window.sessionStorage, CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, payload);
  clearCanvasChatActiveSessionStorage(workspaceId);
  navigate({ pathname: '/notebook', query: { workspaceId, chat: 'open', handoff: payload.handoffId } });
}
