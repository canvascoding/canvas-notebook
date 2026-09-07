import type { ChatRequestContext } from '@/app/lib/chat/types';

/** Keep the browser-supplied todo context limited to the authorized record key. */
export function buildTodoPageChatContext(todoId: string | null | undefined): ChatRequestContext | null {
  const normalizedTodoId = todoId?.trim();
  return normalizedTodoId ? { todoContext: { todoId: normalizedTodoId } } : null;
}
