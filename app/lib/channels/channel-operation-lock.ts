import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { normalizeChannelContext, type ChannelContextKey } from './channel-context';

function channelOperationKey(input: ChannelContextKey): string {
  const context = normalizeChannelContext(input);
  return JSON.stringify([
    context.userId,
    context.agentId,
    context.channelId,
    context.channelSessionKey,
    context.channelThreadKey,
  ]);
}

export async function withChannelOperationLock<T>(
  input: ChannelContextKey,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedOperationLock('channel-context', channelOperationKey(input), operation);
}
