export type ChannelId = 'app' | 'telegram' | string;

export interface ChannelPlugin {
  id: ChannelId;
  name: string;
  capabilities?: ChannelCapabilities;
  start(context: ChannelStartContext): Promise<void>;
  stop(): Promise<void>;
  deliver(message: OutboundMessage, target: DeliveryTarget): Promise<DeliveryResult>;
  getStatus(): ChannelStatus;
}

export interface ChannelCapabilities {
  inboundText?: boolean;
  inboundImages?: boolean;
  inboundVideos?: boolean;
  inboundAudio?: boolean;
  inboundFiles?: boolean;
  outboundText?: boolean;
  outboundImages?: boolean;
  outboundVideos?: boolean;
  outboundAudio?: boolean;
  outboundFiles?: boolean;
  typingIndicator?: boolean;
}

export interface ChannelStartContext {
  abortSignal: AbortSignal;
  onInboundMessage: (message: InboundMessage) => Promise<void>;
}

export interface InboundMessage {
  channelId: ChannelId;
  channelSessionKey: string;
  channelThreadKey?: string;
  requestedSessionId?: string;
  agentMessageTimestamp?: number;
  userId: string;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  content: string;
  role: 'assistant' | 'toolResult';
}

export interface DeliveryTarget {
  channelId?: ChannelId;
  channelSessionKey?: string;
  channelThreadKey?: string;
  chatId: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  telegramMessageId?: number;
  error?: string;
}

export interface ChannelStatus {
  running: boolean;
  connected: boolean;
  lastError?: string;
  mode?: 'polling' | 'webhook' | 'websocket';
}
