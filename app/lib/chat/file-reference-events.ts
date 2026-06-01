export const CHAT_FILE_REFERENCE_OPENED_EVENT = 'canvas:chat-file-reference-opened';

export type ChatFileReferenceOpenedDetail = {
  path: string;
};

export function notifyChatFileReferenceOpened(path: string) {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(
    new CustomEvent<ChatFileReferenceOpenedDetail>(CHAT_FILE_REFERENCE_OPENED_EVENT, {
      detail: { path },
    })
  );
}
