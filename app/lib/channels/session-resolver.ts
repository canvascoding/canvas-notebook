import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { prepareSessionRuntimeSnapshot } from '@/app/lib/agent-runtime-policy/session-runtime-service';
import { SessionRuntimeContextRevisionConflictError } from '@/app/lib/agent-runtime-policy/runtime-store';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { DEFAULT_PI_SESSION_TITLE } from '@/app/lib/pi/session-titles';
import { withPiSessionOperationLock } from '@/app/lib/pi/session-operation-lock';
import { createPiSystemPromptSnapshot } from '@/app/lib/pi/system-prompt-snapshot';
import {
  resolveAgentSessionWorkspaceForUser,
  workspaceToPiSessionFields,
} from '@/app/lib/pi/session-workspace-context';
import { ensureDefaultAgent } from './agents';
import {
  activateOwnedChannelSessionState,
  createAndActivateChannelSessionState,
  resolveExistingChannelSessionState,
  resolveOrCreateChannelSessionState,
} from './channel-session-store';
import { withChannelOperationLock } from './channel-operation-lock';
import { DEFAULT_AGENT_ID, normalizeChannelThreadKey, WEB_CHANNEL_ID, webChannelSessionKey } from './constants';

export type ResolveChannelSessionInput = {
  userId: string;
  channelId: string;
  channelSessionKey: string;
  channelThreadKey?: string | null;
  requestedSessionId?: string | null;
  displayName?: string | null;
  agentId?: string;
  workspaceId?: string | null;
};

type ChannelSessionCreationMode = 'activate' | 'resolve';

function resolveAgentId(agentId?: string | null): string {
  return agentId?.trim() || DEFAULT_AGENT_ID;
}

async function findOwnedPiSession(sessionId: string, userId: string, agentId?: string | null) {
  return db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, userId),
      eq(piSessions.agentId, resolveAgentId(agentId)),
    ),
    columns: { id: true },
  });
}

export async function userOwnsPiSession(
  sessionId: string,
  userId: string,
  agentId?: string | null,
): Promise<boolean> {
  return Boolean(await findOwnedPiSession(sessionId, userId, agentId));
}

async function createRuntimePinnedChannelSession(
  input: ResolveChannelSessionInput,
  sessionId: string,
  mode: ChannelSessionCreationMode,
): Promise<string> {
  await ensureDefaultAgent();
  const agentId = resolveAgentId(input.agentId);

  return withPiSessionOperationLock(sessionId, input.userId, async () => {
    if (mode === 'activate') {
      const activated = await activateOwnedChannelSessionState({
        ...input,
        agentId,
        sessionId,
        inboundAt: new Date(),
      });
      if (activated) return activated;
    }

    let workspace = await resolveAgentSessionWorkspaceForUser({
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    if (!workspace.organizationId) {
      throw new Error('Complete the app AI runtime setup before creating a channel session.');
    }
    const workspaceId = workspace.workspaceId;
    const promptSnapshot = await createPiSystemPromptSnapshot(agentId, { userId: input.userId });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        workspace = await resolveAgentSessionWorkspaceForUser({
          userId: input.userId,
          workspaceId,
        });
      }
      if (!workspace.organizationId) {
        throw new Error('Complete the app AI runtime setup before creating a channel session.');
      }
      const organizationId = workspace.organizationId;
      const prepared = await prepareSessionRuntimeSnapshot({
        context: {
          organizationId,
          userId: input.userId,
          workspaceId: workspace.workspaceId,
          workspaceType: workspace.workspaceType,
          agentId,
          sessionId: null,
          requestedSelection: null,
        },
      });

      const refreshedWorkspace = await resolveAgentSessionWorkspaceForUser({
        userId: input.userId,
        workspaceId,
      });
      if (
        !refreshedWorkspace.organizationId
        || refreshedWorkspace.workspaceId !== workspace.workspaceId
        || refreshedWorkspace.workspaceType !== workspace.workspaceType
        || refreshedWorkspace.organizationId !== workspace.organizationId
      ) {
        throw new Error('Channel session workspace changed during runtime resolution.');
      }
      workspace = refreshedWorkspace;

      const storeInput = {
        sessionId,
        userId: input.userId,
        agentId,
        title: DEFAULT_PI_SESSION_TITLE,
        workspace: workspaceToPiSessionFields(workspace),
        runtimeSnapshot: prepared.snapshot,
        systemPromptSnapshot: promptSnapshot,
        channelId: input.channelId,
        channelSessionKey: input.channelSessionKey,
        channelThreadKey: input.channelThreadKey,
        displayName: input.displayName,
        inboundAt: new Date(),
      };

      try {
        const result = mode === 'resolve'
          ? await resolveOrCreateChannelSessionState(storeInput)
          : await createAndActivateChannelSessionState(storeInput);
        return result.sessionId;
      } catch (error) {
        if (error instanceof SessionRuntimeContextRevisionConflictError && attempt === 0) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Channel session could not be created with a current AI runtime snapshot.');
  });
}

async function createChannelSessionUnlocked(input: ResolveChannelSessionInput): Promise<string> {
  const agentId = resolveAgentId(input.agentId);
  const sessionId = input.requestedSessionId || `sess-${Date.now()}-${randomUUID()}`;
  const existingSession = await findOwnedPiSession(sessionId, input.userId, agentId);
  if (existingSession) {
    const activated = await activateOwnedChannelSessionState({
      ...input,
      agentId,
      sessionId,
      inboundAt: new Date(),
    });
    if (activated) return activated;
  }
  return createRuntimePinnedChannelSession({ ...input, agentId }, sessionId, 'activate');
}

export async function createChannelSession(input: ResolveChannelSessionInput): Promise<string> {
  const agentId = resolveAgentId(input.agentId);
  return withChannelOperationLock({ ...input, agentId }, () => (
    createChannelSessionUnlocked({ ...input, agentId })
  ));
}

async function resolveChannelSessionUnlocked(input: ResolveChannelSessionInput): Promise<string> {
  const channelThreadKey = normalizeChannelThreadKey(input.channelThreadKey);
  const agentId = resolveAgentId(input.agentId);
  const stateInput = { ...input, agentId, channelThreadKey, inboundAt: new Date() };

  if (input.requestedSessionId) {
    const activated = await activateOwnedChannelSessionState({
      ...stateInput,
      sessionId: input.requestedSessionId,
    });
    if (activated) return activated;
    if (input.channelId !== WEB_CHANNEL_ID) {
      throw new Error('Session not found');
    }
    return createRuntimePinnedChannelSession(
      { ...input, agentId, channelThreadKey },
      input.requestedSessionId,
      'activate',
    );
  }

  const existingSessionId = await resolveExistingChannelSessionState(stateInput);
  if (existingSessionId) return existingSessionId;

  const sessionId = `sess-${Date.now()}-${randomUUID()}`;
  return createRuntimePinnedChannelSession(
    { ...input, agentId, channelThreadKey },
    sessionId,
    'resolve',
  );
}

export async function resolveChannelSession(input: ResolveChannelSessionInput): Promise<string> {
  const agentId = resolveAgentId(input.agentId);
  return withChannelOperationLock({ ...input, agentId }, () => (
    resolveChannelSessionUnlocked({ ...input, agentId })
  ));
}

export function getDefaultWebChannelContext(userId: string) {
  return {
    channelId: WEB_CHANNEL_ID,
    channelSessionKey: webChannelSessionKey(userId),
    channelThreadKey: '',
  };
}
