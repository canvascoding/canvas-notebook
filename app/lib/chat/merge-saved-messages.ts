import { getChatMessageSequence } from '@/app/lib/chat/message-metadata';
import type { ChatMessage } from '@/app/lib/chat/types';

function numericId(message: ChatMessage): number | null {
  return /^\d+$/.test(message.id) ? Number(message.id) : null;
}

/** Keep already paginated history when the server returns only its latest page. */
export function mergeSavedMessages(current: ChatMessage[], saved: ChatMessage[]) {
  if (!saved.length) return { messages: current, retainedOlder: current.length > 0 };
  const firstSequence = getChatMessageSequence(saved[0]);
  const firstId = numericId(saved[0]);
  const lastSequence = getChatMessageSequence(saved.at(-1));
  const lastId = numericId(saved[saved.length - 1]);
  const savedIds = new Set(saved.map((message) => message.id));
  const older = current.filter((message) => {
    if (savedIds.has(message.id)) return false;
    const sequence = getChatMessageSequence(message);
    if (firstSequence !== null && sequence !== null) return sequence < firstSequence;
    const id = numericId(message);
    return firstId !== null && id !== null && id < firstId;
  });
  const newer = current.filter((message) => {
    if (savedIds.has(message.id)) return false;
    const sequence = getChatMessageSequence(message);
    if (lastSequence !== null && sequence !== null) return sequence > lastSequence;
    const id = numericId(message);
    return lastId !== null && id !== null && id > lastId;
  });
  return { messages: [...older, ...saved, ...newer], retainedOlder: older.length > 0 };
}
