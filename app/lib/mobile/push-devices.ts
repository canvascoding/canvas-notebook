import 'server-only';

import { randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { toDatabaseTimestamp } from '@/app/lib/db/timestamps';
import { getLicenseInstanceId } from '@/app/lib/license/instance';
import { getUserPreferredLocale, type UserLocale } from '@/app/lib/user-preferences';

import { createPublicMobileInstanceId } from './compatibility';
import { countMobileAppBadgeForUserId } from './app-badge';
import {
  createAgentResponseNotificationPreview,
  createAutomationRunNotificationPreview,
  createStudioPushPreviewUrl,
  STUDIO_PUSH_PREVIEW_TTL_SECONDS,
  type MobilePushNotificationPreview,
} from './push-preview';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_DEVICES_PER_USER = 10;
const MAX_EXPO_BATCH_SIZE = 100;
const MAX_EXPO_RECEIPT_BATCH_SIZE = 1_000;
const EXPO_REQUEST_ATTEMPTS = 3;
const FIRST_RECEIPT_CHECK_DELAY_MS = 15 * 60_000;
const MAX_RECEIPT_ATTEMPTS = 5;
const AGENT_RESPONSE_PUSH_DELAY_MS = 5_000;

type AgentResponsePushReadState = {
  lastMessageAt: number;
  lastViewedAt: number | null;
  lastAssistantMessageId: number;
  lastAssistantMessageContent: string;
  sessionTitle: string | null;
};

type AgentResponsePushSuppressionReason = 'missing' | 'read' | 'superseded';

const pendingAgentResponsePushes = new Map<string, Promise<{ attempted: number; accepted: number }>>();

export type MobilePushPlatform = 'ios' | 'android';
export type MobileAppVariant = 'development' | 'preview' | 'production';

export type MobilePushPreferences = {
  agentResponseReady: boolean;
  todoAttention: boolean;
  studioCompleted: boolean;
  failureAttention: boolean;
  automationRunStatus: boolean;
  previews: boolean;
};

export type MobilePushRegistration = {
  installationId: string;
  expoPushToken: string;
  platform: MobilePushPlatform;
  appVariant: MobileAppVariant;
  reactivate: boolean;
  preferences: MobilePushPreferences;
};

export type MobilePushDeviceStatus = {
  registered: boolean;
  enabled: boolean;
  platform: MobilePushPlatform | null;
  appVariant: MobileAppVariant | null;
  preferences: MobilePushPreferences;
  registeredAt: string | null;
  lastDeliveryAt: string | null;
  lastErrorCode: string | null;
};

export type MobilePushTarget =
  | {
      type: 'agent.response_ready';
      workspaceId: string;
      sessionId: string;
    }
  | {
      type: 'todo.attention';
      workspaceId: string;
      todoId: string;
    }
  | {
      type: 'email.outbox_review';
      workspaceId: string;
      draftId: string;
    }
  | {
      type: 'studio.completed';
      workspaceId: string;
      generationId: string;
      outputId?: string;
    }
  | {
      type: 'attention.failure';
      workspaceId: string;
      entityKind: 'studio' | 'automation';
      entityId: string;
    }
  | {
      type: 'automation.completed';
      workspaceId: string;
      runId: string;
      status: 'success' | 'failed';
    };

type MobilePushDeviceRow = {
  id: string;
  expo_push_token: string;
  platform: MobilePushPlatform;
  app_variant: MobileAppVariant;
  enabled: number | boolean;
  agent_response_ready: number | boolean;
  todo_attention: number | boolean;
  studio_completed: number | boolean;
  failure_attention: number | boolean;
  automation_run_status: number | boolean;
  preview_enabled: number | boolean;
  last_registered_at: number | string;
  last_delivery_at: number | string | null;
  last_error_code: string | null;
};

type MobilePushData = (MobilePushTarget & {
  instanceId: string;
}) | {
  type: 'inbox.widget_refresh';
  instanceId: string;
  widgetRefresh: true;
  responseCount?: number;
};

export type ExpoPushMessage = {
  to: string;
  title?: string;
  body?: string;
  sound?: 'default';
  priority?: 'default';
  channelId?: 'canvas-activity';
  data: MobilePushData;
  badge?: number;
  _contentAvailable?: true;
  richContent?: {
    image: string;
  };
  mutableContent?: true;
  ttl?: number;
};

type ExpoPushTicket = {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: {
    error?: unknown;
  };
};

type ExpoPushReceipt = {
  status?: unknown;
  message?: unknown;
  details?: {
    error?: unknown;
    apns?: {
      reason?: unknown;
    };
  };
};

type MobilePushDeliveryRow = {
  id: string;
  device_id: string;
  expo_ticket_id: string;
  attempt_count: number | string;
};

export class MobilePushDeviceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'MobilePushDeviceError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string') {
    throw new MobilePushDeviceError(`${field} is required.`, 400, 'INVALID_DEVICE');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MobilePushDeviceError(`${field} is invalid.`, 400, 'INVALID_DEVICE');
  }
  return normalized;
}

function parseBooleanPreference(
  preferences: Record<string, unknown>,
  key: keyof MobilePushPreferences,
  defaultValue = true,
): boolean {
  const value = preferences[key];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new MobilePushDeviceError('preferences are invalid.', 400, 'INVALID_DEVICE');
  }
  return value === undefined ? defaultValue : value;
}

export function parseMobilePushRegistration(value: unknown): MobilePushRegistration {
  if (!isRecord(value)) {
    throw new MobilePushDeviceError('Device registration is invalid.', 400, 'INVALID_DEVICE');
  }
  const installationId = requiredString(value.installationId, 'installationId', 128);
  const expoPushToken = requiredString(value.expoPushToken, 'expoPushToken', 256);
  if (!/^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/u.test(expoPushToken)) {
    throw new MobilePushDeviceError('expoPushToken is invalid.', 400, 'INVALID_PUSH_TOKEN');
  }
  if (value.platform !== 'ios' && value.platform !== 'android') {
    throw new MobilePushDeviceError('platform is invalid.', 400, 'INVALID_DEVICE');
  }
  if (!['development', 'preview', 'production'].includes(String(value.appVariant))) {
    throw new MobilePushDeviceError('appVariant is invalid.', 400, 'INVALID_DEVICE');
  }
  if (value.reactivate !== undefined && typeof value.reactivate !== 'boolean') {
    throw new MobilePushDeviceError('reactivate is invalid.', 400, 'INVALID_DEVICE');
  }
  const preferences = isRecord(value.preferences) ? value.preferences : {};
  return {
    installationId,
    expoPushToken,
    platform: value.platform,
    appVariant: value.appVariant as MobileAppVariant,
    reactivate: value.reactivate === true,
    preferences: {
      agentResponseReady: parseBooleanPreference(preferences, 'agentResponseReady'),
      todoAttention: parseBooleanPreference(preferences, 'todoAttention'),
      studioCompleted: parseBooleanPreference(preferences, 'studioCompleted'),
      failureAttention: parseBooleanPreference(preferences, 'failureAttention'),
      automationRunStatus: parseBooleanPreference(preferences, 'automationRunStatus', false),
      previews: parseBooleanPreference(preferences, 'previews', false),
    },
  };
}

export function parseMobileInstallationId(value: unknown): string {
  return requiredString(value, 'installationId', 128);
}

function timestamp(value: number | string | null): string | null {
  if (value === null) return null;
  const numeric = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return null;
  return new Date(numeric).toISOString();
}

function defaultPreferences(value: boolean): MobilePushPreferences {
  return {
    agentResponseReady: value,
    todoAttention: value,
    studioCompleted: value,
    failureAttention: value,
    automationRunStatus: value,
    previews: value,
  };
}

function deviceStatus(row: MobilePushDeviceRow | undefined): MobilePushDeviceStatus {
  if (!row) {
    return {
      registered: false,
      enabled: false,
      platform: null,
      appVariant: null,
      preferences: defaultPreferences(false),
      registeredAt: null,
      lastDeliveryAt: null,
      lastErrorCode: null,
    };
  }
  return {
    registered: true,
    enabled: Boolean(row.enabled),
    platform: row.platform,
    appVariant: row.app_variant,
    preferences: {
      agentResponseReady: Boolean(row.agent_response_ready),
      todoAttention: Boolean(row.todo_attention),
      studioCompleted: Boolean(row.studio_completed),
      failureAttention: Boolean(row.failure_attention),
      automationRunStatus: Boolean(row.automation_run_status),
      previews: Boolean(row.preview_enabled),
    },
    registeredAt: timestamp(row.last_registered_at),
    lastDeliveryAt: timestamp(row.last_delivery_at),
    lastErrorCode: row.last_error_code,
  };
}

async function withConnection<T>(callback: (connection: SqlConnection) => Promise<T>): Promise<T> {
  const connection = await openDb();
  try {
    return await callback(connection);
  } finally {
    await connection.close();
  }
}

function timestampMilliseconds(value: unknown): number | null {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadAgentResponsePushReadState(input: {
  userId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<AgentResponsePushReadState | null> {
  return withConnection(async (connection) => {
    const row = await connection.get(
      `SELECT pi_sessions.last_message_at, pi_sessions.last_viewed_at, pi_sessions.title AS session_title,
        (SELECT pi_messages.id
         FROM pi_messages
         WHERE pi_messages.pi_session_db_id = pi_sessions.id
           AND pi_messages.role = 'assistant'
         ORDER BY pi_messages.sequence DESC, pi_messages.id DESC
         LIMIT 1) AS last_assistant_message_id,
        (SELECT pi_messages.content
         FROM pi_messages
         WHERE pi_messages.pi_session_db_id = pi_sessions.id
           AND pi_messages.role = 'assistant'
         ORDER BY pi_messages.sequence DESC, pi_messages.id DESC
         LIMIT 1) AS last_assistant_message_content
       FROM pi_sessions
       WHERE user_id = ? AND session_id = ? AND workspace_id = ?
       LIMIT 1`,
      [input.userId, input.sessionId, input.workspaceId],
    ) as {
      last_message_at?: unknown;
      last_viewed_at?: unknown;
      last_assistant_message_id?: unknown;
      last_assistant_message_content?: unknown;
      session_title?: unknown;
    } | undefined;
    const lastMessageAt = timestampMilliseconds(row?.last_message_at);
    const lastViewedAt = row?.last_viewed_at === null || row?.last_viewed_at === undefined
      ? null
      : timestampMilliseconds(row.last_viewed_at);
    const lastAssistantMessageId = Number(row?.last_assistant_message_id);
    if (
      lastMessageAt === null
      || !Number.isSafeInteger(lastAssistantMessageId)
      || lastAssistantMessageId < 1
      || typeof row?.last_assistant_message_content !== 'string'
    ) {
      return null;
    }
    return {
      lastMessageAt,
      lastViewedAt,
      lastAssistantMessageId,
      lastAssistantMessageContent: row.last_assistant_message_content,
      sessionTitle: typeof row.session_title === 'string' ? row.session_title : null,
    };
  });
}

export function agentResponsePushSuppressionReason(
  expected: AgentResponsePushReadState | null,
  current: AgentResponsePushReadState | null,
): AgentResponsePushSuppressionReason | null {
  if (!expected || !current) return 'missing';
  if (
    current.lastAssistantMessageId !== expected.lastAssistantMessageId
    || current.lastMessageAt !== expected.lastMessageAt
  ) {
    return 'superseded';
  }
  if (current.lastViewedAt !== null && current.lastViewedAt >= current.lastMessageAt) return 'read';
  return null;
}

const DEVICE_SELECT = `id, expo_push_token, platform, app_variant, enabled,
  agent_response_ready, todo_attention, studio_completed, failure_attention,
  automation_run_status, preview_enabled, last_registered_at, last_delivery_at, last_error_code`;

export async function getMobilePushDeviceStatus(input: {
  userId: string;
  installationId: string;
}): Promise<MobilePushDeviceStatus> {
  return withConnection(async (connection) => {
    const row = await connection.get(
      `SELECT ${DEVICE_SELECT}
       FROM mobile_push_devices
       WHERE user_id = ? AND installation_id = ?`,
      [input.userId, input.installationId],
    ) as MobilePushDeviceRow | undefined;
    return deviceStatus(row);
  });
}

export async function registerMobilePushDevice(input: {
  userId: string;
  authSessionId: string;
  registration: MobilePushRegistration;
}): Promise<MobilePushDeviceStatus> {
  return withConnection(async (connection) => {
    const now = Date.now();
    const authNow = toDatabaseTimestamp(new Date(now));
    await connection.run('BEGIN');
    try {
      await connection.run(
        `DELETE FROM mobile_push_devices
         WHERE user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM session
             WHERE session.id = mobile_push_devices.auth_session_id
               AND session.user_id = mobile_push_devices.user_id
               AND session.expires_at > ?
           )`,
        [input.userId, authNow],
      );
      const existing = await connection.get(
        `SELECT id, expo_push_token, enabled, last_error_code
         FROM mobile_push_devices
         WHERE user_id = ? AND installation_id = ?`,
        [input.userId, input.registration.installationId],
      ) as {
        id: string;
        expo_push_token: string;
        enabled: number | boolean;
        last_error_code: string | null;
      } | undefined;
      const count = await connection.get(
        'SELECT COUNT(*) AS count FROM mobile_push_devices WHERE user_id = ?',
        [input.userId],
      ) as { count?: number | string } | undefined;
      if (!existing && Number(count?.count || 0) >= MAX_DEVICES_PER_USER) {
        throw new MobilePushDeviceError(
          'Too many mobile devices are registered for this account.',
          409,
          'DEVICE_LIMIT',
        );
      }

      await connection.run(
        'DELETE FROM mobile_push_devices WHERE expo_push_token = ? AND installation_id <> ?',
        [input.registration.expoPushToken, input.registration.installationId],
      );
      const tokenChanged = Boolean(
        existing && existing.expo_push_token !== input.registration.expoPushToken,
      );
      const shouldReactivate = !existing || tokenChanged || input.registration.reactivate;
      const enabled = shouldReactivate || Boolean(existing?.enabled);
      const lastErrorCode = shouldReactivate ? null : existing?.last_error_code || null;
      await connection.run(
        `INSERT INTO mobile_push_devices (
          id, installation_id, user_id, auth_session_id, expo_push_token, platform,
          app_variant, enabled, agent_response_ready, todo_attention, studio_completed,
          failure_attention, automation_run_status, preview_enabled, last_registered_at, last_delivery_at,
          last_error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          user_id = excluded.user_id,
          auth_session_id = excluded.auth_session_id,
          expo_push_token = excluded.expo_push_token,
          platform = excluded.platform,
          app_variant = excluded.app_variant,
          enabled = excluded.enabled,
          agent_response_ready = excluded.agent_response_ready,
          todo_attention = excluded.todo_attention,
          studio_completed = excluded.studio_completed,
          failure_attention = excluded.failure_attention,
          automation_run_status = excluded.automation_run_status,
          preview_enabled = excluded.preview_enabled,
          last_registered_at = excluded.last_registered_at,
          last_error_code = excluded.last_error_code,
          updated_at = excluded.updated_at`,
        [
          `mpd_${randomUUID()}`,
          input.registration.installationId,
          input.userId,
          input.authSessionId,
          input.registration.expoPushToken,
          input.registration.platform,
          input.registration.appVariant,
          enabled ? 1 : 0,
          input.registration.preferences.agentResponseReady ? 1 : 0,
          input.registration.preferences.todoAttention ? 1 : 0,
          input.registration.preferences.studioCompleted ? 1 : 0,
          input.registration.preferences.failureAttention ? 1 : 0,
          input.registration.preferences.automationRunStatus ? 1 : 0,
          input.registration.preferences.previews ? 1 : 0,
          now,
          lastErrorCode,
          now,
          now,
        ],
      );
      await connection.run('COMMIT');
    } catch (error) {
      await Promise.resolve(connection.run('ROLLBACK')).catch(() => undefined);
      throw error;
    }

    const row = await connection.get(
      `SELECT ${DEVICE_SELECT}
       FROM mobile_push_devices
       WHERE user_id = ? AND installation_id = ?`,
      [input.userId, input.registration.installationId],
    ) as MobilePushDeviceRow | undefined;
    return deviceStatus(row);
  });
}

export async function unregisterMobilePushDevice(input: {
  userId: string;
  installationId: string;
}): Promise<void> {
  await withConnection(async (connection) => {
    await connection.run(
      'DELETE FROM mobile_push_devices WHERE user_id = ? AND installation_id = ?',
      [input.userId, input.installationId],
    );
  });
}

function notificationBody(target: MobilePushTarget, locale: UserLocale): string {
  const isGerman = locale === 'de';
  switch (target.type) {
    case 'agent.response_ready':
      return isGerman ? 'Dein Agent hat eine Antwort fertiggestellt.' : 'Your agent has finished a response.';
    case 'todo.attention':
      return isGerman ? 'Ein Canvas-To-do benötigt deine Aufmerksamkeit.' : 'A Canvas To-do needs your attention.';
    case 'email.outbox_review':
      return isGerman ? 'Ein E-Mail-Entwurf wartet auf deine Freigabe.' : 'An email draft is waiting for your review.';
    case 'studio.completed':
      return isGerman ? 'Dein Studio-Ergebnis ist bereit.' : 'Your Studio result is ready.';
    case 'attention.failure':
      return isGerman ? 'Canvas-Arbeit benötigt deine Aufmerksamkeit.' : 'Canvas work needs your attention.';
    case 'automation.completed':
      return target.status === 'success'
        ? isGerman
          ? 'Eine geplante Automation wurde erfolgreich abgeschlossen.'
          : 'A scheduled automation completed successfully.'
        : isGerman
          ? 'Eine geplante Automation ist fehlgeschlagen.'
          : 'A scheduled automation failed.';
  }
}

export function createMobilePushMessages(input: {
  tokens: string[];
  instanceId: string;
  target: MobilePushTarget;
  notification?: MobilePushNotificationPreview;
  badge?: number;
  locale?: UserLocale;
}): ExpoPushMessage[] {
  const locale = input.locale ?? 'en';
  return input.tokens.map((token) => {
    const imageUrl = input.notification?.imageUrl;
    return {
      to: token,
      title: input.notification?.title || 'Canvas Notebook',
      body: input.notification?.body || notificationBody(input.target, locale),
      sound: 'default',
      priority: 'default',
      channelId: 'canvas-activity',
      data: {
        instanceId: input.instanceId,
        ...input.target,
      } as MobilePushData,
      ...(input.badge === undefined ? {} : { badge: input.badge }),
      ...(imageUrl ? {
        richContent: { image: imageUrl },
        mutableContent: true as const,
        ttl: STUDIO_PUSH_PREVIEW_TTL_SECONDS,
      } : {}),
    };
  });
}

/**
 * iOS only runs Expo's notification task reliably for a data-only push. This
 * is intentionally separate from the user-visible alert so the widget can
 * refresh its complete private snapshot without showing a second alert.
 */
export function createInboxWidgetRefreshMessages(input: {
  tokens: string[];
  instanceId: string;
  responseCount?: number;
}): ExpoPushMessage[] {
  return input.tokens.map((token) => ({
    to: token,
    data: {
      type: 'inbox.widget_refresh',
      instanceId: input.instanceId,
      widgetRefresh: true,
      ...(input.responseCount === undefined ? {} : { responseCount: input.responseCount }),
    },
    _contentAvailable: true as const,
  }));
}

export function createAgentResponseReadyMessages(input: {
  tokens: string[];
  instanceId: string;
  workspaceId: string;
  sessionId: string;
  notification?: MobilePushNotificationPreview;
  badge?: number;
  locale?: UserLocale;
}): ExpoPushMessage[] {
  return createMobilePushMessages({
    tokens: input.tokens,
    instanceId: input.instanceId,
    target: {
      type: 'agent.response_ready',
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    },
    notification: input.notification,
    badge: input.badge,
    locale: input.locale,
  });
}

function expoHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };
  const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

function retryDelay(attempt: number): number {
  return Math.min(250 * (2 ** attempt), 2_000);
}

function receiptRetryDelay(attempt: number): number {
  return Math.min(FIRST_RECEIPT_CHECK_DELAY_MS * (2 ** Math.max(attempt - 1, 0)), 4 * 60 * 60_000);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function postExpoWithRetry(input: {
  endpoint: string;
  body: unknown;
  fetcher: typeof fetch;
}): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < EXPO_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await input.fetcher(input.endpoint, {
        method: 'POST',
        headers: expoHeaders(),
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Expo push service returned HTTP ${response.status}.`);
      }
      lastError = new Error(`Expo push service returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /^Expo push service returned HTTP 4\d\d\.$/u.test(error.message)) {
        throw error;
      }
    }
    if (attempt + 1 < EXPO_REQUEST_ATTEMPTS) await wait(retryDelay(attempt));
  }
  throw lastError instanceof Error ? lastError : new Error('Expo push service is unavailable.');
}

function pushPreferenceColumn(target: MobilePushTarget): string {
  switch (target.type) {
    case 'agent.response_ready':
      return 'agent_response_ready';
    case 'todo.attention':
      return 'todo_attention';
    case 'email.outbox_review':
      return 'todo_attention';
    case 'studio.completed':
      return 'studio_completed';
    case 'attention.failure':
      return 'failure_attention';
    case 'automation.completed':
      return 'automation_run_status';
  }
}

function pushEntityId(target: MobilePushTarget): string {
  switch (target.type) {
    case 'agent.response_ready':
      return target.sessionId;
    case 'todo.attention':
      return target.todoId;
    case 'email.outbox_review':
      return target.draftId;
    case 'studio.completed':
      return target.generationId;
    case 'attention.failure':
      return target.entityId;
    case 'automation.completed':
      return target.runId;
  }
}

function ticketErrorCode(ticket: ExpoPushTicket | ExpoPushReceipt): string {
  const details = ticket.details as ExpoPushReceipt['details'];
  const apnsReason = details?.apns?.reason;
  if (typeof apnsReason === 'string') return apnsReason.slice(0, 120);
  return typeof ticket.details?.error === 'string'
    ? ticket.details.error.slice(0, 120)
    : 'EXPO_PUSH_ERROR';
}

function disablesPushDevice(errorCode: string): boolean {
  return errorCode === 'DeviceNotRegistered' || errorCode === 'BadDeviceToken';
}

async function recordTicketResult(input: {
  connection: SqlConnection;
  row: MobilePushDeviceRow;
  ticket: ExpoPushTicket;
  userId: string;
  target: MobilePushTarget;
  now: number;
}): Promise<boolean> {
  const { connection, row, ticket, userId, target, now } = input;
  const ticketId = typeof ticket.id === 'string' && ticket.id.trim()
    ? ticket.id.trim().slice(0, 256)
    : null;
  if (ticket.status === 'ok' && ticketId) {
    await connection.run(
      `INSERT INTO mobile_push_deliveries (
        id, device_id, user_id, category, entity_id, expo_ticket_id, status,
        attempt_count, next_receipt_check_at, receipt_at, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'ticket_accepted', 0, ?, NULL, NULL, ?, ?)`,
      [
        `mpdl_${randomUUID()}`,
        row.id,
        userId,
        target.type,
        pushEntityId(target),
        ticketId,
        now + FIRST_RECEIPT_CHECK_DELAY_MS,
        now,
        now,
      ],
    );
    await connection.run(
      `UPDATE mobile_push_devices
       SET last_error_code = NULL, updated_at = ?
       WHERE id = ?`,
      [now, row.id],
    );
    return true;
  }

  const errorCode = ticket.status === 'ok' ? 'MISSING_TICKET_ID' : ticketErrorCode(ticket);
  await connection.run(
    `INSERT INTO mobile_push_deliveries (
      id, device_id, user_id, category, entity_id, expo_ticket_id, status,
      attempt_count, next_receipt_check_at, receipt_at, last_error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'ticket_error', 0, NULL, ?, ?, ?, ?)`,
    [
      `mpdl_${randomUUID()}`,
      row.id,
      userId,
      target.type,
      pushEntityId(target),
      now,
      errorCode,
      now,
      now,
    ],
  );
  await connection.run(
    `UPDATE mobile_push_devices
     SET enabled = ?, last_error_code = ?, updated_at = ?
     WHERE id = ?`,
    [disablesPushDevice(errorCode) ? 0 : 1, errorCode, now, row.id],
  );
  return false;
}

async function sendInboxWidgetRefreshPush(input: {
  rows: MobilePushDeviceRow[];
  instanceId: string;
  responseCount?: number;
  fetcher: typeof fetch;
}): Promise<void> {
  for (let offset = 0; offset < input.rows.length; offset += MAX_EXPO_BATCH_SIZE) {
    const batch = input.rows.slice(offset, offset + MAX_EXPO_BATCH_SIZE);
    const messages = createInboxWidgetRefreshMessages({
      tokens: batch.map((row) => row.expo_push_token),
      instanceId: input.instanceId,
      responseCount: input.responseCount,
    });
    try {
      const response = await postExpoWithRetry({
        endpoint: EXPO_PUSH_ENDPOINT,
        body: messages,
        fetcher: input.fetcher,
      });
      const payload = await response.json() as { data?: ExpoPushTicket[] | ExpoPushTicket };
      const tickets = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
      if (tickets.length !== batch.length || tickets.some((ticket) => ticket.status !== 'ok')) {
        console.warn('[Mobile Push] Inbox widget refresh push was not accepted.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Expo push error.';
      console.warn('[Mobile Push] Inbox widget refresh push failed:', message);
    }
  }
}

export async function sendMobileAttentionPush(input: {
  userId: string;
  target: MobilePushTarget;
  notification?: MobilePushNotificationPreview;
  locale?: UserLocale;
  instanceId?: string;
  fetcher?: typeof fetch;
  now?: number;
}): Promise<{ attempted: number; accepted: number }> {
  const fetcher = input.fetcher || fetch;
  const preferenceColumn = pushPreferenceColumn(input.target);
  const locale = input.locale
    ?? await getUserPreferredLocale(input.userId).catch(() => 'en' as const);
  const now = input.now ?? Date.now();
  const authNow = toDatabaseTimestamp(new Date(now));
  return withConnection(async (connection) => {
    const rows = await connection.all(
      `SELECT mobile_push_devices.${DEVICE_SELECT.replaceAll(', ', ', mobile_push_devices.')}
       FROM mobile_push_devices
       INNER JOIN session ON session.id = mobile_push_devices.auth_session_id
       WHERE mobile_push_devices.user_id = ?
         AND mobile_push_devices.enabled = 1
         AND mobile_push_devices.${preferenceColumn} = 1
         AND session.user_id = mobile_push_devices.user_id
         AND session.expires_at > ?`,
      [input.userId, authNow],
    ) as MobilePushDeviceRow[];
    // A disabled alert category must stay quiet, but it must not prevent an
    // already-authorized iOS widget from receiving its private data refresh.
    // WidgetKit otherwise keeps the last snapshot until the user foregrounds
    // Canvas again.
    const widgetRows = await connection.all(
      `SELECT mobile_push_devices.${DEVICE_SELECT.replaceAll(', ', ', mobile_push_devices.')}
       FROM mobile_push_devices
       INNER JOIN session ON session.id = mobile_push_devices.auth_session_id
       WHERE mobile_push_devices.user_id = ?
         AND mobile_push_devices.enabled = 1
         AND mobile_push_devices.platform = 'ios'
         AND session.user_id = mobile_push_devices.user_id
         AND session.expires_at > ?`,
      [input.userId, authNow],
    ) as MobilePushDeviceRow[];
    let badge: number | undefined;
    if (rows.length || widgetRows.length) {
      try {
        badge = await countMobileAppBadgeForUserId(input.userId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unread count unavailable.';
        console.warn('[Mobile Push] App badge count could not be resolved:', message);
      }
    }
    const instanceId = input.instanceId || createPublicMobileInstanceId(getLicenseInstanceId());
    let accepted = 0;

    for (let offset = 0; offset < rows.length; offset += MAX_EXPO_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + MAX_EXPO_BATCH_SIZE);
      const messages = batch.flatMap((row) => createMobilePushMessages({
        tokens: [row.expo_push_token],
        instanceId,
        target: input.target,
        notification: Boolean(row.preview_enabled) ? input.notification : undefined,
        badge,
        locale,
      }));
      const response = await postExpoWithRetry({
        endpoint: EXPO_PUSH_ENDPOINT,
        body: messages,
        fetcher,
      });
      const payload = await response.json() as { data?: ExpoPushTicket[] | ExpoPushTicket };
      const tickets = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
      if (tickets.length !== batch.length) {
        throw new Error('Expo push service returned an unexpected ticket count.');
      }
      for (let index = 0; index < batch.length; index += 1) {
        if (await recordTicketResult({
          connection,
          row: batch[index],
          ticket: tickets[index] || {},
          userId: input.userId,
          target: input.target,
          now,
        })) {
          accepted += 1;
        }
      }
    }
    if (widgetRows.length) {
      await sendInboxWidgetRefreshPush({
        rows: widgetRows,
        instanceId,
        responseCount: badge,
        fetcher,
      });
    }
    return { attempted: rows.length, accepted };
  });
}

export async function sendAgentResponseReadyPush(input: {
  userId: string;
  workspaceId: string;
  sessionId: string;
  instanceId?: string;
  fetcher?: typeof fetch;
  delayMs?: number;
}): Promise<{ attempted: number; accepted: number }> {
  const expected = await loadAgentResponsePushReadState(input);
  if (!expected) {
    console.log(`[Mobile Push] Agent response suppressed (missing): sessionId=${input.sessionId}`);
    return { attempted: 0, accepted: 0 };
  }
  const initialSuppression = agentResponsePushSuppressionReason(expected, expected);
  if (initialSuppression) {
    console.log(`[Mobile Push] Agent response suppressed (${initialSuppression}): sessionId=${input.sessionId}`);
    return { attempted: 0, accepted: 0 };
  }
  const key = `${input.userId}\u001f${input.workspaceId}\u001f${input.sessionId}\u001f${expected.lastAssistantMessageId}`;
  const pending = pendingAgentResponsePushes.get(key);
  if (pending) return pending;

  const delivery = (async () => {
    await wait(Math.max(0, input.delayMs ?? AGENT_RESPONSE_PUSH_DELAY_MS));
    const current = await loadAgentResponsePushReadState(input);
    const suppression = agentResponsePushSuppressionReason(expected, current);
    if (suppression) {
      console.log(`[Mobile Push] Agent response suppressed (${suppression}): sessionId=${input.sessionId}`);
      return { attempted: 0, accepted: 0 };
    }
    const locale = await getUserPreferredLocale(input.userId).catch(() => 'en' as const);
    return sendMobileAttentionPush({
      userId: input.userId,
      instanceId: input.instanceId,
      fetcher: input.fetcher,
      notification: createAgentResponseNotificationPreview({
        sessionTitle: current?.sessionTitle || null,
        serializedMessage: current?.lastAssistantMessageContent || '',
        locale,
      }),
      locale,
      target: {
        type: 'agent.response_ready',
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      },
    });
  })();
  pendingAgentResponsePushes.set(key, delivery);
  try {
    return await delivery;
  } finally {
    if (pendingAgentResponsePushes.get(key) === delivery) pendingAgentResponsePushes.delete(key);
  }
}

export async function sendTodoAttentionPush(input: {
  userId: string;
  workspaceId: string;
  todoId: string;
}): Promise<{ attempted: number; accepted: number }> {
  return sendMobileAttentionPush({
    userId: input.userId,
    target: { type: 'todo.attention', workspaceId: input.workspaceId, todoId: input.todoId },
  });
}

export async function sendWorkspaceOutboxReviewPush(input: {
  userId: string;
  workspaceId: string;
  draftId: string;
  subject: string;
}): Promise<{ attempted: number; accepted: number }> {
  const locale = await getUserPreferredLocale(input.userId).catch(() => 'en' as const);
  const isGerman = locale === 'de';
  return sendMobileAttentionPush({
    userId: input.userId,
    locale,
    target: { type: 'email.outbox_review', workspaceId: input.workspaceId, draftId: input.draftId },
    notification: {
      title: isGerman ? 'E-Mail-Freigabe erforderlich' : 'Email review required',
      body: input.subject || (isGerman ? 'Ein Entwurf wartet in der Outbox.' : 'A draft is waiting in the outbox.'),
    },
  });
}

export async function sendStudioCompletedPush(input: {
  userId: string;
  workspaceId: string;
  generationId: string;
  previewOutputId?: string;
}): Promise<{ attempted: number; accepted: number }> {
  const locale = await getUserPreferredLocale(input.userId).catch(() => 'en' as const);
  const isGerman = locale === 'de';
  const imageUrl = input.previewOutputId
    ? createStudioPushPreviewUrl({ outputId: input.previewOutputId })
    : null;
  return sendMobileAttentionPush({
    userId: input.userId,
    notification: {
      title: imageUrl
        ? isGerman ? 'Studio-Bild bereit' : 'Studio image ready'
        : isGerman ? 'Studio-Ergebnis bereit' : 'Studio result ready',
      body: isGerman ? 'Dein Studio-Ergebnis ist bereit.' : 'Your Studio result is ready.',
      ...(imageUrl ? { imageUrl } : {}),
    },
    locale,
    target: {
      type: 'studio.completed',
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      ...(input.previewOutputId ? { outputId: input.previewOutputId } : {}),
    },
  });
}

export async function sendFailureAttentionPush(input: {
  userId: string;
  workspaceId: string;
  entityKind: 'studio' | 'automation';
  entityId: string;
}): Promise<{ attempted: number; accepted: number }> {
  const locale = await getUserPreferredLocale(input.userId).catch(() => 'en' as const);
  return sendMobileAttentionPush({
    userId: input.userId,
    locale,
    target: {
      type: 'attention.failure',
      workspaceId: input.workspaceId,
      entityKind: input.entityKind,
      entityId: input.entityId,
    },
  });
}

export async function sendAutomationRunStatusPush(input: {
  userId: string;
  workspaceId: string;
  runId: string;
  jobName: string;
  status: 'success' | 'failed';
  instanceId?: string;
  fetcher?: typeof fetch;
  now?: number;
}): Promise<{ attempted: number; accepted: number }> {
  const locale = await getUserPreferredLocale(input.userId).catch(() => 'en' as const);
  return sendMobileAttentionPush({
    userId: input.userId,
    instanceId: input.instanceId,
    fetcher: input.fetcher,
    now: input.now,
    notification: createAutomationRunNotificationPreview({
      jobName: input.jobName,
      status: input.status,
      locale,
    }),
    locale,
    target: {
      type: 'automation.completed',
      workspaceId: input.workspaceId,
      runId: input.runId,
      status: input.status,
    },
  });
}

export async function pollMobilePushReceipts(input: {
  userId: string;
  fetcher?: typeof fetch;
  now?: number;
  limit?: number;
}): Promise<{ checked: number; delivered: number; failed: number; pending: number }> {
  const fetcher = input.fetcher || fetch;
  const now = input.now ?? Date.now();
  const limit = Math.min(Math.max(input.limit ?? MAX_EXPO_RECEIPT_BATCH_SIZE, 1), MAX_EXPO_RECEIPT_BATCH_SIZE);
  return withConnection(async (connection) => {
    const rows = await connection.all(
      `SELECT id, device_id, expo_ticket_id, attempt_count
       FROM mobile_push_deliveries
       WHERE user_id = ?
         AND status = 'ticket_accepted'
         AND next_receipt_check_at IS NOT NULL
         AND next_receipt_check_at <= ?
       ORDER BY next_receipt_check_at ASC, id ASC
       LIMIT ?`,
      [input.userId, now, limit],
    ) as MobilePushDeliveryRow[];
    if (rows.length === 0) return { checked: 0, delivered: 0, failed: 0, pending: 0 };

    const response = await postExpoWithRetry({
      endpoint: EXPO_RECEIPTS_ENDPOINT,
      body: { ids: rows.map((row) => row.expo_ticket_id) },
      fetcher,
    });
    const payload = await response.json() as { data?: Record<string, ExpoPushReceipt> };
    const receipts = isRecord(payload.data) ? payload.data as Record<string, ExpoPushReceipt> : {};
    let delivered = 0;
    let failed = 0;
    let pending = 0;

    for (const row of rows) {
      const receipt = receipts[row.expo_ticket_id];
      if (!receipt) {
        const attemptCount = Number(row.attempt_count || 0) + 1;
        if (attemptCount >= MAX_RECEIPT_ATTEMPTS) {
          await connection.run(
            `UPDATE mobile_push_deliveries
             SET status = 'receipt_timeout', attempt_count = ?, next_receipt_check_at = NULL,
               last_error_code = 'RECEIPT_TIMEOUT', updated_at = ?
             WHERE id = ?`,
            [attemptCount, now, row.id],
          );
          failed += 1;
        } else {
          await connection.run(
            `UPDATE mobile_push_deliveries
             SET attempt_count = ?, next_receipt_check_at = ?, updated_at = ?
             WHERE id = ?`,
            [attemptCount, now + receiptRetryDelay(attemptCount), now, row.id],
          );
          pending += 1;
        }
        continue;
      }

      if (receipt.status === 'ok') {
        await connection.run(
          `UPDATE mobile_push_deliveries
           SET status = 'receipt_ok', next_receipt_check_at = NULL, receipt_at = ?,
             last_error_code = NULL, updated_at = ?
           WHERE id = ?`,
          [now, now, row.id],
        );
        await connection.run(
          `UPDATE mobile_push_devices
           SET last_delivery_at = ?, last_error_code = NULL, updated_at = ?
           WHERE id = ?`,
          [now, now, row.device_id],
        );
        delivered += 1;
        continue;
      }

      const errorCode = ticketErrorCode(receipt);
      await connection.run(
        `UPDATE mobile_push_deliveries
         SET status = 'receipt_error', next_receipt_check_at = NULL, receipt_at = ?,
           last_error_code = ?, updated_at = ?
         WHERE id = ?`,
        [now, errorCode, now, row.id],
      );
      await connection.run(
        `UPDATE mobile_push_devices
         SET enabled = ?, last_error_code = ?, updated_at = ?
         WHERE id = ?`,
        [disablesPushDevice(errorCode) ? 0 : 1, errorCode, now, row.device_id],
      );
      failed += 1;
    }

    return { checked: rows.length, delivered, failed, pending };
  });
}
