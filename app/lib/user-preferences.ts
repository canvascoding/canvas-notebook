import 'server-only';

import { routing } from '@/i18n/routing';
import {
  readSettingsTextFileIfExists,
  writeSettingsJsonFileAtomic,
} from '@/app/lib/settings-storage';

const USER_PREFERENCES_FILE = 'user-preferences.json';
const SUPPORTED_LOCALES = routing.locales as readonly string[];

export type UserLocale = typeof routing.locales[number];

export type UserPreferences = {
  emailAllowRemoteImages?: boolean;
  emailRemoteImageAllowedSenders?: string[];
  locale?: UserLocale;
};

type UserPreferencesFile = {
  version: 1;
  users: Record<string, UserPreferences>;
};

function emptyPreferencesFile(): UserPreferencesFile {
  return {
    version: 1,
    users: {},
  };
}

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error('User ID is required.');
  }
  return normalized;
}

function normalizeEmailAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const match = item.match(/<([^<>@\s]+@[^<>@\s]+)>/u) || item.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu);
    const normalized = (match?.[1] || item).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/iu.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
    if (entries.length >= 500) break;
  }
  return entries;
}

export function normalizeUserLocale(value: unknown): UserLocale | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().split(/[-_]/u)[0];
  if (!SUPPORTED_LOCALES.includes(normalized)) return null;
  return normalized as UserLocale;
}

function normalizePreferences(value: unknown): UserPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as { emailAllowRemoteImages?: unknown; emailRemoteImageAllowedSenders?: unknown; locale?: unknown };
  const locale = normalizeUserLocale(record.locale);
  const emailRemoteImageAllowedSenders = normalizeEmailAddressList(record.emailRemoteImageAllowedSenders);
  return {
    ...(typeof record.emailAllowRemoteImages === 'boolean' ? { emailAllowRemoteImages: record.emailAllowRemoteImages } : {}),
    ...(emailRemoteImageAllowedSenders.length > 0 ? { emailRemoteImageAllowedSenders } : {}),
    ...(locale ? { locale } : {}),
  };
}

function parsePreferencesFile(content: string | null): UserPreferencesFile {
  if (!content?.trim()) return emptyPreferencesFile();

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyPreferencesFile();
    }

    const rawUsers = (parsed as { users?: unknown }).users;
    if (!rawUsers || typeof rawUsers !== 'object' || Array.isArray(rawUsers)) {
      return emptyPreferencesFile();
    }

    const users = Object.fromEntries(
      Object.entries(rawUsers)
        .filter(([userId]) => userId.trim())
        .map(([userId, preferences]) => [userId, normalizePreferences(preferences)]),
    );

    return {
      version: 1,
      users,
    };
  } catch {
    return emptyPreferencesFile();
  }
}

async function readPreferencesFile(): Promise<UserPreferencesFile> {
  const { content } = await readSettingsTextFileIfExists(USER_PREFERENCES_FILE);
  return parsePreferencesFile(content);
}

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const normalizedUserId = normalizeUserId(userId);
  const preferences = await readPreferencesFile();
  return preferences.users[normalizedUserId] ?? {};
}

export async function getUserPreferredLocale(userId: string): Promise<UserLocale> {
  const preferences = await getUserPreferences(userId);
  return preferences.locale ?? routing.defaultLocale;
}

export async function updateUserPreferences(
  userId: string,
  updates: UserPreferences,
): Promise<UserPreferences> {
  const normalizedUserId = normalizeUserId(userId);
  const preferencesFile = await readPreferencesFile();
  const nextPreferences: UserPreferences = {
    ...(preferencesFile.users[normalizedUserId] ?? {}),
  };

  if ('locale' in updates) {
    if (updates.locale === undefined) {
      delete nextPreferences.locale;
    } else {
      const locale = normalizeUserLocale(updates.locale);
      if (!locale) {
        throw new Error('Unsupported locale.');
      }
      nextPreferences.locale = locale;
    }
  }

  if ('emailAllowRemoteImages' in updates) {
    if (updates.emailAllowRemoteImages === undefined) {
      delete nextPreferences.emailAllowRemoteImages;
    } else {
      nextPreferences.emailAllowRemoteImages = Boolean(updates.emailAllowRemoteImages);
    }
  }

  if ('emailRemoteImageAllowedSenders' in updates) {
    const emailRemoteImageAllowedSenders = normalizeEmailAddressList(updates.emailRemoteImageAllowedSenders);
    if (emailRemoteImageAllowedSenders.length === 0) {
      delete nextPreferences.emailRemoteImageAllowedSenders;
    } else {
      nextPreferences.emailRemoteImageAllowedSenders = emailRemoteImageAllowedSenders;
    }
  }

  preferencesFile.users[normalizedUserId] = nextPreferences;
  await writeSettingsJsonFileAtomic(USER_PREFERENCES_FILE, preferencesFile);
  return nextPreferences;
}

export async function setUserPreferredLocale(userId: string, locale: unknown): Promise<UserPreferences> {
  const normalizedLocale = normalizeUserLocale(locale);
  if (!normalizedLocale) {
    throw new Error('Unsupported locale.');
  }
  return updateUserPreferences(userId, { locale: normalizedLocale });
}
