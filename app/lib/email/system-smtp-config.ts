import 'server-only';

import { mutateScopedEnvEntries, readScopedEnvState } from '@/app/lib/integrations/env-config';
import { isManagedSystemEmailAvailable } from '@/app/lib/email/managed-system-email-client';
import { SYSTEM_EMAIL_ENV_KEYS, isSystemEmailEnvKey as isSystemEmailEnvKeyInternal } from '@/app/lib/email/system-email-keys';
import {
  normalizeOptionalSmtpString,
  normalizeRequiredSmtpString,
  normalizeSmtpBoolean,
  normalizeSmtpEmailAddress,
  normalizeSmtpHost,
  normalizeSmtpPort,
  normalizeSmtpTlsMode,
  secureFromTlsMode,
  type SmtpTlsMode,
} from '@/app/lib/email/smtp-configuration';

export const SYSTEM_SMTP_KEYS = {
  host: SYSTEM_EMAIL_ENV_KEYS[0],
  port: SYSTEM_EMAIL_ENV_KEYS[1],
  secure: SYSTEM_EMAIL_ENV_KEYS[2],
  username: SYSTEM_EMAIL_ENV_KEYS[3],
  password: SYSTEM_EMAIL_ENV_KEYS[4],
  fromAddress: SYSTEM_EMAIL_ENV_KEYS[5],
  fromName: SYSTEM_EMAIL_ENV_KEYS[6],
  replyTo: SYSTEM_EMAIL_ENV_KEYS[7],
  deliveryMode: SYSTEM_EMAIL_ENV_KEYS[8],
} as const;

export const SYSTEM_SMTP_ENV_KEY_SET = new Set<string>(Object.values(SYSTEM_SMTP_KEYS));

export function isSystemEmailEnvKey(key: string): boolean {
  return isSystemEmailEnvKeyInternal(key);
}

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
  tlsMode?: unknown;
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
  tlsMode: SmtpTlsMode | null;
  username: string | null;
  fromAddress: string | null;
  fromName: string | null;
  replyTo: string | null;
  configurationError: string | null;
  deliveryMode: SystemEmailDeliveryMode;
  managedAvailable: boolean;
};

type SystemSmtpValues = Record<keyof typeof SYSTEM_SMTP_KEYS, string>;

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
      host: normalizeSmtpHost(values.host),
      port: normalizeSmtpPort(values.port),
      secure: normalizeSmtpBoolean(values.secure, 'SMTP secure'),
      username: normalizeRequiredSmtpString(values.username, 'SMTP username'),
      password: normalizeRequiredSmtpString(values.password, 'SMTP password'),
    },
    from: {
      address: normalizeSmtpEmailAddress(values.fromAddress, 'Sender email address'),
      name: normalizeOptionalSmtpString(values.fromName),
    },
    replyTo: values.replyTo.trim() ? normalizeSmtpEmailAddress(values.replyTo, 'Reply-to email address') : null,
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

  const parsedPort = /^\d+$/u.test(values.port.trim()) ? Number(values.port) : NaN;
  const tlsMode: SmtpTlsMode | null = values.secure === 'true' ? 'implicit_tls' : values.secure === 'false' ? 'starttls' : null;
  return {
    configured: Boolean(configuration),
    complete: Boolean(configuration),
    passwordConfigured: Boolean(values.password),
    host: values.host.trim() || null,
    port: Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : null,
    secure: values.secure === 'true' ? true : values.secure === 'false' ? false : null,
    tlsMode,
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
  await mutateScopedEnvEntries('integrations', (entries) => {
    const existingValues = valuesFromEntries(entries);
    const passwordInput = typeof input.password === 'string' ? input.password : '';
    const next: SystemSmtpValues = {
      host: normalizeSmtpHost(input.host),
      port: String(normalizeSmtpPort(input.port)),
      secure: String(secureFromTlsMode(normalizeSmtpTlsMode(input.tlsMode, input.secure))),
      username: normalizeRequiredSmtpString(input.username, 'SMTP username'),
      password: passwordInput || existingValues.password,
      fromAddress: normalizeSmtpEmailAddress(input.fromAddress, 'Sender email address'),
      fromName: normalizeOptionalSmtpString(input.fromName) || '',
      replyTo: normalizeOptionalSmtpString(input.replyTo)
        ? normalizeSmtpEmailAddress(input.replyTo, 'Reply-to email address')
        : '',
      deliveryMode: 'local',
    };
    parseConfiguredValues(next);
    return [
      ...entries.filter((entry) => !SYSTEM_SMTP_ENV_KEY_SET.has(entry.key)),
      ...Object.entries(SYSTEM_SMTP_KEYS).map(([name, key]) => ({ key, value: next[name as keyof SystemSmtpValues] })),
    ];
  });
  return getSystemSmtpConfigurationStatus();
}

export async function setSystemEmailDeliveryMode(mode: SystemEmailDeliveryMode): Promise<SystemSmtpConfigurationStatus> {
  await mutateScopedEnvEntries('integrations', (entries) => [
    ...entries.filter((entry) => entry.key !== SYSTEM_SMTP_KEYS.deliveryMode),
    { key: SYSTEM_SMTP_KEYS.deliveryMode, value: mode },
  ]);
  return getSystemSmtpConfigurationStatus();
}

export async function clearSystemSmtpConfiguration(): Promise<SystemSmtpConfigurationStatus> {
  await mutateScopedEnvEntries('integrations', (entries) => [
    ...entries.filter((entry) => !SYSTEM_SMTP_ENV_KEY_SET.has(entry.key)),
    { key: SYSTEM_SMTP_KEYS.deliveryMode, value: 'disabled' },
  ]);
  return getSystemSmtpConfigurationStatus();
}
