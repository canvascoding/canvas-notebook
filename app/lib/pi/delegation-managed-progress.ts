import 'server-only';

import { createHash } from 'node:crypto';
import type { RuntimeInstance } from '@/app/lib/pi/delegation-managed-steering';
import { appendPiDelegationProgress } from '@/app/lib/pi/delegation-progress';
import type { DelegateTaskRequest } from '@/app/lib/pi/delegate-task-tool';

/** Persist only runtime boundaries and safe tool names; never copy event payloads. */
export function attachManagedProgressBridge(runtime: RuntimeInstance, request: DelegateTaskRequest): () => Promise<void> {
  if (!request.delegationId) return async () => {};
  const delegationId = request.delegationId;
  const userId = request.userId;
  let pending = Promise.resolve();
  let closed = false;
  const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
  const append = (kind: 'tool_start' | 'tool_end' | 'compacting' | 'resumed', eventKey: string, preview?: string) => {
    pending = pending.then(async () => {
      try {
        await appendPiDelegationProgress({ delegationId, userId, kind, eventKey, preview });
      } catch (error) {
        console.warn('[delegate_task] Managed progress checkpoint failed.', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    });
  };
  const unsubscribeAgent = runtime.agent.subscribe((event) => {
    if (closed) return;
    if ((event.type === 'tool_execution_start' || event.type === 'tool_execution_end')
      && typeof event.toolCallId === 'string') {
      const kind = event.type === 'tool_execution_start' ? 'tool_start' : 'tool_end';
      append(kind, `managed:${kind}:${key(event.toolCallId)}`, event.toolName);
    }
  });
  const unsubscribeRuntime = runtime.subscribe((event) => {
    if (closed) return;
    if (event.type === 'runtime_status' && event.status
      && 'compactionStatus' in event.status && event.status.compactionStatus
      && typeof event.status.compactionStatus === 'object'
      && 'state' in event.status.compactionStatus && event.status.compactionStatus.state === 'running'
      && 'attemptId' in event.status.compactionStatus && typeof event.status.compactionStatus.attemptId === 'string') {
      append('compacting', `managed:compacting:${key(event.status.compactionStatus.attemptId)}`);
    }
    if (event.type === 'context_compacted' && 'attemptId' in event && typeof event.attemptId === 'string') {
      append('resumed', `managed:resumed:${key(event.attemptId)}`);
    }
    if (event.type === 'runtime_status' && event.status?.phase === 'idle' && !event.status.canAbort) {
      closed = true;
      unsubscribeAgent();
      unsubscribeRuntime();
    }
  });
  return async () => {
    closed = true;
    unsubscribeAgent();
    unsubscribeRuntime();
    await pending;
  };
}
