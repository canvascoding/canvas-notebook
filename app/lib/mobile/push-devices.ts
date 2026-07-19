import 'server-only';

import { randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { getLicenseInstanceId } from '@/app/lib/license/instance';

import { createPublicMobileInstanceId } from './compatibility';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const MAX_DEVICES_PER_USER = 10;
const MAX_EXPO_BATCH_SIZE = 100;

export type MobilePushPlatform = 'ios' | 'android';
export type MobileAppVariant = 'development' | 'preview' | 'production';

export type MobilePushRegistration = {
  installationId: string;
  expoPushToken: string;
  platform: MobilePushPlatform;
  appVariant: MobileAppVariant;
  preferences: {
    agentResponseReady: boolean;
  };
};

export type MobilePushDeviceStatus = {
  registered: boolean;
  enabled: boolean;
  platform: MobilePushPlatform | null;
  appVariant: MobileAppVariant | null;
  preferences: {
    agentResponseReady: boolean;
    previews: false;
  };
  registeredAt: string | null;
  lastDeliveryAt: string | null;
  lastErrorCode: string | null;
};

type MobilePushDeviceRow = {
  id: string;
  expo_push_token: string;
  platform: MobilePushPlatform;
  app_variant: MobileAppVariant;
  enabled: number | boolean;
  agent_response_ready: number | boolean;
  last_registered_at: number | string;
  last_delivery_at: number | string | null;
  last_error_code: string | null;
};

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  priority: 'default';
  channelId: 'canvas-activity';
  data: {
    type: 'agent.response_ready';
    instanceId: string;
    workspaceId: string;
    sessionId: string;
  };
};

type ExpoPushTicket = {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: {
    error?: unknown;
  };
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

function requiredString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== 'string') {
    throw new MobilePushDeviceError(`${field} is required.`, 400, 'INVALID_DEVICE');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MobilePushDeviceError(`${field} is invalid.`, 400, 'INVALID_DEVICE');
  }
  return normalized;
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
  const preferences = isRecord(value.preferences) ? value.preferences : {};
  const agentResponseReady = preferences.agentResponseReady;
  if (agentResponseReady !== undefined && typeof agentResponseReady !== 'boolean') {
    throw new MobilePushDeviceError('preferences are invalid.', 400, 'INVALID_DEVICE');
  }
  return {
    installationId,
    expoPushToken,
    platform: value.platform,
    appVariant: value.appVariant as MobileAppVariant,
    preferences: { agentResponseReady: agentResponseReady !== false },
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

function deviceStatus(row: MobilePushDeviceRow | undefined): MobilePushDeviceStatus {
  if (!row) {
    return {
      registered: false,
      enabled: false,
      platform: null,
      appVariant: null,
      preferences: { agentResponseReady: false, previews: false },
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
      previews: false,
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

export async function getMobilePushDeviceStatus(input: {
  userId: string;
  installationId: string;
}): Promise<MobilePushDeviceStatus> {
  return withConnection(async (connection) => {
    const row = await connection.get(
      `SELECT id, expo_push_token, platform, app_variant, enabled, agent_response_ready,
        last_registered_at, last_delivery_at, last_error_code
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
        [input.userId, now],
      );
      const existing = await connection.get(
        'SELECT id FROM mobile_push_devices WHERE user_id = ? AND installation_id = ?',
        [input.userId, input.registration.installationId],
      );
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
      await connection.run(
        `INSERT INTO mobile_push_devices (
          id, installation_id, user_id, auth_session_id, expo_push_token, platform,
          app_variant, enabled, agent_response_ready, preview_enabled,
          last_registered_at, last_delivery_at, last_error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, NULL, NULL, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          user_id = excluded.user_id,
          auth_session_id = excluded.auth_session_id,
          expo_push_token = excluded.expo_push_token,
          platform = excluded.platform,
          app_variant = excluded.app_variant,
          enabled = 1,
          agent_response_ready = excluded.agent_response_ready,
          preview_enabled = 0,
          last_registered_at = excluded.last_registered_at,
          last_error_code = NULL,
          updated_at = excluded.updated_at`,
        [
          `mpd_${randomUUID()}`,
          input.registration.installationId,
          input.userId,
          input.authSessionId,
          input.registration.expoPushToken,
          input.registration.platform,
          input.registration.appVariant,
          input.registration.preferences.agentResponseReady ? 1 : 0,
          now,
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
      `SELECT id, expo_push_token, platform, app_variant, enabled, agent_response_ready,
        last_registered_at, last_delivery_at, last_error_code
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

export function createAgentResponseReadyMessages(input: {
  tokens: string[];
  instanceId: string;
  workspaceId: string;
  sessionId: string;
}): ExpoPushMessage[] {
  return input.tokens.map((token) => ({
    to: token,
    title: 'Canvas Notebook',
    body: 'Your agent has finished a response.',
    sound: 'default',
    priority: 'default',
    channelId: 'canvas-activity',
    data: {
      type: 'agent.response_ready',
      instanceId: input.instanceId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    },
  }));
}

async function updateDeliveryResult(
  connection: SqlConnection,
  row: MobilePushDeviceRow,
  ticket: ExpoPushTicket,
): Promise<void> {
  const now = Date.now();
  if (ticket.status === 'ok') {
    await connection.run(
      `UPDATE mobile_push_devices
       SET last_delivery_at = ?, last_error_code = NULL, updated_at = ?
       WHERE id = ?`,
      [now, now, row.id],
    );
    return;
  }
  const errorCode = typeof ticket.details?.error === 'string'
    ? ticket.details.error.slice(0, 120)
    : 'EXPO_PUSH_ERROR';
  await connection.run(
    `UPDATE mobile_push_devices
     SET enabled = ?, last_error_code = ?, updated_at = ?
     WHERE id = ?`,
    [errorCode === 'DeviceNotRegistered' ? 0 : 1, errorCode, now, row.id],
  );
}

export async function sendAgentResponseReadyPush(input: {
  userId: string;
  workspaceId: string;
  sessionId: string;
  instanceId?: string;
  fetcher?: typeof fetch;
}): Promise<{ attempted: number; accepted: number }> {
  const fetcher = input.fetcher || fetch;
  return withConnection(async (connection) => {
    const rows = await connection.all(
      `SELECT mobile_push_devices.id, mobile_push_devices.expo_push_token,
        mobile_push_devices.platform, mobile_push_devices.app_variant,
        mobile_push_devices.enabled, mobile_push_devices.agent_response_ready,
        mobile_push_devices.last_registered_at, mobile_push_devices.last_delivery_at,
        mobile_push_devices.last_error_code
       FROM mobile_push_devices
       INNER JOIN session ON session.id = mobile_push_devices.auth_session_id
       WHERE mobile_push_devices.user_id = ?
         AND mobile_push_devices.enabled = 1
         AND mobile_push_devices.agent_response_ready = 1
         AND session.user_id = mobile_push_devices.user_id
         AND session.expires_at > ?`,
      [input.userId, Date.now()],
    ) as MobilePushDeviceRow[];
    let accepted = 0;

    for (let offset = 0; offset < rows.length; offset += MAX_EXPO_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + MAX_EXPO_BATCH_SIZE);
      const messages = createAgentResponseReadyMessages({
        tokens: batch.map((row) => row.expo_push_token),
        instanceId: input.instanceId || createPublicMobileInstanceId(getLicenseInstanceId()),
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      });
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      };
      const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const response = await fetcher(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        throw new Error(`Expo push service returned HTTP ${response.status}.`);
      }
      const payload = await response.json() as { data?: ExpoPushTicket[] | ExpoPushTicket };
      const tickets = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
      if (tickets.length !== batch.length) {
        throw new Error('Expo push service returned an unexpected ticket count.');
      }
      for (let index = 0; index < batch.length; index += 1) {
        const ticket = tickets[index];
        if (ticket?.status === 'ok') accepted += 1;
        await updateDeliveryResult(connection, batch[index], ticket || {});
      }
    }
    return { attempted: rows.length, accepted };
  });
}
