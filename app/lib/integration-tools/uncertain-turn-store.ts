import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { integrationTurnOutcomes } from '@/app/lib/db/schema';
import { pauseAutomationForUncertainIntegrationTurn } from '@/app/lib/automations/store';
import { IntegrationContractError } from './contracts';
import { integrationTurnKey, markIntegrationTurnUncertain, type IntegrationUncertainTurnContext } from './uncertain-turns';

function captureTurnIdentity(context: IntegrationUncertainTurnContext) {
  const identity = {
    userId: context.userId, sessionId: context.sessionId, agentId: context.agentId,
    workspaceId: context.workspaceId, agentTurnId: context.agentTurnId ?? null,
  };
  const nonempty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (![identity.userId, identity.sessionId, identity.workspaceId].every(nonempty)
    || identity.agentId !== null && !nonempty(identity.agentId)
    || identity.agentTurnId !== null && !nonempty(identity.agentTurnId)) {
    throw new IntegrationContractError('provider_denied', 'A server-bound integration turn identity is required.');
  }
  return identity;
}

/** Durable server-owned outcome only; arguments, provider responses and credentials are never stored. */
export async function persistIntegrationTurnUncertain(context: IntegrationUncertainTurnContext): Promise<void> {
  const identity = captureTurnIdentity(context);
  const captured = { ...identity, agentTurnId: identity.agentTurnId ?? undefined };
  const bindingKey = integrationTurnKey(captured);
  markIntegrationTurnUncertain(captured);
  await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(integrationTurnOutcomes).values({
      bindingKey, actorUserId: identity.userId, sessionId: identity.sessionId, agentId: identity.agentId,
      workspaceId: identity.workspaceId, agentTurnId: identity.agentTurnId,
      outcome: 'outcome_unknown', createdAt: new Date(),
    }).onConflictDoNothing({ target: integrationTurnOutcomes.bindingKey }).returning({ bindingKey: integrationTurnOutcomes.bindingKey });
    if (inserted) await pauseAutomationForUncertainIntegrationTurn(tx, captured);
  });
}

/** Read freshly even after cache eviction/restart. A new human turn has a different exact identity. */
export async function isPersistedIntegrationTurnUncertain(context: IntegrationUncertainTurnContext): Promise<boolean> {
  const identity = captureTurnIdentity(context);
  const bindingKey = integrationTurnKey({ ...identity, agentTurnId: identity.agentTurnId ?? undefined });
  const [record] = await db.select({ bindingKey: integrationTurnOutcomes.bindingKey }).from(integrationTurnOutcomes).where(and(
    eq(integrationTurnOutcomes.bindingKey, bindingKey), eq(integrationTurnOutcomes.actorUserId, identity.userId),
    eq(integrationTurnOutcomes.sessionId, identity.sessionId), eq(integrationTurnOutcomes.workspaceId, identity.workspaceId),
    identity.agentId === null ? isNull(integrationTurnOutcomes.agentId) : eq(integrationTurnOutcomes.agentId, identity.agentId),
    identity.agentTurnId === null ? isNull(integrationTurnOutcomes.agentTurnId) : eq(integrationTurnOutcomes.agentTurnId, identity.agentTurnId),
    eq(integrationTurnOutcomes.outcome, 'outcome_unknown'),
  )).limit(1);
  return record !== undefined;
}
