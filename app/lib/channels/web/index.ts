import type { ChannelPlugin, ChannelStatus, DeliveryResult, DeliveryTarget, OutboundMessage } from '../types';
import { WEB_CHANNEL_ID } from '../constants';

export class WebChannel implements ChannelPlugin {
  id = WEB_CHANNEL_ID;
  name = 'Web Chat';
  capabilities = {
    inboundText: true,
    inboundImages: true,
    outboundText: true,
  };

  async start(): Promise<void> {
    // Web delivery is handled by the existing WebSocket subscriptions.
  }

  async stop(): Promise<void> {
    // No channel-local resources to release.
  }

  async deliver(_message: OutboundMessage, _target: DeliveryTarget): Promise<DeliveryResult> {
    return { ok: true };
  }

  getStatus(): ChannelStatus {
    return {
      running: true,
      connected: true,
      mode: 'websocket',
    };
  }
}

export function createWebChannel(): WebChannel {
  return new WebChannel();
}
