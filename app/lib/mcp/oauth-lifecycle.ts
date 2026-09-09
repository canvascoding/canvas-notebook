import { requireMcpCredentialScope, type McpScope } from '@/app/lib/mcp/scope';
import { readMcpTextFileIfExists, writeMcpTextFileAtomic } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';

export type McpOAuthLifecycle = {
  connectionId: string;
  generation: number;
  lastCompletedState?: string;
  updatedAt: string;
};

function lifecyclePath(connectionId: string): string {
  return `oauth-lifecycle/${connectionId}.json`;
}

function validateConnectionId(connectionId: string): void {
  if (!/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|system-[a-f0-9]{64})$/u.test(connectionId)) throw new Error('Invalid MCP OAuth lifecycle connection ID.');
}

async function readLifecycleFile(connectionId: string, scope?: McpScope | null): Promise<McpOAuthLifecycle> {
  validateConnectionId(connectionId);
  const { content } = await readMcpTextFileIfExists(lifecyclePath(connectionId), requireMcpCredentialScope(scope));
  if (content === null) return { connectionId, generation: 0, updatedAt: new Date(0).toISOString() };
  const parsed = JSON.parse(content) as McpOAuthLifecycle;
  if (parsed.connectionId !== connectionId || !Number.isSafeInteger(parsed.generation) || parsed.generation < 0) throw new Error('Invalid MCP OAuth lifecycle record.');
  return parsed;
}

async function writeLifecycleFile(value: McpOAuthLifecycle, scope?: McpScope | null): Promise<void> {
  validateConnectionId(value.connectionId);
  await writeMcpTextFileAtomic(lifecyclePath(value.connectionId), JSON.stringify(value), requireMcpCredentialScope(scope), { mode: 0o600 });
}

export async function withMcpOAuthLifecycleLock<T>(connectionId: string, scope: McpScope | null | undefined, task: () => Promise<T>): Promise<T> {
  validateConnectionId(connectionId);
  return withMcpStorageLock(`oauth-${connectionId}`, requireMcpCredentialScope(scope), task);
}

export async function withMcpOAuthGenerationLock<T>(connectionId: string, scope: McpScope | null | undefined, task: () => Promise<T>): Promise<T> {
  validateConnectionId(connectionId);
  return withMcpStorageLock(`oauth-generation-${connectionId}`, requireMcpCredentialScope(scope), task);
}

export async function readMcpOAuthLifecycle(connectionId: string, scope?: McpScope | null): Promise<McpOAuthLifecycle> {
  return readLifecycleFile(connectionId, scope);
}

export async function invalidateMcpOAuthGeneration(connectionId: string, scope?: McpScope | null): Promise<McpOAuthLifecycle> {
  return withMcpOAuthGenerationLock(connectionId, scope, async () => {
    const current = await readMcpOAuthLifecycle(connectionId, scope);
    const next = { connectionId, generation: current.generation + 1, updatedAt: new Date().toISOString() } satisfies McpOAuthLifecycle;
    await writeLifecycleFile(next, scope);
    return next;
  });
}

export const invalidateMcpOAuthLifecycle = invalidateMcpOAuthGeneration;

export async function completeMcpOAuthLifecycle(connectionId: string, generation: number, state: string, scope?: McpScope | null): Promise<void> {
  await withMcpOAuthGenerationLock(connectionId, scope, async () => {
    const current = await readMcpOAuthLifecycle(connectionId, scope);
    if (current.generation !== generation) throw new Error('OAuth lifecycle was invalidated.');
    await writeLifecycleFile({
      ...current,
      lastCompletedState: state,
      updatedAt: new Date().toISOString(),
    } satisfies McpOAuthLifecycle, scope);
  });
}

export async function commitMcpOAuthLifecycle<T>(connectionId: string, generation: number, state: string, scope: McpScope | null | undefined, task: () => Promise<T>): Promise<T> {
  return withMcpOAuthGenerationLock(connectionId, scope, async () => {
    const current = await readMcpOAuthLifecycle(connectionId, scope);
    if (current.generation !== generation) throw new Error('OAuth lifecycle was invalidated.');
    const result = await task();
    await writeLifecycleFile({ ...current, lastCompletedState: state, updatedAt: new Date().toISOString() } satisfies McpOAuthLifecycle, scope);
    return result;
  });
}

export async function fencedMcpOAuthWrite<T>(connectionId: string, generation: number, scope: McpScope | null | undefined, task: () => Promise<T>): Promise<T> {
  return withMcpOAuthGenerationLock(connectionId, scope, async () => {
    if ((await readMcpOAuthLifecycle(connectionId, scope)).generation !== generation) throw new Error('OAuth lifecycle was invalidated.');
    return task();
  });
}
