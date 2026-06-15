'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchChatAgentConfig, fetchChatAgents } from '@/app/lib/chat/agent-api';
import type {
  AgentConfig,
  AgentProfile,
} from '@/app/lib/chat/types';
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

export function resolveAgentModelState(config: AgentConfig | null): AgentModelState | null {
  if (!config?.piConfig) {
    return null;
  }

  const provider = config.effectiveConfig?.activeProvider || config.piConfig.activeProvider;
  const providerConfig = config.piConfig.providers?.[provider];
  const model = config.effectiveConfig?.model || providerConfig?.model;
  if (!provider || !model) {
    return null;
  }

  return {
    provider,
    model,
    thinkingLevel: config.effectiveConfig?.thinkingLevel || providerConfig?.thinking || DEFAULT_THINKING_LEVEL,
  };
}

export function resolveAgentProviderState(config: AgentConfig | null): AgentModelState {
  const provider = config?.effectiveConfig?.activeProvider || config?.piConfig?.activeProvider || DEFAULT_PROVIDER_ID;
  const providerConfig = provider ? config?.piConfig?.providers?.[provider] : undefined;
  const modelState = resolveAgentModelState(config);
  return {
    provider,
    model: modelState?.model || '',
    thinkingLevel: modelState?.thinkingLevel || providerConfig?.thinking || DEFAULT_THINKING_LEVEL,
  };
}

export function isAgentConfigForAgent(config: AgentConfig | null, agentId: string): boolean {
  const configAgentId = config?.effectiveConfig?.agentId;
  return !configAgentId || configAgentId === agentId;
}

export function useChatAgentConfig({
  initialAgentId,
  sessionId,
}: UseChatAgentConfigParams) {
  const [activeModel, setActiveModel] = useState(DEFAULT_MODEL_ID);
  const [activeProvider, setActiveProvider] = useState(DEFAULT_PROVIDER_ID);
  const [activeThinkingLevel, setActiveThinkingLevel] = useState<PiThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [isAgentConfigLoading, setIsAgentConfigLoading] = useState(true);
  const [availableAgents, setAvailableAgents] = useState<AgentProfile[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId);

  useEffect(() => {
    let cancelled = false;

    const fetchConfig = async () => {
      try {
        setAgentConfig(null);
        setIsAgentConfigLoading(true);
        const config = await fetchChatAgentConfig(selectedAgentId);
        if (!cancelled) {
          setAgentConfig(config);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch agent config', err);
        }
      } finally {
        if (!cancelled) {
          setIsAgentConfigLoading(false);
        }
      }
    };

    void fetchConfig();
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId]);

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
    if (sessionId) {
      return;
    }

    const providerState = resolveAgentProviderState(agentConfig);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveProvider(providerState.provider);
    setActiveModel(providerState.model);
    setActiveThinkingLevel(providerState.thinkingLevel);
  }, [agentConfig, sessionId]);

  const updateAgentModelSelection = useCallback((next: AgentModelState) => {
    setActiveModel(next.model);
    setActiveProvider(next.provider);
    setActiveThinkingLevel(next.thinkingLevel);
    setAgentConfig((current) => {
      const providerConfig = current?.piConfig?.providers?.[next.provider];
      if (!current || !providerConfig) {
        return current;
      }

      return {
        ...current,
        effectiveConfig: current.effectiveConfig
          ? {
              ...current.effectiveConfig,
              activeProvider: next.provider,
              model: next.model,
              thinkingLevel: next.thinkingLevel,
              setupState: current.effectiveConfig.setupState
                ? {
                    ...current.effectiveConfig.setupState,
                    modelConfigured: true,
                    issues: current.effectiveConfig.setupState.issues.filter((issue) => !issue.toLowerCase().includes('model')),
                  }
                : current.effectiveConfig.setupState,
            }
          : current.effectiveConfig,
        piConfig: {
          ...current.piConfig,
          activeProvider: next.provider,
          providers: {
            ...current.piConfig.providers,
            [next.provider]: {
              ...providerConfig,
              model: next.model,
              thinking: next.thinkingLevel,
            },
          },
        },
      };
    });
  }, []);

  return {
    activeModel,
    activeProvider,
    activeThinkingLevel,
    agentConfig,
    availableAgents,
    isAgentConfigLoading,
    selectedAgentId,
    setActiveModel,
    setActiveProvider,
    setActiveThinkingLevel,
    setSelectedAgentId,
    updateAgentModelSelection,
  };
}
