import type { Attachment, ChatMessage } from '@/app/lib/chat/types';

function areAttachmentsEquivalent(current: Attachment[] | undefined, next: Attachment[] | undefined): boolean {
  if (!current?.length && !next?.length) {
    return true;
  }
  if (!current || !next || current.length !== next.length) {
    return false;
  }

  return current.every((attachment, index) => {
    const other = next[index];
    return (
      attachment.id === other.id &&
      attachment.name === other.name &&
      attachment.filePath === other.filePath &&
      attachment.mediaUrl === other.mediaUrl &&
      attachment.previewUrl === other.previewUrl &&
      attachment.mimeType === other.mimeType &&
      attachment.category === other.category &&
      attachment.contentKind === other.contentKind
    );
  });
}

function areCompactMetaEquivalent(current: ChatMessage['compactMeta'], next: ChatMessage['compactMeta']): boolean {
  if (!current && !next) {
    return true;
  }
  return Boolean(current && next) &&
    current?.kind === next?.kind &&
    current?.timestamp === next?.timestamp &&
    current?.omittedMessageCount === next?.omittedMessageCount;
}

function areComposioAuthMetaEquivalent(current: ChatMessage['composioAuthMeta'], next: ChatMessage['composioAuthMeta']): boolean {
  if (!current && !next) {
    return true;
  }
  return Boolean(current && next) &&
    current?.toolkit === next?.toolkit &&
    current?.toolkitName === next?.toolkitName &&
    current?.redirectUrl === next?.redirectUrl &&
    current?.toolName === next?.toolName;
}

export function areChatMessagesEquivalent(current: ChatMessage, next: ChatMessage): boolean {
  return (
    current.id === next.id &&
    current.role === next.role &&
    current.content === next.content &&
    current.type === next.type &&
    current.status === next.status &&
    current.toolName === next.toolName &&
    current.toolCallId === next.toolCallId &&
    current.toolArgs === next.toolArgs &&
    current.queueKind === next.queueKind &&
    current.optimistic === next.optimistic &&
    current.isCollapsed === next.isCollapsed &&
    current.autoCollapsedAtEnd === next.autoCollapsedAtEnd &&
    current.previewText === next.previewText &&
    areAttachmentsEquivalent(current.attachments, next.attachments) &&
    areCompactMetaEquivalent(current.compactMeta, next.compactMeta) &&
    areComposioAuthMetaEquivalent(current.composioAuthMeta, next.composioAuthMeta)
  );
}

export function areChatMessageListsEquivalent(current: ChatMessage[], next: ChatMessage[]): boolean {
  if (current.length !== next.length) {
    return false;
  }
  return current.every((message, index) => areChatMessagesEquivalent(message, next[index]));
}
