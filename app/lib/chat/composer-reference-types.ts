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
  target: ChatExtensionOptionsTarget; originalBody: ChatBodyV1; range: ChatInlineTextRange | null;
  option?: AgentExtensionSearchItem; recent?: ChatExtensionRecentItem;
  /** A receipt refresh can confirm only this exact already referenced account. */
  confirmSelection?: ExtensionSelection;
};
