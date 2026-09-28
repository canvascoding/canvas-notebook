import { getPiMessageDetails, isRecord } from '@/app/lib/chat/message-content';
import type { ToolBatchCall } from '@/app/lib/chat/types';

/** A card is bound only to the persisted spawn receipt, never to goal or call order. */
export function getSpawnDelegationId(call: ToolBatchCall): string | null {
  if (call.toolName !== 'delegate_task' || !call.message) return null;
  const details = getPiMessageDetails(call.message.piMessage);
  if (!isRecord(details) || details.status !== 'accepted') return null;
  const id = details.delegation_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function isTerminalDelegationStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
