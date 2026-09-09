import type { AgentToolResult } from '@earendil-works/pi-agent-core';

// Process-local identity cannot be forged by a JSON field in a provider response.
// Mark metadata as well: browser/web adapters copy the outer result/details.
const prepared = new WeakSet<object>();

export function markPreparedToolOutput<T extends AgentToolResult<unknown>>(result: T): T {
  prepared.add(result);
  const metadata = (result.details as { toolOutput?: unknown } | null)?.toolOutput;
  if (metadata && typeof metadata === 'object') prepared.add(metadata);
  return result;
}

export function isPreparedToolOutput(result: AgentToolResult<unknown>): boolean {
  const metadata = (result.details as { toolOutput?: unknown } | null)?.toolOutput;
  return prepared.has(result) || Boolean(metadata && typeof metadata === 'object' && prepared.has(metadata));
}
