import 'server-only';

import { routing } from '@/i18n/routing';
import {
  readSettingsTextFileIfExists,
  writeSettingsJsonFileAtomic,
} from '@/app/lib/settings-storage';

const USER_PREFERENCES_FILE = 'user-preferences.json';
const SUPPORTED_LOCALES = routing.locales as readonly string[];

export type UserLocale = typeof routing.locales[number];

export type UserOnboardingStep = 'language' | 'workspace' | 'profile' | 'tour' | 'complete';
export type UserOnboardingRuntimeStatus = 'pending' | 'completed' | 'skipped';
export type UserOnboardingProfileStatus = 'pending' | 'completed' | 'skipped';
export type UserOnboardingTourStatus = 'pending' | 'started' | 'skipped' | 'completed';

export type UserOnboardingState = {
  version: 4;
  step: UserOnboardingStep;
  runtime: UserOnboardingRuntimeStatus;
  profile: UserOnboardingProfileStatus;
  tour: UserOnboardingTourStatus;
  updatedAt: string;
};

const USER_ONBOARDING_STEPS = new Set<UserOnboardingStep>(['language', 'workspace', 'profile', 'tour', 'complete']);
const USER_ONBOARDING_RUNTIME_STATUSES = new Set<UserOnboardingRuntimeStatus>(['pending', 'completed', 'skipped']);
const USER_ONBOARDING_PROFILE_STATUSES = new Set<UserOnboardingProfileStatus>(['pending', 'completed', 'skipped']);
const USER_ONBOARDING_TOUR_STATUSES = new Set<UserOnboardingTourStatus>(['pending', 'started', 'skipped', 'completed']);

export function createDefaultUserOnboardingState(): UserOnboardingState {
  return {
    version: 4,
    step: 'language',
    runtime: 'skipped',
    profile: 'pending',
    tour: 'pending',
    updatedAt: new Date().toISOString(),
  };
}

export function createCompletedUserOnboardingState(): UserOnboardingState {
  return {
    version: 4,
    step: 'complete',
    runtime: 'skipped',
    profile: 'skipped',
    tour: 'completed',
    updatedAt: new Date().toISOString(),
  };
}

function normalizeUserOnboardingState(value: unknown): UserOnboardingState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as {
    version?: unknown;
    step?: unknown;
    runtime?: unknown;
    profile?: unknown;
    tour?: unknown;
    updatedAt?: unknown;
  };
  const legacyRuntimeStep = record.step === 'runtime';
  const step = legacyRuntimeStep
    ? 'profile'
    : typeof record.step === 'string' && USER_ONBOARDING_STEPS.has(record.step as UserOnboardingStep)
      ? record.step as UserOnboardingStep
      : 'language';
  const storedRuntime = typeof record.runtime === 'string'
    && USER_ONBOARDING_RUNTIME_STATUSES.has(record.runtime as UserOnboardingRuntimeStatus)
    ? record.runtime as UserOnboardingRuntimeStatus
    : 'skipped';
  const runtime: UserOnboardingRuntimeStatus = storedRuntime === 'completed' ? 'completed' : 'skipped';
  const profile = typeof record.profile === 'string' && USER_ONBOARDING_PROFILE_STATUSES.has(record.profile as UserOnboardingProfileStatus)
    ? record.profile as UserOnboardingProfileStatus
    : 'pending';
  const tour = typeof record.tour === 'string' && USER_ONBOARDING_TOUR_STATUSES.has(record.tour as UserOnboardingTourStatus)
    ? record.tour as UserOnboardingTourStatus
    : 'pending';
  const normalizedStep = step === 'complete' && (profile === 'pending' || tour === 'pending')
    ? 'language'
    : step;
  return {
    version: 4,
    step: normalizedStep,
    runtime,
    profile,
    tour,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  };
}

export type UserPreferences = {
  emailAllowRemoteImages?: boolean;
  emailRemoteImageAllowedSenders?: string[];
  lastActiveAgentId?: string;
  locale?: UserLocale;
  onboarding?: UserOnboardingState;
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

export function normalizeUserLastActiveAgentId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(normalized)) return null;
  return normalized;
}

function normalizePreferences(value: unknown): UserPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as {
    emailAllowRemoteImages?: unknown;
    emailRemoteImageAllowedSenders?: unknown;
    lastActiveAgentId?: unknown;
    locale?: unknown;
    onboarding?: unknown;
  };
  const locale = normalizeUserLocale(record.locale);
  const lastActiveAgentId = normalizeUserLastActiveAgentId(record.lastActiveAgentId);
  const emailRemoteImageAllowedSenders = normalizeEmailAddressList(record.emailRemoteImageAllowedSenders);
  const onboarding = normalizeUserOnboardingState(record.onboarding);
  return {
    ...(typeof record.emailAllowRemoteImages === 'boolean' ? { emailAllowRemoteImages: record.emailAllowRemoteImages } : {}),
    ...(emailRemoteImageAllowedSenders.length > 0 ? { emailRemoteImageAllowedSenders } : {}),
    ...(lastActiveAgentId ? { lastActiveAgentId } : {}),
    ...(locale ? { locale } : {}),
    ...(onboarding ? { onboarding } : {}),
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

export async function getUserOnboardingState(
  userId: string,
  options: { missing?: 'complete' | 'pending' } = {},
): Promise<UserOnboardingState> {
  const preferences = await getUserPreferences(userId);
  if (preferences.onboarding) return preferences.onboarding;
  return options.missing === 'pending'
    ? createDefaultUserOnboardingState()
    : createCompletedUserOnboardingState();
}

/**
 * Marks a freshly created account as needing the personal onboarding. Existing
 * installations intentionally default missing state to complete, so an update
 * never sends every historic account through the new flow.
 */
export async function initializeUserOnboarding(userId: string): Promise<UserOnboardingState> {
  const preferences = await getUserPreferences(userId);
  if (preferences.onboarding) return preferences.onboarding;
  const onboarding = createDefaultUserOnboardingState();
  await updateUserPreferences(userId, { onboarding });
  return onboarding;
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

  if ('lastActiveAgentId' in updates) {
    if (updates.lastActiveAgentId === undefined) {
      delete nextPreferences.lastActiveAgentId;
    } else {
      const lastActiveAgentId = normalizeUserLastActiveAgentId(updates.lastActiveAgentId);
      if (!lastActiveAgentId) {
        throw new Error('Unsupported agent ID.');
      }
      nextPreferences.lastActiveAgentId = lastActiveAgentId;
    }
  }

  if ('onboarding' in updates) {
    if (updates.onboarding === undefined) {
      delete nextPreferences.onboarding;
    } else {
      const onboarding = normalizeUserOnboardingState(updates.onboarding);
      if (!onboarding) {
        throw new Error('Unsupported onboarding state.');
      }
      nextPreferences.onboarding = onboarding;
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

export async function updateUserOnboardingState(
  userId: string,
  updates: Partial<Pick<UserOnboardingState, 'step' | 'runtime' | 'profile' | 'tour'>>,
): Promise<UserOnboardingState> {
  const current = await getUserOnboardingState(userId, { missing: 'pending' });
  const candidate = normalizeUserOnboardingState({
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  });
  if (!candidate) {
    throw new Error('Unsupported onboarding state.');
  }

  const preferences = await updateUserPreferences(userId, { onboarding: candidate });
  return preferences.onboarding ?? candidate;
}
