'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentWorkflowManagementOptions, AgentWorkflowManagementRequest } from '@/app/lib/agents/workflow-management-contracts';
import { agentWorkflowManagementContextKey, readAgentWorkflowManagementOptions,
  type AgentWorkflowManagementContext } from './agent-workflow-management-client';

export type WorkflowManagementReadError = 'conflict' | 'denied' | 'load';
export function workflowManagementReadError(error: unknown): WorkflowManagementReadError {
  const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined;
  return status === 409 ? 'conflict' : [401, 403, 404].includes(status) ? 'denied' : 'load';
}

/** Each lazy surface owns its transport; no response survives a context change or a newer request. */
export function useWorkflowManagementOptions(context: AgentWorkflowManagementContext,
  onAuthorityError: (error: 'conflict' | 'denied') => void) {
  const [result, setResult] = useState<AgentWorkflowManagementOptions | null>(null);
  const [error, setError] = useState<WorkflowManagementReadError | null>(null);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const authorityError = useRef(onAuthorityError);
  useEffect(() => { authorityError.current = onAuthorityError; }, [onAuthorityError]);
  const contextKey = agentWorkflowManagementContextKey(context);
  useEffect(() => () => { generation.current += 1; controller.current?.abort(); }, [contextKey]);
  const run = useCallback(async (request: AgentWorkflowManagementRequest) => {
    controller.current?.abort();
    const current = new AbortController(), id = ++generation.current;
    controller.current = current; setLoading(true); setError(null);
    try {
      const next = await readAgentWorkflowManagementOptions(context, request, current.signal);
      if (current.signal.aborted || generation.current !== id) return null;
      setResult(next); return next;
    } catch (failure) {
      if (current.signal.aborted || generation.current !== id) return null;
      const code = workflowManagementReadError(failure); setError(code);
      if (code !== 'load') authorityError.current(code);
      return null;
    } finally { if (!current.signal.aborted && generation.current === id) setLoading(false); }
  }, [context]);
  return { result, error, loading, run };
}
