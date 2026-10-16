import type { AgentExtensionSearchItem } from '@/app/lib/agents/extension-options-contracts';
import type { ChatBodyV1 } from './chat-body-contracts';
import type { ChatExtensionOptionsTarget, ChatExtensionRecentItem } from './extension-options-contracts';
import type { ExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { ChatInlineTextRange } from './inline-editor';

export type ChatFilePickerFile = { name: string; path: string; type: 'file' | 'directory'; isImage: boolean };
export type ChatReferencePickerValue = ChatFilePickerFile
  | { type: 'extension'; option: AgentExtensionSearchItem }
  | { type: 'recent'; recent: ChatExtensionRecentItem };
export type ChatReferenceDialogRequest = {
  /** Issuing signed-in epoch and chat target; presentation never crosses this partition. */
  issuedScope: string;
  /** One user selection attempt; repeated picks never reuse a resolver's state. */
  requestId?: string;
  target: ChatExtensionOptionsTarget; originalBody: ChatBodyV1; range: ChatInlineTextRange | null;
  option?: AgentExtensionSearchItem; recent?: ChatExtensionRecentItem;
  /** Explicit disclosure; ordinary selection resolves directly when no choice is missing. */
  configure?: boolean;
  /** Tab-memory intake only; never persisted in a body, URL, handoff or recent. */
  accountSelections?: Readonly<Record<string, { receipt: string; expiresAt: number }>>;
  /** A receipt refresh can confirm only this exact already referenced account. */
  confirmSelection?: ExtensionSelection;
};
