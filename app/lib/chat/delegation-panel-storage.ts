export const CHAT_DELEGATION_PANEL_EXPANDED_STORAGE_KEY = 'canvas.chat.subagents.expanded.v1';

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

export function readChatDelegationPanelExpanded(storage: StorageReader): boolean {
  try {
    return storage.getItem(CHAT_DELEGATION_PANEL_EXPANDED_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeChatDelegationPanelExpanded(storage: StorageWriter, expanded: boolean): void {
  try {
    storage.setItem(CHAT_DELEGATION_PANEL_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // The panel remains usable when browser storage is unavailable.
  }
}
