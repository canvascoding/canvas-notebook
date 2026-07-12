import { DEFAULT_AGENT_ID, normalizeChannelThreadKey } from './constants';

export type ChannelContextKey = {
  userId: string;
  channelId: string;
  channelSessionKey: string;
  channelThreadKey?: string | null;
  agentId?: string | null;
};

export type NormalizedChannelContext = {
  userId: string;
  agentId: string;
  channelId: string;
  channelSessionKey: string;
  channelThreadKey: string;
};

export function normalizeChannelContext(input: ChannelContextKey): NormalizedChannelContext {
  return {
    userId: input.userId,
    agentId: input.agentId?.trim() || DEFAULT_AGENT_ID,
    channelId: input.channelId,
    channelSessionKey: input.channelSessionKey,
    channelThreadKey: normalizeChannelThreadKey(input.channelThreadKey),
  };
}
