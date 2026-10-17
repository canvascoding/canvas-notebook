'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import { useChatAgentList } from './useChatAgentList';

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
  const { availableAgents, refreshAgents, acceptCreatedAgent, scopeKey } = useChatAgentList(workspaceId);
  const [requestedAgentId, setSelectedAgentId] = useState(initialAgentId);
  const selectedAgentId = availableAgents.some((agent) => agent.agentId === requestedAgentId)
    ? requestedAgentId
    : initialAgentId;

  useEffect(() => {
    if (sessionId || !workspaceId) {
      return;
    }
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
  }, [initialAgentId, scopeKey, sessionId, workspaceId]);

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
    acceptCreatedAgent,
    setActiveModel,
    setActiveProvider,
    setActiveThinkingLevel,
    setSelectedAgentId,
    updateAgentModelSelection,
  };
}
