import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-channel-runtime-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
type RuntimeSnapshot = {
  selection: {
    providerInstallationId: string;
    providerId: string;
    modelId: string;
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
  catalogRevision: number;
  policyRevision: number;
  selectionSource: 'session' | 'user_preference' | 'agent_default' | 'workspace_default' | 'app_default';
};

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
const runtimeContexts: Array<Record<string, unknown>> = [];
const queuedSnapshots: RuntimeSnapshot[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let nextPreparationGate: {
  entered: ReturnType<typeof deferred>;
  release: ReturnType<typeof deferred>;
} | null = null;

function runtimeSnapshot(input: {
  installation: string;
  model: string;
  catalogRevision?: number;
  policyRevision?: number;
  source?: RuntimeSnapshot['selectionSource'];
}): RuntimeSnapshot {
  return {
    selection: {
      providerInstallationId: input.installation,
      providerId: 'test-provider',
      modelId: input.model,
      thinkingLevel: input.model.endsWith('b') ? 'high' : 'off',
    },
    catalogRevision: input.catalogRevision ?? 0,
    policyRevision: input.policyRevision ?? 0,
    selectionSource: input.source ?? 'user_preference',
  };
}

let currentSnapshot = runtimeSnapshot({
  installation: `aip_${'a'.repeat(24)}`,
  model: 'channel-model-a',
});

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (
    request === '@earendil-works/pi-ai'
    || request === '@earendil-works/pi-ai/compat'
    || request === '@earendil-works/pi-ai/oauth'
  ) {
    return {
      registerBuiltInApiProviders: () => undefined,
      getProviders: () => [],
      getModels: () => [],
    };
  }
  if (
    request === '@/app/lib/agent-runtime-policy/session-runtime-service'
    || request.endsWith('/agent-runtime-policy/session-runtime-service')
  ) {
    return {
      prepareSessionRuntimeSnapshot: async (input: { context: Record<string, unknown> }) => {
        runtimeContexts.push(input.context);
        const gate = nextPreparationGate;
        if (gate) {
          nextPreparationGate = null;
          gate.entered.resolve();
          await gate.release.promise;
        }
        const snapshot = queuedSnapshots.shift() ?? currentSnapshot;
        return { snapshot, resolution: { status: 'resolved' } };
      },
    };
  }
  if (
    (request === '@/app/lib/pi/system-prompt-snapshot' || request.endsWith('/pi/system-prompt-snapshot'))
    && parent?.filename?.endsWith('/app/lib/channels/session-resolver.ts')
  ) {
    return {
      createPiSystemPromptSnapshot: async () => ({
        systemPrompt: 'Channel runtime test prompt',
        systemPromptHash: '0'.repeat(64),
        systemPromptCreatedAt: new Date(0),
      }),
    };
  }
  if (
    (request === '@/app/lib/agents/effective-runtime-config' || request.endsWith('/agents/effective-runtime-config'))
    && parent?.filename?.endsWith('/app/lib/channels/session-resolver.ts')
  ) {
    throw new Error('Channel session creation must not load the legacy runtime resolver.');
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { and, eq } = await import('drizzle-orm');
  const { db } = await import('../app/lib/db');
  const {
    agents,
    aiRuntimeDefaults,
    channelActiveSessions,
    piSessions,
    sessionChannelLinks,
    user,
  } = await import('../app/lib/db/schema');
  const {
    resolveAgentSessionWorkspaceForUser,
    workspaceToPiSessionFields,
  } = await import('../app/lib/pi/session-workspace-context');
  const { createPiSessionWithRuntimeSnapshot } = await import('../app/lib/pi/session-store');
  const { createChannelSession, resolveChannelSession } = await import('../app/lib/channels/session-resolver');
  const { getActiveChannelSession, setActiveChannelSession } = await import('../app/lib/channels/active-sessions');
  const { ensureSessionChannelLink } = await import('../app/lib/channels/channel-links');
  const { createAndActivateChannelSessionState } = await import('../app/lib/channels/channel-session-store');

  const now = new Date();
  const userId = 'channel-runtime-user';
  await db.insert(user).values({
    id: userId,
    name: 'Channel Runtime User',
    email: 'channel-runtime@example.test',
    emailVerified: true,
    image: null,
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  });
  const workspace = await resolveAgentSessionWorkspaceForUser({ userId });
  assert.ok(workspace.organizationId);

  const firstSessionId = 'sess-channel-runtime-a';
  await createChannelSession({
    requestedSessionId: firstSessionId,
    userId,
    workspaceId: workspace.workspaceId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:runtime-a',
  });
  const firstSession = await db.query.piSessions.findFirst({
    where: and(eq(piSessions.sessionId, firstSessionId), eq(piSessions.userId, userId)),
  });
  assert.equal(firstSession?.provider, 'test-provider');
  assert.equal(firstSession?.model, 'channel-model-a');
  assert.equal(firstSession?.thinkingLevel, 'off');
  assert.equal(firstSession?.runtimeProviderInstallationId, `aip_${'a'.repeat(24)}`);
  assert.equal(firstSession?.runtimeCatalogRevision, 0);
  assert.equal(firstSession?.runtimePolicyRevision, 0);
  assert.equal(firstSession?.runtimeSelectionSource, 'user_preference');
  assert.ok(firstSession?.createdAt instanceof Date);
  assert.ok(Math.abs((firstSession?.createdAt.getTime() ?? 0) - Date.now()) < 5_000);
  assert.equal(firstSession?.systemPromptSnapshotCreatedAt?.getTime(), 0);
  assert.equal(runtimeContexts[0]?.organizationId, workspace.organizationId);
  assert.equal(runtimeContexts[0]?.userId, userId);
  assert.equal(runtimeContexts[0]?.workspaceId, workspace.workspaceId);
  assert.equal(runtimeContexts[0]?.workspaceType, 'personal');
  assert.equal(runtimeContexts[0]?.agentId, 'canvas-agent');
  assert.equal(runtimeContexts[0]?.sessionId, null);
  assert.ok(await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, firstSessionId),
  }));
  assert.equal(
    await getActiveChannelSession({
      userId,
      agentId: 'canvas-agent',
      channelId: 'telegram',
      channelSessionKey: 'telegram:runtime-a',
    }),
    firstSessionId,
  );
  await createChannelSession({
    requestedSessionId: firstSessionId,
    userId,
    workspaceId: 'workspace-other',
    channelId: 'telegram',
    channelSessionKey: 'telegram:stored-workspace-wins',
  });
  assert.ok(await db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.sessionId, firstSessionId),
      eq(sessionChannelLinks.channelSessionKey, 'telegram:stored-workspace-wins'),
    ),
  }));
  const firstAfterRelink = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, firstSessionId),
  });
  assert.equal(firstAfterRelink?.workspaceId, workspace.workspaceId);
  assert.equal(runtimeContexts.length, 1);

  const specializedSessionId = 'sess-channel-runtime-specialized';
  await db.insert(agents).values({
    agentId: 'research-agent',
    name: 'Research Agent',
    iconId: 'bot',
    type: 'special',
    removable: true,
    scopeType: 'user',
    ownerUserId: userId,
    createdByUserId: userId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await createPiSessionWithRuntimeSnapshot({
    sessionId: specializedSessionId,
    userId,
    agentId: 'research-agent',
    title: 'Research Session',
    workspace: workspaceToPiSessionFields(workspace),
    runtimeSnapshot: currentSnapshot,
    systemPromptSnapshot: {
      systemPrompt: 'Research runtime test prompt',
      systemPromptHash: '1'.repeat(64),
      systemPromptCreatedAt: new Date(0),
    },
  });

  const resolvedSpecializedSessionId = await resolveChannelSession({
    requestedSessionId: specializedSessionId,
    userId,
    agentId: 'research-agent',
    workspaceId: workspace.workspaceId,
    channelId: 'web',
    channelSessionKey: `web:user:${userId}`,
  });
  assert.equal(resolvedSpecializedSessionId, specializedSessionId);
  const specializedSessions = await db.query.piSessions.findMany({
    where: and(
      eq(piSessions.sessionId, specializedSessionId),
      eq(piSessions.userId, userId),
    ),
  });
  assert.equal(specializedSessions.length, 1);
  assert.equal(specializedSessions[0]?.agentId, 'research-agent');

  const requestedRaceSessionId = 'sess-channel-runtime-requested-race';
  const requestedRaceEntered = deferred();
  const requestedRaceRelease = deferred();
  nextPreparationGate = {
    entered: requestedRaceEntered,
    release: requestedRaceRelease,
  };
  const requestedRaceContextsBefore = runtimeContexts.length;
  const requestedRaceFirst = createChannelSession({
    requestedSessionId: requestedRaceSessionId,
    userId,
    workspaceId: workspace.workspaceId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:requested-race-a',
  });
  await requestedRaceEntered.promise;
  const requestedRaceSecond = createChannelSession({
    requestedSessionId: requestedRaceSessionId,
    userId,
    workspaceId: 'workspace-no-longer-valid',
    channelId: 'telegram',
    channelSessionKey: 'telegram:requested-race-b',
  });
  requestedRaceRelease.resolve();
  const requestedRaceResults = await Promise.all([requestedRaceFirst, requestedRaceSecond]);
  assert.deepEqual(requestedRaceResults, [requestedRaceSessionId, requestedRaceSessionId]);
  assert.equal(runtimeContexts.length - requestedRaceContextsBefore, 1);
  const requestedRaceSessions = await db.query.piSessions.findMany({
    where: and(
      eq(piSessions.sessionId, requestedRaceSessionId),
      eq(piSessions.userId, userId),
    ),
  });
  assert.equal(requestedRaceSessions.length, 1);
  assert.equal(requestedRaceSessions[0]?.workspaceId, workspace.workspaceId);
  const requestedRaceLinks = await db.query.sessionChannelLinks.findMany({
    where: eq(sessionChannelLinks.sessionId, requestedRaceSessionId),
  });
  assert.equal(requestedRaceLinks.length, 2);

  currentSnapshot = runtimeSnapshot({
    installation: `aip_${'b'.repeat(24)}`,
    model: 'channel-model-b',
  });
  const secondSessionId = 'sess-channel-runtime-b';
  await createChannelSession({
    requestedSessionId: secondSessionId,
    userId,
    workspaceId: workspace.workspaceId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:runtime-b',
  });
  const [firstAfterPreferenceChange, secondSession] = await Promise.all([
    db.query.piSessions.findFirst({ where: eq(piSessions.sessionId, firstSessionId) }),
    db.query.piSessions.findFirst({ where: eq(piSessions.sessionId, secondSessionId) }),
  ]);
  assert.equal(firstAfterPreferenceChange?.model, 'channel-model-a');
  assert.equal(firstAfterPreferenceChange?.runtimeProviderInstallationId, `aip_${'a'.repeat(24)}`);
  assert.equal(secondSession?.model, 'channel-model-b');
  assert.equal(secondSession?.thinkingLevel, 'high');
  assert.equal(secondSession?.runtimeProviderInstallationId, `aip_${'b'.repeat(24)}`);

  const activeRaceContext = {
    userId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:runtime-active-race',
  };
  await ensureSessionChannelLink({ ...activeRaceContext, sessionId: firstSessionId });
  await ensureSessionChannelLink({ ...activeRaceContext, sessionId: secondSessionId });
  await Promise.all([
    setActiveChannelSession({ ...activeRaceContext, sessionId: firstSessionId }),
    setActiveChannelSession({ ...activeRaceContext, sessionId: secondSessionId }),
  ]);
  const activeRaceSessionId = await getActiveChannelSession(activeRaceContext);
  const activeRaceLinks = await db.query.sessionChannelLinks.findMany({
    where: and(
      eq(sessionChannelLinks.userId, userId),
      eq(sessionChannelLinks.channelSessionKey, activeRaceContext.channelSessionKey),
    ),
  });
  assert.equal(activeRaceLinks.filter((link) => link.isPrimary).length, 1);
  assert.equal(activeRaceLinks.find((link) => link.isPrimary)?.sessionId, activeRaceSessionId);

  const sessionsBeforeConcurrentResolve = await db.query.piSessions.findMany({
    where: eq(piSessions.userId, userId),
  });
  const entered = deferred();
  const release = deferred();
  nextPreparationGate = { entered, release };
  const concurrentInput = {
    userId,
    workspaceId: workspace.workspaceId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:runtime-concurrent',
  };
  const firstConcurrentResolve = resolveChannelSession(concurrentInput);
  await entered.promise;
  const secondConcurrentResolve = resolveChannelSession(concurrentInput);
  release.resolve();
  const [firstConcurrentSessionId, secondConcurrentSessionId] = await Promise.all([
    firstConcurrentResolve,
    secondConcurrentResolve,
  ]);
  assert.equal(secondConcurrentSessionId, firstConcurrentSessionId);
  const sessionsAfterConcurrentResolve = await db.query.piSessions.findMany({
    where: eq(piSessions.userId, userId),
  });
  assert.equal(sessionsAfterConcurrentResolve.length, sessionsBeforeConcurrentResolve.length + 1);
  const concurrentLinks = await db.query.sessionChannelLinks.findMany({
    where: and(
      eq(sessionChannelLinks.userId, userId),
      eq(sessionChannelLinks.channelId, 'telegram'),
      eq(sessionChannelLinks.channelSessionKey, 'telegram:runtime-concurrent'),
    ),
  });
  assert.equal(concurrentLinks.length, 1);
  assert.equal(concurrentLinks[0]?.sessionId, firstConcurrentSessionId);
  assert.equal(concurrentLinks[0]?.isPrimary, true);
  const concurrentActive = await db.query.channelActiveSessions.findFirst({
    where: and(
      eq(channelActiveSessions.userId, userId),
      eq(channelActiveSessions.channelSessionKey, 'telegram:runtime-concurrent'),
    ),
  });
  assert.equal(concurrentActive?.sessionId, firstConcurrentSessionId);

  const rollbackSessionId = 'sess-channel-runtime-rollback';
  await assert.rejects(
    createAndActivateChannelSessionState({
      sessionId: rollbackSessionId,
      userId,
      agentId: 'canvas-agent',
      title: 'Rollback Test',
      workspace: workspaceToPiSessionFields(workspace),
      runtimeSnapshot: currentSnapshot,
      systemPromptSnapshot: {
        systemPrompt: 'Rollback test prompt',
        systemPromptHash: '1'.repeat(64),
        systemPromptCreatedAt: new Date(0),
      },
      channelId: 'telegram',
      channelSessionKey: null as unknown as string,
    }),
  );
  assert.equal(await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, rollbackSessionId),
  }), undefined);
  assert.equal(await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, rollbackSessionId),
  }), undefined);
  assert.equal(await db.query.channelActiveSessions.findFirst({
    where: eq(channelActiveSessions.sessionId, rollbackSessionId),
  }), undefined);

  await db.insert(aiRuntimeDefaults).values({
    organizationId: workspace.organizationId,
    catalogRevision: 1,
    migrationState: 'configured',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: aiRuntimeDefaults.organizationId,
    set: { catalogRevision: 1, updatedAt: now },
  });
  queuedSnapshots.push(
    runtimeSnapshot({ installation: `aip_${'c'.repeat(24)}`, model: 'channel-model-c', catalogRevision: 0 }),
    runtimeSnapshot({ installation: `aip_${'c'.repeat(24)}`, model: 'channel-model-c', catalogRevision: 1 }),
  );
  const retryCallsBefore = runtimeContexts.length;
  const retrySessionId = 'sess-channel-runtime-retry';
  await createChannelSession({
    requestedSessionId: retrySessionId,
    userId,
    workspaceId: workspace.workspaceId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:runtime-retry',
  });
  const retrySession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, retrySessionId),
  });
  assert.equal(runtimeContexts.length - retryCallsBefore, 2);
  assert.equal(retrySession?.model, 'channel-model-c');
  assert.equal(retrySession?.runtimeCatalogRevision, 1);
  assert.ok(await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, retrySessionId),
  }));

  await db.update(aiRuntimeDefaults)
    .set({ catalogRevision: 2, updatedAt: new Date() })
    .where(eq(aiRuntimeDefaults.organizationId, workspace.organizationId));
  queuedSnapshots.push(
    runtimeSnapshot({ installation: `aip_${'d'.repeat(24)}`, model: 'channel-model-d', catalogRevision: 1 }),
    runtimeSnapshot({ installation: `aip_${'d'.repeat(24)}`, model: 'channel-model-d', catalogRevision: 1 }),
  );
  const rejectedSessionId = 'sess-channel-runtime-rejected';
  await assert.rejects(
    createChannelSession({
      requestedSessionId: rejectedSessionId,
      userId,
      workspaceId: workspace.workspaceId,
      channelId: 'telegram',
      channelSessionKey: 'telegram:runtime-rejected',
    }),
    /catalog or workspace policy changed/u,
  );
  assert.equal(await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, rejectedSessionId),
  }), undefined);
  assert.equal(await db.query.sessionChannelLinks.findFirst({
    where: eq(sessionChannelLinks.sessionId, rejectedSessionId),
  }), undefined);
  assert.equal(await db.query.channelActiveSessions.findFirst({
    where: eq(channelActiveSessions.sessionId, rejectedSessionId),
  }), undefined);

  await assert.rejects(
    createPiSessionWithRuntimeSnapshot({
      sessionId: specializedSessionId,
      userId,
      agentId: 'canvas-agent',
      title: 'Conflicting Canvas Session',
      workspace: workspaceToPiSessionFields(workspace),
      runtimeSnapshot: currentSnapshot,
      systemPromptSnapshot: {
        systemPrompt: 'Conflicting runtime test prompt',
        systemPromptHash: '2'.repeat(64),
        systemPromptCreatedAt: new Date(0),
      },
    }),
    /different agent/u,
  );
  assert.equal(
    (await db.query.piSessions.findMany({
      where: and(
        eq(piSessions.sessionId, specializedSessionId),
        eq(piSessions.userId, userId),
      ),
    })).length,
    1,
  );

  console.log('channel-session-runtime-test: ok');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
