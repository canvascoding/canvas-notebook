import 'server-only';

import { readScopedEnvState, replaceScopedEnvEntries } from '@/app/lib/integrations/env-config';
import { isManagedSystemEmailAvailable } from '@/app/lib/email/managed-system-email-client';

const SYSTEM_SMTP_KEYS = {
  host: 'CANVAS_SYSTEM_SMTP_HOST',
  port: 'CANVAS_SYSTEM_SMTP_PORT',
  secure: 'CANVAS_SYSTEM_SMTP_SECURE',
  username: 'CANVAS_SYSTEM_SMTP_USERNAME',
  password: 'CANVAS_SYSTEM_SMTP_PASSWORD',
  fromAddress: 'CANVAS_SYSTEM_EMAIL_FROM',
  fromName: 'CANVAS_SYSTEM_EMAIL_FROM_NAME',
  replyTo: 'CANVAS_SYSTEM_EMAIL_REPLY_TO',
  deliveryMode: 'CANVAS_SYSTEM_EMAIL_DELIVERY_MODE',
} as const;

const SYSTEM_SMTP_ENV_KEY_SET = new Set<string>(Object.values(SYSTEM_SMTP_KEYS));

export type SystemSmtpConfiguration = {
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  };
  from: {
    address: string;
    name: string | null;
  };
  replyTo: string | null;
};

export type SystemSmtpConfigurationInput = {
  host?: unknown;
  port?: unknown;
  secure?: unknown;
  username?: unknown;
  password?: unknown;
  fromAddress?: unknown;
  fromName?: unknown;
  replyTo?: unknown;
};

export type SystemEmailDeliveryMode = 'managed' | 'local' | 'disabled';

export type SystemSmtpConfigurationStatus = {
  configured: boolean;
  complete: boolean;
  passwordConfigured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  username: string | null;
  fromAddress: string | null;
  fromName: string | null;
  replyTo: string | null;
  configurationError: string | null;
  deliveryMode: SystemEmailDeliveryMode;
  managedAvailable: boolean;
};

type SystemSmtpValues = Record<keyof typeof SYSTEM_SMTP_KEYS, string>;

function normalizeHost(value: unknown, label = 'SMTP host'): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized) || /[/?#\\]/u.test(normalized)) {
    throw new Error(`${label} must be a host name or IP address, not a URL.`);
  }
  return normalized;
}

function normalizePort(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw new Error('SMTP port must be a port between 1 and 65535.');
  }
  return numeric;
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false.`);
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function normalizeEmailAddress(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new Error(`${label} must be a valid email address.`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Optional SMTP values must be text.');
  const normalized = value.trim();
  return normalized || null;
}

function valuesFromEntries(entries: Array<{ key: string; value: string }>): SystemSmtpValues {
  const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
  return Object.fromEntries(
    Object.entries(SYSTEM_SMTP_KEYS).map(([name, key]) => [name, byKey.get(key) ?? '']),
  ) as SystemSmtpValues;
}

function parseConfiguredValues(values: SystemSmtpValues): SystemSmtpConfiguration | null {
  const hasAnyValue = Object.entries(values).some(([key, value]) => key !== 'deliveryMode' && value.trim().length > 0);
  if (!hasAnyValue) return null;

  return {
    smtp: {
      host: normalizeHost(values.host),
      port: normalizePort(values.port),
      secure: normalizeBoolean(values.secure, 'SMTP secure'),
      username: normalizeRequiredString(values.username, 'SMTP username'),
      password: normalizeRequiredString(values.password, 'SMTP password'),
    },
    from: {
      address: normalizeEmailAddress(values.fromAddress, 'Sender email address'),
      name: normalizeOptionalString(values.fromName),
    },
    replyTo: values.replyTo.trim() ? normalizeEmailAddress(values.replyTo, 'Reply-to email address') : null,
  };
}

function hasLocalSmtpValues(values: SystemSmtpValues): boolean {
  return Object.entries(values).some(([key, value]) => key !== 'deliveryMode' && value.trim().length > 0);
}

function resolveDeliveryMode(values: SystemSmtpValues): SystemEmailDeliveryMode {
  const configured = values.deliveryMode.trim().toLowerCase();
  if (configured === 'managed' || configured === 'local' || configured === 'disabled') return configured;
  if (isManagedSystemEmailAvailable() && !hasLocalSmtpValues(values)) return 'managed';
  return 'local';
}

export async function getSystemSmtpConfiguration(): Promise<SystemSmtpConfiguration | null> {
  const state = await readScopedEnvState('integrations');
  return parseConfiguredValues(valuesFromEntries(state.entries));
}

export async function getSystemSmtpConfigurationStatus(): Promise<SystemSmtpConfigurationStatus> {
  const state = await readScopedEnvState('integrations');
  const values = valuesFromEntries(state.entries);
  let configurationError: string | null = null;
  let configuration: SystemSmtpConfiguration | null = null;

  try {
    configuration = parseConfiguredValues(values);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : 'System SMTP configuration is incomplete.';
  }

  const parsedPort = Number.parseInt(values.port, 10);
  return {
    configured: Boolean(configuration),
    complete: Boolean(configuration),
    passwordConfigured: Boolean(values.password),
    host: values.host.trim() || null,
    port: Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null,
    secure: values.secure === 'true' ? true : values.secure === 'false' ? false : null,
    username: values.username.trim() || null,
    fromAddress: values.fromAddress.trim().toLowerCase() || null,
    fromName: values.fromName.trim() || null,
    replyTo: values.replyTo.trim().toLowerCase() || null,
    configurationError,
    deliveryMode: resolveDeliveryMode(values),
    managedAvailable: isManagedSystemEmailAvailable(),
  };
}

export async function saveSystemSmtpConfiguration(input: SystemSmtpConfigurationInput): Promise<SystemSmtpConfigurationStatus> {
  const state = await readScopedEnvState('integrations');
  const existingValues = valuesFromEntries(state.entries);
  const passwordInput = typeof input.password === 'string' ? input.password : '';
  const next: SystemSmtpValues = {
    host: normalizeHost(input.host),
    port: String(normalizePort(input.port)),
    secure: String(normalizeBoolean(input.secure, 'SMTP secure')),
    username: normalizeRequiredString(input.username, 'SMTP username'),
    password: passwordInput || existingValues.password,
    fromAddress: normalizeEmailAddress(input.fromAddress, 'Sender email address'),
    fromName: normalizeOptionalString(input.fromName) || '',
    replyTo: normalizeOptionalString(input.replyTo)
      ? normalizeEmailAddress(input.replyTo, 'Reply-to email address')
      : '',
    deliveryMode: 'local',
  };
  parseConfiguredValues(next);

  const remaining = state.entries
    .filter((entry) => !SYSTEM_SMTP_ENV_KEY_SET.has(entry.key))
    .map((entry) => ({ key: entry.key, value: entry.value }));
  const entries = [
    ...remaining,
    ...Object.entries(SYSTEM_SMTP_KEYS).map(([name, key]) => ({
      key,
      value: next[name as keyof SystemSmtpValues],
    })),
  ];
  await replaceScopedEnvEntries('integrations', entries);
  return getSystemSmtpConfigurationStatus();
}

export async function setSystemEmailDeliveryMode(mode: SystemEmailDeliveryMode): Promise<SystemSmtpConfigurationStatus> {
  const state = await readScopedEnvState('integrations');
  const remaining = state.entries
    .filter((entry) => !SYSTEM_SMTP_ENV_KEY_SET.has(entry.key))
    .map((entry) => ({ key: entry.key, value: entry.value }));
  await replaceScopedEnvEntries('integrations', [
    ...remaining,
    { key: SYSTEM_SMTP_KEYS.deliveryMode, value: mode },
    ...state.entries
      .filter((entry) => SYSTEM_SMTP_ENV_KEY_SET.has(entry.key) && entry.key !== SYSTEM_SMTP_KEYS.deliveryMode)
      .map((entry) => ({ key: entry.key, value: entry.value })),
  ]);
  return getSystemSmtpConfigurationStatus();
}

export async function clearSystemSmtpConfiguration(): Promise<SystemSmtpConfigurationStatus> {
  const state = await readScopedEnvState('integrations');
  await replaceScopedEnvEntries(
    'integrations',
    state.entries
      .filter((entry) => !SYSTEM_SMTP_ENV_KEY_SET.has(entry.key))
      .map((entry) => ({ key: entry.key, value: entry.value })),
  );
  return getSystemSmtpConfigurationStatus();
}
