import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { withFileMutationLock } from '@/app/lib/secrets/file-mutation-lock';
import { resolveNewManagedAgentId } from './registry';

/**
 * The SQL unique-key lock ends at rollback. Hold the existing cross-process
 * storage lease until the public Create/Delete action has finished file cleanup.
 * Agent identities are global, so user/scope must not split this lock key.
 */
export async function withManagedAgentCreationLease<T>(
  input: { name: string; agentId?: string | null }, operation: () => Promise<T>,
): Promise<T> {
  const agentId = resolveNewManagedAgentId(input);
  const key = createHash('sha256').update(agentId).digest('hex');
  return withFileMutationLock(path.join(resolveCanvasDataRoot(), 'canvas-agent-creation-locks', key), operation);
}
