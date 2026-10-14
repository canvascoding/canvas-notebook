import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { isValidChatClientMessageId } from '@/app/lib/chat/message-submission';

export type TodoFollowUpTransaction = Readonly<{ version: 1; clientMessageId: string; comment: string; locale: string; expectedSessionId: string }>;

function transactionKey(todoId: string): string {
  const auth = openedDocumentAuthScope();
  if (!auth || typeof window === 'undefined') throw new Error('The signed-in to-do context is not ready.');
  return `canvas.todo.followUp.v1:${JSON.stringify([auth.userId, auth.sessionId, todoId])}`;
}

/** Retain the same logical request across a timeout, dialog reopen or page reload. */
export function prepareTodoFollowUpTransaction(todoId: string, comment: string, locale: string, expectedSessionId: string): TodoFollowUpTransaction {
  if (!expectedSessionId || expectedSessionId !== expectedSessionId.trim() || expectedSessionId.length > 256
    || /[\p{Cc}\p{Cf}]/u.test(expectedSessionId)) throw new Error('The to-do has no exact linked chat session.');
  const key = transactionKey(todoId), serialized = window.sessionStorage.getItem(key);
  if (serialized) {
    try {
      const saved = JSON.parse(serialized) as Partial<TodoFollowUpTransaction>;
      if (saved.version === 1 && isValidChatClientMessageId(saved.clientMessageId) && saved.comment === comment && saved.locale === locale
        && typeof saved.expectedSessionId === 'string' && saved.expectedSessionId.length > 0 && saved.expectedSessionId.length <= 256)
        return Object.freeze({ version: 1, clientMessageId: saved.clientMessageId, comment, locale, expectedSessionId: saved.expectedSessionId });
    } catch { /* Invalid local data cannot supply message identity. */ }
  }
  const transaction = Object.freeze({ version: 1 as const, clientMessageId: crypto.randomUUID(), comment, locale, expectedSessionId });
  window.sessionStorage.setItem(key, JSON.stringify(transaction));
  return transaction;
}

export function completeTodoFollowUpTransaction(todoId: string, original: TodoFollowUpTransaction): void {
  const key = transactionKey(todoId), serialized = window.sessionStorage.getItem(key);
  if (!serialized) return;
  try {
    if ((JSON.parse(serialized) as Partial<TodoFollowUpTransaction>).clientMessageId === original.clientMessageId)
      window.sessionStorage.removeItem(key);
  } catch { /* Preserve a newer request rather than clearing it after a late ACK. */ }
}
