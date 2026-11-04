import 'server-only';
import { createHash } from 'node:crypto';

/** Stable audit identity data only. It neither authenticates nor grants access. */
export function apiKeyActorId(identity: { userId: string; integrationId: string; instanceId: string }): string {
  return `api-key:${createHash('sha256').update(JSON.stringify([identity.userId, identity.integrationId, identity.instanceId])).digest('hex').slice(0, 32)}`;
}
