import 'server-only';

import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { resolveAgentRuntimeSettings } from '@/app/lib/agents/effective-runtime-config';
import { isBrowserToolEnabledConfig } from '@/app/lib/pi/enabled-tools';

import type { BrowserRequirementStatus } from './requirements';
import {
  resolveBrowserRuntimeCapability,
  type BrowserRuntimeCapability,
} from './settings-service';
import {
  getBrowserProfileDetails,
  type BrowserRuntimeContext,
} from './runtime';
import type { BrowserProfileDetails } from './types';

export type BrowserRuntimeStatus = {
  agentId: string;
  toolEnabled: boolean;
  toolAvailable: boolean;
  requirements: BrowserRequirementStatus;
  capability: BrowserRuntimeCapability;
  profile: BrowserProfileDetails;
};

export function makeBrowserRuntimeContext(userId: string, rawAgentId?: string | null): BrowserRuntimeContext {
  return {
    userId,
    agentId: normalizeManagedAgentId(rawAgentId),
  };
}

export async function buildBrowserRuntimeStatus(input: {
  userId: string;
  agentId?: string | null;
}): Promise<BrowserRuntimeStatus> {
  const agentId = normalizeManagedAgentId(input.agentId);
  const context = makeBrowserRuntimeContext(input.userId, agentId);
  const [effectiveConfig, capability, profile] = await Promise.all([
    resolveAgentRuntimeSettings(agentId),
    resolveBrowserRuntimeCapability(),
    getBrowserProfileDetails(context),
  ]);
  const requirements = capability.requirements;
  const toolEnabled = isBrowserToolEnabledConfig(effectiveConfig.enabledTools);

  return {
    agentId,
    toolEnabled,
    toolAvailable: toolEnabled && capability.browserToolAvailable,
    requirements,
    capability,
    profile,
  };
}
