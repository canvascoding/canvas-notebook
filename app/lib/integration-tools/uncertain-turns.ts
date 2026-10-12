import 'server-only';

import { createHash } from 'node:crypto';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { IntegrationReferenceCache } from './reference-cache';

/** Only server-resolved runtime identity belongs here; model arguments never supply a turn. */
export type IntegrationUncertainTurnContext = Pick<AgentExecutionContext,
  'userId' | 'sessionId' | 'agentId' | 'workspaceId' | 'agentTurnId'>;

const uncertaintyHost = globalThis as typeof globalThis & {
  __canvasIntegrationUncertainTurnsV1?: IntegrationReferenceCache<boolean>;
};
// Reuse the original factory cache, including marks issued by another Next/server module copy.
const uncertainTurns = uncertaintyHost.__canvasIntegrationUncertainTurnsV1
  ??= new IntegrationReferenceCache<boolean>(512, 15 * 60_000);

export function integrationTurnKey(context: IntegrationUncertainTurnContext): string {
  // This primitive array produces the exact previous schemaFingerprint key,
  // without loading schema validators or any provider/runtime/database module.
  return createHash('sha256').update(JSON.stringify([
    context.userId, context.sessionId, context.agentId, context.workspaceId, context.agentTurnId ?? null,
  ])).digest('base64url');
}

export function markIntegrationTurnUncertain(context: IntegrationUncertainTurnContext): void {
  uncertainTurns.set(integrationTurnKey(context), true);
}

export function isIntegrationTurnUncertain(context: IntegrationUncertainTurnContext): boolean {
  return uncertainTurns.get(integrationTurnKey(context)) === true;
}
