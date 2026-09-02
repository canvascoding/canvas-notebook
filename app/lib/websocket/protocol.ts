import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ChatRequestContext } from '@/app/lib/chat/types';

export const CHAT_WEBSOCKET_PATH = '/ws/chat';
export const CHAT_WEBSOCKET_PROTOCOL = 'canvas-chat-v1';

export const CHAT_WEBSOCKET_CLOSE_CODES = {
  unauthorized: 4001,
  licenseRequired: 4003,
  serviceRestart: 1012,
} as const;

export type ControlAction =
  | 'follow_up'
  | 'steer'
  | 'promote_queued_to_steer'
  | 'remove_queued_item'
  | 'abort'
  | 'replace'
  | 'compact';

export type PiRuntimeStatus = Record<string, unknown>;

export type ClientMessage =
  | { type: 'subscribe_session'; requestId?: string; sessionId: string }
  | { type: 'unsubscribe_session'; sessionId: string }
  | {
      type: 'send_message';
      requestId?: string;
      sessionId: string;
      agentId?: string;
      clientMessageId?: string;
      message: AgentMessage;
      context?: ChatRequestContext;
    }
  | {
      type: 'control';
      requestId?: string;
      sessionId: string;
      action: ControlAction;
      message?: AgentMessage;
      queueItemId?: string;
      context?: ChatRequestContext;
      focusTopic?: string;
    }
  | { type: 'get_status'; requestId?: string; sessionId: string };

export type ServerMessage =
  | { type: 'auth_success'; userId: string }
  | { type: 'auth_error'; error: string }
  | { type: 'subscribe_result'; requestId?: string; success: boolean; sessionId?: string; error?: string }
  | { type: 'send_message_result'; requestId?: string; success: boolean; status?: PiRuntimeStatus; error?: string }
  | { type: 'control_result'; requestId?: string; success: boolean; status?: PiRuntimeStatus; error?: string }
  | { type: 'status_result'; requestId?: string; success: boolean; status?: PiRuntimeStatus; error?: string }
  | { type: 'agent_event'; sessionId: string; event: Record<string, unknown> }
  | { type: 'session_updated'; sessionId: string; workspaceId?: string; lastMessageAt: string; title?: string }
  | { type: 'session_title_updated'; sessionId: string; title: string; titleGenerationState?: string | null }
  | { type: 'session_read'; sessionId: string; timestamp: number }
  | {
      type: 'notification';
      sessionId: string;
      sessionTitle: string;
      workspaceId?: string;
      notificationType: 'new_response' | 'tool_complete' | 'error';
      messagePreview?: string;
      lastMessageAt?: string;
      timestamp: number;
    }
  | { type: 'error'; error: string; code: string };

export type ClientMessageParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: 'INVALID_MESSAGE' | 'UNKNOWN_MESSAGE_TYPE'; error: string };

const CONTROL_ACTIONS = new Set<ControlAction>([
  'follow_up',
  'steer',
  'promote_queued_to_steer',
  'remove_queued_item',
  'abort',
  'replace',
  'compact',
]);
const CLIENT_MESSAGE_TYPES = new Set<ClientMessage['type']>([
  'subscribe_session',
  'unsubscribe_session',
  'send_message',
  'control',
  'get_status',
]);
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_COMPACTION_FOCUS_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || (
    typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
  );
}

function invalid(error: string): ClientMessageParseResult {
  return { ok: false, code: 'INVALID_MESSAGE', error };
}

/** Runtime validation at the untrusted WebSocket boundary. */
export function parseClientMessage(value: unknown): ClientMessageParseResult {
  if (!isRecord(value)) {
    return invalid('Message must be a JSON object');
  }

  if (typeof value.type !== 'string' || !CLIENT_MESSAGE_TYPES.has(value.type as ClientMessage['type'])) {
    const type = typeof value.type === 'string' ? value.type : '(missing)';
    return { ok: false, code: 'UNKNOWN_MESSAGE_TYPE', error: `Unknown message type: ${type}` };
  }

  if (!isOptionalBoundedString(value.requestId, MAX_REQUEST_ID_LENGTH)) {
    return invalid('requestId must be a non-empty bounded string');
  }
  if (!isOptionalBoundedString(value.sessionId, MAX_IDENTIFIER_LENGTH) || typeof value.sessionId !== 'string') {
    return invalid('sessionId must be a non-empty bounded string');
  }

  switch (value.type) {
    case 'subscribe_session':
    case 'unsubscribe_session':
    case 'get_status':
      return { ok: true, message: value as ClientMessage };

    case 'send_message':
      if (!isRecord(value.message)) {
        return invalid('message must be an object');
      }
      if (!isOptionalBoundedString(value.agentId, MAX_IDENTIFIER_LENGTH)) {
        return invalid('agentId must be a non-empty bounded string');
      }
      if (!isOptionalBoundedString(value.clientMessageId, MAX_IDENTIFIER_LENGTH)) {
        return invalid('clientMessageId must be a non-empty bounded string');
      }
      if (value.context !== undefined && !isRecord(value.context)) {
        return invalid('context must be an object');
      }
      return { ok: true, message: value as ClientMessage };

    case 'control':
      if (typeof value.action !== 'string' || !CONTROL_ACTIONS.has(value.action as ControlAction)) {
        return invalid('action is not supported');
      }
      if (value.message !== undefined && !isRecord(value.message)) {
        return invalid('message must be an object');
      }
      if (!isOptionalBoundedString(value.queueItemId, MAX_IDENTIFIER_LENGTH)) {
        return invalid('queueItemId must be a non-empty bounded string');
      }
      if (value.context !== undefined && !isRecord(value.context)) {
        return invalid('context must be an object');
      }
      if (!isOptionalBoundedString(value.focusTopic, MAX_COMPACTION_FOCUS_LENGTH)) {
        return invalid(`focusTopic must be a non-empty string of at most ${MAX_COMPACTION_FOCUS_LENGTH} characters`);
      }
      return { ok: true, message: value as ClientMessage };
  }

  return { ok: false, code: 'UNKNOWN_MESSAGE_TYPE', error: 'Unknown message type' };
}
