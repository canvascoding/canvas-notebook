export type ChannelId = 'app' | 'telegram' | string;

export interface ChannelPlugin {
  id: ChannelId;
  name: string;
  start(context: ChannelStartContext): Promise<void>;
  stop(): Promise<void>;
  deliver(message: OutboundMessage, target: DeliveryTarget): Promise<DeliveryResult>;
  getStatus(): ChannelStatus;
}

export interface ChannelStartContext {
  abortSignal: AbortSignal;
  onInboundMessage: (message: InboundMessage) => Promise<void>;
}

export interface InboundMessage {
  channelId: ChannelId;
  channelSessionKey: string;
  userId: string;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  content: string;
  role: 'assistant' | 'toolResult';
}

export interface DeliveryTarget {
  chatId: string;
  threadId?: string;
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
  mode?: 'polling' | 'webhook';
}