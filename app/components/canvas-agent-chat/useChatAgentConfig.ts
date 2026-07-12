'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchChatAgents } from '@/app/lib/chat/agent-api';
import { fetchLastActiveAgentId, saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
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
};

export function useChatAgentConfig({
  initialAgentId,
  sessionId,
}: UseChatAgentConfigParams) {
  const [activeModel, setActiveModel] = useState(DEFAULT_MODEL_ID);
  const [activeProvider, setActiveProvider] = useState(DEFAULT_PROVIDER_ID);
  const [activeThinkingLevel, setActiveThinkingLevel] = useState<PiThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [availableAgents, setAvailableAgents] = useState<AgentProfile[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId);
  const preferredAgentLoadedRef = useRef(false);

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        setAvailableAgents(await fetchChatAgents());
      } catch (err) {
        console.error('Failed to fetch agents', err);
      }
    };

    void fetchAgents();
  }, []);

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

  useEffect(() => {
    if (availableAgents.length === 0) {
      return;
    }
    const selectedAgentExists = availableAgents.some((agent) => agent.agentId === selectedAgentId);
    if (!selectedAgentExists) {
      Promise.resolve().then(() => {
        setSelectedAgentId(initialAgentId);
        void saveLastActiveAgentId(initialAgentId);
      });
    }
  }, [availableAgents, initialAgentId, selectedAgentId]);

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
    setActiveModel,
    setActiveProvider,
    setActiveThinkingLevel,
    setSelectedAgentId,
    updateAgentModelSelection,
  };
}
