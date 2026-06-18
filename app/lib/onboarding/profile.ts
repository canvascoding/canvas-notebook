import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { and, eq } from 'drizzle-orm';

import { ensureDefaultAgent } from '@/app/lib/channels/agents';
import { DEFAULT_AGENT_ID, WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import { db } from '@/app/lib/db';
import { piMessages, piSessions } from '@/app/lib/db/schema';
import { resolveAgentRuntimeConfig } from '@/app/lib/agents/effective-runtime-config';
import {
  AGENTS_STORAGE_ROOT,
  DEFAULT_MANAGED_AGENT_ID,
  writeManagedAgentFile,
} from '@/app/lib/agents/storage';
import { isOnboardingComplete, markOnboardingComplete } from '@/app/lib/onboarding/status';
import { savePiSession } from '@/app/lib/pi/session-store';

export const ONBOARDING_BOOTSTRAP_FILE_NAME = 'BOOTSTRAP.md';
export const ONBOARDING_PROFILE_SESSION_TITLE = 'Canvas Agent Onboarding';
export const ONBOARDING_PROFILE_TOOL_NAME = 'complete_onboarding_profile';

const MAX_PROFILE_FILE_CHARS = 16_000;

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|secret|token|password|passwd|credential)s?\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
];

export class OnboardingProfileError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'OnboardingProfileError';
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function normalizeLocale(locale?: string | null): 'de' | 'en' {
  return locale?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function getOnboardingProfileWelcomeMessage(locale?: string | null): string {
  if (normalizeLocale(locale) === 'de') {
    return 'Ich bin dein Canvas Agent. Ich kann dir beim Arbeiten mit Dateien, Notizen, Aufgaben, Tools und Automationen helfen. Wie heißt du, und wofür möchtest du Canvas hauptsächlich nutzen?';
  }

  return 'I am your Canvas Agent. I can help you work with files, notes, tasks, tools, and automations. What is your name, and what do you mainly want to use Canvas for?';
}

export function buildOnboardingProfileSessionId(userId: string): string {
  const hash = createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return `onboarding-profile-${hash}`;
}

export function getOnboardingBootstrapPath(agentId = DEFAULT_MANAGED_AGENT_ID): string {
  return path.join(AGENTS_STORAGE_ROOT, agentId, ONBOARDING_BOOTSTRAP_FILE_NAME);
}

async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readOnboardingBootstrapPrompt(): Promise<string | null> {
  const content = await readTextFileIfExists(getOnboardingBootstrapPath());
  const trimmed = content?.trim();
  return trimmed ? trimmed : null;
}

export async function deleteOnboardingBootstrapFile(): Promise<boolean> {
  try {
    await fs.unlink(getOnboardingBootstrapPath());
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function normalizeProfileContent(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new OnboardingProfileError(`${label} must not be empty.`, 'EMPTY_PROFILE_FILE');
  }
  if (normalized.length > MAX_PROFILE_FILE_CHARS) {
    throw new OnboardingProfileError(`${label} must be ${MAX_PROFILE_FILE_CHARS} characters or less.`, 'PROFILE_FILE_TOO_LARGE');
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new OnboardingProfileError(`${label} appears to contain a secret or credential.`, 'PROFILE_FILE_CONTAINS_SECRET');
  }
  return `${normalized}\n`;
}

function normalizeCompletionNotes(value?: string | null): string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'profile_completed';
  }
  return `profile_completed: ${normalized.slice(0, 400)}`;
}

async function assertOnboardingStillOpen(): Promise<void> {
  if (await isOnboardingComplete()) {
    throw new OnboardingProfileError('Onboarding is already complete.', 'ONBOARDING_ALREADY_COMPLETE', 409);
  }
}

async function onboardingSessionHasMessages(sessionDbId: number): Promise<boolean> {
  const rows = await db
    .select({ id: piMessages.id })
    .from(piMessages)
    .where(eq(piMessages.piSessionDbId, sessionDbId))
    .limit(1);
  return rows.length > 0;
}

export async function ensureOnboardingProfileSession(params: {
  userId: string;
  locale?: string | null;
}): Promise<{ sessionId: string }> {
  await assertOnboardingStillOpen();
  await ensureDefaultAgent();

  const sessionId = buildOnboardingProfileSessionId(params.userId);
  const existing = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, params.userId),
      eq(piSessions.agentId, DEFAULT_AGENT_ID),
    ),
  });

  if (existing && await onboardingSessionHasMessages(existing.id)) {
    return { sessionId };
  }

  const effectiveConfig = await resolveAgentRuntimeConfig(DEFAULT_AGENT_ID);
  const now = Date.now();
  const welcomeMessage: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: getOnboardingProfileWelcomeMessage(params.locale) }],
    api: effectiveConfig.model.api,
    provider: effectiveConfig.model.provider,
    model: effectiveConfig.model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: now,
  };

  await savePiSession(
    sessionId,
    params.userId,
    effectiveConfig.activeProvider,
    effectiveConfig.model.id,
    [welcomeMessage],
    undefined,
    {
      titleOverride: ONBOARDING_PROFILE_SESSION_TITLE,
      agentId: DEFAULT_AGENT_ID,
      channelId: WEB_CHANNEL_ID,
      channelSessionKey: webChannelSessionKey(params.userId),
    },
  );

  return { sessionId };
}

export async function completeOnboardingProfile(params: {
  userId: string;
  userMd: string;
  soulMd: string;
  summary?: string | null;
}): Promise<{ success: true; deletedBootstrap: boolean }> {
  await assertOnboardingStillOpen();

  const userMd = normalizeProfileContent(params.userMd, 'USER.md');
  const soulMd = normalizeProfileContent(params.soulMd, 'SOUL.md');

  await writeManagedAgentFile('USER.md', userMd, DEFAULT_MANAGED_AGENT_ID);
  await writeManagedAgentFile('SOUL.md', soulMd, DEFAULT_MANAGED_AGENT_ID);
  const deletedBootstrap = await deleteOnboardingBootstrapFile();

  await markOnboardingComplete({
    completedBy: params.userId,
    method: 'ui',
    notes: normalizeCompletionNotes(params.summary),
  });

  return { success: true, deletedBootstrap };
}

export async function skipOnboardingProfile(params: {
  userId: string;
}): Promise<{ success: true; deletedBootstrap: boolean; alreadyComplete: boolean }> {
  if (await isOnboardingComplete()) {
    return { success: true, deletedBootstrap: false, alreadyComplete: true };
  }

  const deletedBootstrap = await deleteOnboardingBootstrapFile();
  await markOnboardingComplete({
    completedBy: params.userId,
    method: 'ui',
    notes: 'profile_skipped',
  });

  return { success: true, deletedBootstrap, alreadyComplete: false };
}

export async function isOnboardingProfileToolAvailable(params: {
  agentId?: string | null;
  sessionId?: string | null;
}): Promise<boolean> {
  if ((params.agentId?.trim() || DEFAULT_AGENT_ID) !== DEFAULT_AGENT_ID) {
    return false;
  }
  if (!params.sessionId?.startsWith('onboarding-profile-')) {
    return false;
  }
  return !(await isOnboardingComplete());
}
