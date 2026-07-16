'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchChatAgents } from '@/app/lib/chat/agent-api';
import { fetchLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import type { AgentProfile } from '@/app/lib/chat/types';
import type { PiThinkingLevel } from '@/app/lib/pi/config';

export const DEFAULT_PROVIDER_ID = '';
export const DEFAULT_MODEL_ID = '';
export const DEFAULT_THINKING_LEVEL: PiThinkingLevel = 'off';

export type AgentModelState = {
  provider: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
};

type UseChatAgentConfigParams = {
  initialAgentId: string;
  sessionId: string | null;
  workspaceId: string | null;
};

export function useChatAgentConfig({
  initialAgentId,
  sessionId,
  workspaceId,
}: UseChatAgentConfigParams) {
  const [activeModel, setActiveModel] = useState(DEFAULT_MODEL_ID);
  const [activeProvider, setActiveProvider] = useState(DEFAULT_PROVIDER_ID);
  const [activeThinkingLevel, setActiveThinkingLevel] = useState<PiThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [agentListState, setAgentListState] = useState<{
    workspaceId: string | null;
    agents: AgentProfile[];
  }>({ workspaceId: null, agents: [] });
  const [requestedAgentId, setSelectedAgentId] = useState(initialAgentId);
  const agentsRequestSequenceRef = useRef(0);
  const preferredAgentLoadedRef = useRef(false);
  const availableAgents = agentListState.workspaceId === workspaceId
    ? agentListState.agents
    : [];
  const selectedAgentId = availableAgents.some((agent) => agent.agentId === requestedAgentId)
    ? requestedAgentId
    : initialAgentId;

  const refreshAgents = useCallback(async () => {
    const requestSequence = ++agentsRequestSequenceRef.current;
    if (!workspaceId) return;
    const agents = await fetchChatAgents(workspaceId);
    if (requestSequence === agentsRequestSequenceRef.current) {
      setAgentListState({ workspaceId, agents });
    }
  }, [workspaceId]);

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        await refreshAgents();
      } catch (err) {
        console.error('Failed to fetch agents', err);
      }
    };

    void fetchAgents();
  }, [refreshAgents]);

  useEffect(() => {
    if (sessionId || preferredAgentLoadedRef.current) {
      return;
    }
    preferredAgentLoadedRef.current = true;
    let cancelled = false;

    const fetchPreferredAgent = async () => {
      const preferredAgentId = await fetchLastActiveAgentId();
      if (cancelled) return;
      setSelectedAgentId((current) => (
        current === initialAgentId ? preferredAgentId : current
      ));
    };

    void fetchPreferredAgent();

    return () => {
      cancelled = true;
    };
  }, [initialAgentId, sessionId]);

  const updateAgentModelSelection = useCallback((next: AgentModelState) => {
    setActiveModel(next.model);
    setActiveProvider(next.provider);
    setActiveThinkingLevel(next.thinkingLevel);
  }, []);

  return {
    activeModel,
    activeProvider,
    activeThinkingLevel,
    availableAgents,
    selectedAgentId,
    refreshAgents,
    setActiveModel,
    setActiveProvider,
    setActiveThinkingLevel,
    setSelectedAgentId,
    updateAgentModelSelection,
  };
}
