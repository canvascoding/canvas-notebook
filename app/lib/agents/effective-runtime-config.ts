import 'server-only';

import type { Api, Model } from '@mariozechner/pi-ai';

import type { AgentProfile } from './registry';
import { getAgentProfile, normalizeManagedAgentId } from './registry';
import { DEFAULT_MANAGED_AGENT_ID, readPiRuntimeConfig } from './storage';
import type { PiProviderConfig, PiRuntimeConfig, PiThinkingLevel } from '@/app/lib/pi/config';

type AgentOverrideState = {
  model: boolean;
  tools: boolean;
};

export type EffectiveAgentRuntimeConfig = {
  agent: AgentProfile;
  agentId: string;
  isMainAgent: boolean;
  piConfig: PiRuntimeConfig;
  mainPiConfig: PiRuntimeConfig;
  activeProvider: string;
  providerConfig: PiProviderConfig;
  model: Model<Api>;
  thinkingLevel: PiThinkingLevel;
  enabledTools: string[];
  overrideState: AgentOverrideState;
};

export type EffectiveAgentRuntimeSettings = Omit<EffectiveAgentRuntimeConfig, 'model'>;

function clonePiConfig(config: PiRuntimeConfig): PiRuntimeConfig {
  return JSON.parse(JSON.stringify(config)) as PiRuntimeConfig;
}

function emptyProviderConfig(providerId: string): PiProviderConfig {
  return {
    id: providerId,
    model: '',
    thinking: 'off',
    enabledTools: [],
  };
}

function isModelOverrideConfigured(agent: AgentProfile): boolean {
  return Boolean(agent.defaultProvider?.trim() && agent.defaultModel?.trim());
}

function resolveEffectiveProviderConfig(
  mainPiConfig: PiRuntimeConfig,
  agent: AgentProfile,
): {
  activeProvider: string;
  providerConfig: PiProviderConfig;
  overrideState: AgentOverrideState;
} {
  const isMainAgent = agent.agentId === DEFAULT_MANAGED_AGENT_ID;
  const modelOverride = !isMainAgent && isModelOverrideConfigured(agent);
  const activeProvider = modelOverride ? agent.defaultProvider! : mainPiConfig.activeProvider;
  const inheritedProviderConfig = mainPiConfig.providers[activeProvider] || emptyProviderConfig(activeProvider);
  const toolsOverride = !isMainAgent && Array.isArray(agent.enabledTools);

  return {
    activeProvider,
    overrideState: {
      model: modelOverride,
      tools: toolsOverride,
    },
    providerConfig: {
      ...inheritedProviderConfig,
      id: activeProvider,
      model: modelOverride ? agent.defaultModel! : inheritedProviderConfig.model,
      thinking: modelOverride ? (agent.defaultThinking || inheritedProviderConfig.thinking || 'off') : inheritedProviderConfig.thinking || 'off',
      enabledTools: toolsOverride ? agent.enabledTools! : inheritedProviderConfig.enabledTools || [],
    },
  };
}

export async function resolveAgentRuntimeSettings(agentIdInput?: string | null): Promise<EffectiveAgentRuntimeSettings> {
  const agentId = normalizeManagedAgentId(agentIdInput);
  const [mainPiConfig, agent] = await Promise.all([
    readPiRuntimeConfig(),
    getAgentProfile(agentId),
  ]);

  if (!agent) {
    throw new Error('Agent not found.');
  }

  const { activeProvider, providerConfig, overrideState } = resolveEffectiveProviderConfig(mainPiConfig, agent);
  const effectivePiConfig = clonePiConfig(mainPiConfig);
  effectivePiConfig.activeProvider = activeProvider;
  effectivePiConfig.providers = {
    ...effectivePiConfig.providers,
    [activeProvider]: providerConfig,
  };

  return {
    agent,
    agentId,
    isMainAgent: agentId === DEFAULT_MANAGED_AGENT_ID,
    piConfig: effectivePiConfig,
    mainPiConfig,
    activeProvider,
    providerConfig,
    thinkingLevel: providerConfig.thinking || 'off',
    enabledTools: providerConfig.enabledTools || [],
    overrideState,
  };
}

export async function resolveAgentRuntimeConfig(agentIdInput?: string | null): Promise<EffectiveAgentRuntimeConfig> {
  const settings = await resolveAgentRuntimeSettings(agentIdInput);
  const { resolvePiModel } = await import('@/app/lib/pi/model-resolver');

  return {
    ...settings,
    model: await resolvePiModel(settings.activeProvider, settings.providerConfig.model),
  };
}
