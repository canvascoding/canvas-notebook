import { type ChannelPlugin, type ChannelId } from './types';

class ChannelRegistry {
  private channels = new Map<ChannelId, ChannelPlugin>();

  register(channel: ChannelPlugin): void {
    if (this.channels.has(channel.id)) {
      console.warn(`[ChannelRegistry] Channel '${channel.id}' already registered, replacing`);
    }
    this.channels.set(channel.id, channel);
    console.log(`[ChannelRegistry] Registered channel: ${channel.id} (${channel.name})`);
  }

  unregister(channelId: ChannelId): void {
    this.channels.delete(channelId);
    console.log(`[ChannelRegistry] Unregistered channel: ${channelId}`);
  }

  get(channelId: ChannelId): ChannelPlugin | undefined {
    return this.channels.get(channelId);
  }

  getAll(): ChannelPlugin[] {
    return Array.from(this.channels.values());
  }

  has(channelId: ChannelId): boolean {
    return this.channels.has(channelId);
  }
}

const globalRegistry = globalThis as typeof globalThis & {
  __channelRegistry?: ChannelRegistry;
};

export function getChannelRegistry(): ChannelRegistry {
  if (!globalRegistry.__channelRegistry) {
    globalRegistry.__channelRegistry = new ChannelRegistry();
  }
  return globalRegistry.__channelRegistry;
}