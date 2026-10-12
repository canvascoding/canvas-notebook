import 'server-only';

import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { piSessions, user } from '@/app/lib/db/schema';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { resolveAgentAuthorizationContextForSession, resolveAgentExecutionContextForSession } from '@/app/lib/pi/session-workspace-context';
import { IntegrationContractError, type IntegrationExecutionContext } from './contracts';

export type ResolvedIntegrationExecutionContext = {
  integrationContext: IntegrationExecutionContext;
  executionContext: AgentExecutionContext;
};

/** Only called with authenticated server actor/session identity and a server policy revision. */
async function resolveIntegrationContextWithSessionResolver(input: {
  actorUserId: string;
  sessionId: string;
  agentId?: string | null;
  policyRevision: string;
}, resolveSessionContext: typeof resolveAgentExecutionContextForSession): Promise<ResolvedIntegrationExecutionContext> {
  // Capture authority before the first await; caller mutation cannot change the actor or binding.
  const { actorUserId, sessionId, agentId, policyRevision } = input;
  if (!actorUserId.trim() || !sessionId.trim() || !policyRevision.trim()
    || (agentId !== undefined && agentId !== null && !agentId.trim())) {
    throw new IntegrationContractError('invalid_request', 'A current actor, agent session and policy revision are required.');
  }
  const denied = () => new IntegrationContractError('provider_denied', 'The originating agent session is no longer available for integrations.');
  const predicate = and(
    eq(piSessions.sessionId, sessionId), eq(piSessions.userId, actorUserId), isNull(piSessions.archivedAt),
    or(isNull(user.banned), eq(user.banned, false)),
  );
  const [storedSession] = await db.select({
    id: piSessions.id, agentId: piSessions.agentId,
  }).from(piSessions).innerJoin(user, eq(piSessions.userId, user.id)).where(predicate).limit(1);
  if (!storedSession || (agentId && agentId !== storedSession.agentId)) throw denied();

  // The existing runtime helper checks fresh workspace read/run and agent-use permissions.
  // Our persisted-session check prevents its bootstrap fallback from accepting a foreign session.
  const executionContext = await resolveSessionContext({
    userId: actorUserId, sessionId, agentId: storedSession.agentId,
  });
  if (executionContext.userId !== actorUserId || executionContext.sessionId !== sessionId
    || executionContext.agentId !== storedSession.agentId || !executionContext.workspaceId.trim()) throw denied();
  const [currentSession] = await db.select({ id: piSessions.id }).from(piSessions)
    .innerJoin(user, eq(piSessions.userId, user.id))
    .where(and(predicate, eq(piSessions.id, storedSession.id), eq(piSessions.agentId, storedSession.agentId),
      eq(piSessions.workspaceId, executionContext.workspaceId))).limit(1);
  if (!currentSession) throw denied();
  return {
    integrationContext: {
      actorUserId: executionContext.userId,
      organizationId: executionContext.organizationId,
      workspaceId: executionContext.workspaceId,
      agentId: executionContext.agentId,
      policyRevision,
    },
    executionContext,
  };
}

/** Default runtime callers continue to capture their full skill/package execution context. */
export async function resolveIntegrationExecutionContext(input: {
  actorUserId: string;
  sessionId: string;
  agentId?: string | null;
  policyRevision: string;
}): Promise<ResolvedIntegrationExecutionContext> {
  return resolveIntegrationContextWithSessionResolver(input, resolveAgentExecutionContextForSession);
}

/** Explicit server-only widget preflight; identical authority checks without runtime skill-file capture. */
export async function resolveIntegrationAuthorizationContext(input: {
  actorUserId: string;
  sessionId: string;
  agentId?: string | null;
  policyRevision: string;
}): Promise<ResolvedIntegrationExecutionContext> {
  return resolveIntegrationContextWithSessionResolver(input, resolveAgentAuthorizationContextForSession);
}

/** Resolve lazily when a tool runs: delegated and automation sessions are persisted before model execution. */
export async function resolveRuntimeIntegrationExecutionContext(input: {
  executionContext: AgentExecutionContext;
  policyRevision: string;
}): Promise<ResolvedIntegrationExecutionContext> {
  const expected = { ...input.executionContext };
  const policyRevision = input.policyRevision;
  if (!expected.workspaceId.trim() || !expected.agentId?.trim()) {
    throw new IntegrationContractError('invalid_request', 'A server-bound agent and workspace are required for integrations.');
  }
  const resolved = await resolveIntegrationExecutionContext({
    actorUserId: expected.userId,
    sessionId: expected.sessionId,
    agentId: expected.agentId,
    policyRevision,
  });
  const current = resolved.executionContext;
  if (current.userId !== expected.userId || current.sessionId !== expected.sessionId
    || current.agentId !== expected.agentId || current.workspaceId !== expected.workspaceId
    || current.workspaceType !== expected.workspaceType || current.organizationId !== expected.organizationId
    || current.customerId !== expected.customerId || current.projectId !== expected.projectId
    || current.workspaceRoot !== expected.workspaceRoot || current.workspaceRootRelativePath !== expected.workspaceRootRelativePath
    || current.legacy !== expected.legacy) {
    throw new IntegrationContractError('provider_denied', 'The originating agent workspace changed. Reload its tools before continuing.');
  }
  return { ...resolved, integrationContext: { ...resolved.integrationContext, sessionId: expected.sessionId }, executionContext: { ...current,
    ...(expected.agentTurnId ? { agentTurnId: expected.agentTurnId } : {}),
  } };
}
