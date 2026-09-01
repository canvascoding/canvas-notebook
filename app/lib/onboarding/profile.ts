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
import { resolveExecutableAgentRuntime } from '@/app/lib/agent-runtime-policy/provider-runtime';
import { sessionRuntimeSnapshotFromResolvedSelection } from '@/app/lib/agent-runtime-policy/runtime-snapshot';
import {
  readPiSessionRuntimeSnapshot,
  SessionRuntimeContextRevisionConflictError,
  SessionRuntimeSnapshotConflictError,
  writePiSessionRuntimeSnapshot,
} from '@/app/lib/agent-runtime-policy/runtime-store';
import {
  AGENTS_STORAGE_ROOT,
  DEFAULT_MANAGED_AGENT_ID,
  writeManagedAgentFile,
} from '@/app/lib/agents/storage';
import { withPiSessionOperationLock } from '@/app/lib/pi/session-operation-lock';
import { createPiSessionWithRuntimeSnapshot, savePiSession } from '@/app/lib/pi/session-store';
import {
  resolveAgentSessionWorkspaceForUser,
  workspaceToPiSessionFields,
} from '@/app/lib/pi/session-workspace-context';
import { createPiSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import { getUserOnboardingState, updateUserOnboardingState } from '@/app/lib/user-preferences';

export const ONBOARDING_BOOTSTRAP_FILE_NAME = 'BOOTSTRAP.md';
export const ONBOARDING_PROFILE_SESSION_TITLE = 'Bradley Onboarding';
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
    return 'Ich bin Bradley, dein Hauptagent in Canvas Notebook. Mein Name und meine Rolle bleiben fest, aber du kannst festlegen, wie wir zusammenarbeiten – zum Beispiel Anrede, Detailgrad, Rückfragen und Ton. Wie heißt du, und wofür möchtest du Canvas hauptsächlich nutzen?';
  }

  return 'I am Bradley, your main agent in Canvas Notebook. My name and role stay fixed, but you can choose how we work together—for example, formality, level of detail, follow-up questions, and tone. What is your name, and what do you mainly want to use Canvas for?';
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

async function isProfilePending(userId: string): Promise<boolean> {
  const onboarding = await getUserOnboardingState(userId);
  return onboarding.step === 'profile'
    && onboarding.profile === 'pending';
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
  if (!(await isProfilePending(params.userId))) {
    throw new OnboardingProfileError('Your onboarding profile is already complete.', 'PROFILE_ALREADY_COMPLETE', 409);
  }
  await ensureDefaultAgent();

  const sessionId = buildOnboardingProfileSessionId(params.userId);
  return withPiSessionOperationLock(sessionId, params.userId, async () => {
    const promptSnapshot = await createPiSystemPromptSnapshot(DEFAULT_AGENT_ID, { userId: params.userId });

    for (let attempt = 0; attempt < 2; attempt += 1) {
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

      try {
        let workspace = await resolveAgentSessionWorkspaceForUser({
          userId: params.userId,
          workspaceId: existing?.workspaceId ?? null,
        });
        if (workspace.workspaceType !== 'personal' || !workspace.organizationId) {
          throw new OnboardingProfileError(
            'The onboarding profile session requires your personal workspace and completed app setup.',
            'ONBOARDING_PERSONAL_WORKSPACE_REQUIRED',
            409,
          );
        }
        const organizationId = workspace.organizationId;

        const storedSnapshot = existing
          ? await readPiSessionRuntimeSnapshot({
            sessionId,
            userId: params.userId,
            agentId: DEFAULT_AGENT_ID,
          })
          : null;
        const runtime = await resolveExecutableAgentRuntime({
          organizationId,
          userId: params.userId,
          workspaceId: workspace.workspaceId,
          workspaceType: workspace.workspaceType,
          agentId: DEFAULT_AGENT_ID,
          sessionId: null,
          requestedSelection: storedSnapshot?.selection ?? null,
        });
        const runtimeSnapshot = storedSnapshot
          ?? sessionRuntimeSnapshotFromResolvedSelection(runtime.selection);

        const refreshedWorkspace = await resolveAgentSessionWorkspaceForUser({
          userId: params.userId,
          workspaceId: workspace.workspaceId,
        });
        if (
          refreshedWorkspace.workspaceType !== 'personal'
          || refreshedWorkspace.workspaceId !== workspace.workspaceId
          || refreshedWorkspace.organizationId !== organizationId
        ) {
          throw new OnboardingProfileError(
            'The personal workspace changed while the onboarding session was being created.',
            'ONBOARDING_WORKSPACE_CHANGED',
            409,
          );
        }
        workspace = refreshedWorkspace;

        if (!existing) {
          await createPiSessionWithRuntimeSnapshot({
            sessionId,
            userId: params.userId,
            agentId: DEFAULT_AGENT_ID,
            title: ONBOARDING_PROFILE_SESSION_TITLE,
            workspace: workspaceToPiSessionFields(workspace),
            runtimeSnapshot,
            systemPromptSnapshot: promptSnapshot,
          });
        } else if (!storedSnapshot) {
          await writePiSessionRuntimeSnapshot({
            sessionId,
            userId: params.userId,
            agentId: DEFAULT_AGENT_ID,
            snapshot: runtimeSnapshot,
            expectedSnapshot: null,
            contextRevision: {
              organizationId,
              workspaceId: workspace.workspaceId,
              expectedCatalogRevision: runtimeSnapshot.catalogRevision,
              expectedPolicyRevision: runtimeSnapshot.policyRevision,
            },
          });
        }

        const finalWorkspace = await resolveAgentSessionWorkspaceForUser({
          userId: params.userId,
          workspaceId: workspace.workspaceId,
        });
        if (
          finalWorkspace.workspaceType !== 'personal'
          || finalWorkspace.workspaceId !== workspace.workspaceId
          || finalWorkspace.organizationId !== organizationId
        ) {
          throw new OnboardingProfileError(
            'Access to the personal workspace changed before the onboarding welcome message was saved.',
            'ONBOARDING_WORKSPACE_CHANGED',
            409,
          );
        }

        const welcomeMessage: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: getOnboardingProfileWelcomeMessage(params.locale) }],
          api: runtime.model.api,
          provider: runtime.model.provider,
          model: runtime.model.id,
          usage: emptyUsage(),
          stopReason: 'stop',
          timestamp: Date.now(),
        };

        await savePiSession(
          sessionId,
          params.userId,
          runtimeSnapshot.selection.providerId,
          runtimeSnapshot.selection.modelId,
          [welcomeMessage],
          undefined,
          {
            titleOverride: ONBOARDING_PROFILE_SESSION_TITLE,
            agentId: DEFAULT_AGENT_ID,
            channelId: WEB_CHANNEL_ID,
            channelSessionKey: webChannelSessionKey(params.userId),
            workspaceId: finalWorkspace.workspaceId,
            runtimeSnapshot,
            systemPromptSnapshot: promptSnapshot,
          },
        );

        return { sessionId };
      } catch (error) {
        if (
          attempt === 0
          && (
            error instanceof SessionRuntimeContextRevisionConflictError
            || error instanceof SessionRuntimeSnapshotConflictError
          )
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new OnboardingProfileError(
      'The onboarding session runtime changed while it was being created. Try again.',
      'ONBOARDING_RUNTIME_CHANGED',
      409,
    );
  });
}

export async function completeOnboardingProfile(params: {
  userId: string;
  userMd: string;
  soulMd: string;
  summary?: string | null;
}): Promise<{ success: true; deletedBootstrap: boolean; instanceCompleted: boolean }> {
  if (!(await isProfilePending(params.userId))) {
    throw new OnboardingProfileError('Your onboarding profile is already complete.', 'PROFILE_ALREADY_COMPLETE', 409);
  }

  const userMd = normalizeProfileContent(params.userMd, 'USER.md');
  const soulMd = normalizeProfileContent(params.soulMd, 'SOUL.md');

  await writeManagedAgentFile('USER.md', userMd, DEFAULT_MANAGED_AGENT_ID, { userId: params.userId });
  await writeManagedAgentFile('SOUL.md', soulMd, DEFAULT_MANAGED_AGENT_ID, { userId: params.userId });
  await updateUserOnboardingState(params.userId, { profile: 'completed', step: 'tour' });

  return { success: true, deletedBootstrap: false, instanceCompleted: false };
}

export async function skipOnboardingProfile(params: {
  userId: string;
}): Promise<{ success: true; deletedBootstrap: boolean; instanceCompleted: boolean; alreadyComplete: boolean }> {
  if (!(await isProfilePending(params.userId))) {
    return { success: true, deletedBootstrap: false, instanceCompleted: false, alreadyComplete: true };
  }

  await updateUserOnboardingState(params.userId, { profile: 'skipped', step: 'tour' });
  return { success: true, deletedBootstrap: false, instanceCompleted: false, alreadyComplete: false };
}

export async function isOnboardingProfileToolAvailable(params: {
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}): Promise<boolean> {
  if ((params.agentId?.trim() || DEFAULT_AGENT_ID) !== DEFAULT_AGENT_ID) {
    return false;
  }
  if (!params.userId || !params.sessionId || params.sessionId !== buildOnboardingProfileSessionId(params.userId)) {
    return false;
  }
  return isProfilePending(params.userId);
}
