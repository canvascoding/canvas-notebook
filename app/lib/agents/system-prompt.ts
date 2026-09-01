import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { user as users } from '@/app/lib/db/schema';
import {
  CANVAS_INHERITED_FILE_NAMES,
  DEFAULT_MANAGED_AGENT_ID,
  readRuntimeManagedAgentFiles,
  type AgentStorageScope,
} from './storage';
import {
  composeManagedAgentSystemPrompt,
  MANAGED_PROMPT_FILE_NAMES,
  truncateComposedSystemPrompt,
  type ManagedPromptFiles,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';
import { getAgentProfile } from './registry';
import { loadSkillsFromDisk, getSkillsContext } from '../skills/skill-loader';
import { selectPromptSkillsForAgent } from '../skills/agent-skill-selection';
import { readEnabledSkillsForScope } from '../skills/skill-settings';
import {
  loadEffectiveSkills,
  resolveEffectiveCapabilitySnapshot,
} from '../capabilities/catalog';
import { readOnboardingBootstrapPrompt } from '../onboarding/profile';
import { isOnboardingComplete } from '../onboarding/status';
import { ensureLegacyMemoryMigrated } from '../memory/legacy-migration';

export {
  composeManagedAgentSystemPrompt,
  type ManagedPromptDiagnostics,
  type ManagedPromptFileName,
  type ManagedPromptFiles,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';

function createEmptyManagedPromptFiles(): ManagedPromptFiles {
  return Object.fromEntries(
    MANAGED_PROMPT_FILE_NAMES.map((fileName) => [fileName, '']),
  ) as ManagedPromptFiles;
}

function compactPromptMetadata(value?: string | null, maxChars = 160): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() || '';
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}...` : normalized;
}

async function resolveAuthenticatedUserName(scope?: AgentStorageScope | null): Promise<string | null> {
  const providedName = compactPromptMetadata(scope?.userName);
  if (providedName) {
    return providedName;
  }

  const userId = scope?.userId?.trim();
  if (!userId) {
    return null;
  }

  try {
    const rows = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return compactPromptMetadata(rows[0]?.name) || null;
  } catch (error) {
    console.warn('[system-prompt] Failed to load authenticated user name:', error);
    return null;
  }
}

async function buildAuthenticatedUserContext(scope?: AgentStorageScope | null): Promise<string> {
  const userName = await resolveAuthenticatedUserName(scope);
  if (!userName) {
    return '';
  }

  return [
    '## Authenticated User Context',
    '',
    `User display name: ${JSON.stringify(userName)}`,
    'Use this as the user\'s name when useful for personalization. Do not infer private facts, roles, or identity claims from the name alone.',
  ].join('\n');
}

function buildReadFailedFallbackSystemPrompt(agentId: string): ManagedSystemPromptResult {
  const fallback = composeManagedAgentSystemPrompt(
    createEmptyManagedPromptFiles(),
    undefined,
    { agentId },
  );
  return {
    systemPrompt: fallback.systemPrompt,
    diagnostics: {
      loadedFiles: [],
      includedFiles: [],
      emptyFiles: [],
      truncatedFiles: [],
      usedFallback: true,
      fallbackReason: 'read-failed',
    },
  };
}

async function buildOnboardingBootstrapContext(normalizedAgentId: string): Promise<string> {
  if (normalizedAgentId !== DEFAULT_MANAGED_AGENT_ID) {
    return '';
  }

  try {
    if (await isOnboardingComplete()) {
      return '';
    }

    const bootstrapPrompt = await readOnboardingBootstrapPrompt();
    if (!bootstrapPrompt) {
      return '';
    }

    return [
      '## Onboarding Bootstrap',
      '',
      'The following setup-only instructions apply while the initial Bradley onboarding is incomplete.',
      '',
      bootstrapPrompt,
    ].join('\n');
  } catch {
    return '';
  }
}

export async function loadManagedAgentSystemPrompt(
  agentId?: string | null,
  scope?: AgentStorageScope | null,
): Promise<ManagedSystemPromptResult> {
  const normalizedAgentId = agentId?.trim().toLowerCase() || DEFAULT_MANAGED_AGENT_ID;
  try {
    const agentProfile = await getAgentProfile(normalizedAgentId);
    const agentStorageScope: AgentStorageScope = {
      ...scope,
      agentScopeType: agentProfile?.scopeType,
      ownerUserId: agentProfile?.ownerUserId,
      organizationId: agentProfile?.organizationId || scope?.organizationId,
    };
    await ensureLegacyMemoryMigrated(normalizedAgentId, agentStorageScope);
    const files = await readRuntimeManagedAgentFiles(normalizedAgentId, agentStorageScope);
    
    // Resolve the complete organization/user capability cascade when workspace
    // context is available. Legacy callers keep the existing user-only loader.
    const capabilitySnapshot = scope?.organizationId && scope.userId
      ? await resolveEffectiveCapabilitySnapshot({
        organizationId: scope.organizationId,
        userId: scope.userId,
        role: scope.role,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      })
      : null;
    const skills = capabilitySnapshot
      ? await loadEffectiveSkills(capabilitySnapshot)
      : await loadSkillsFromDisk(await readEnabledSkillsForScope(scope), scope);
    const requiredSkillNames = capabilitySnapshot?.capabilities
      .filter((entry) => (
        entry.ref.resourceType === 'skill'
        && entry.effectivePolicy === 'required'
        && entry.effectiveEnabled
        && entry.readiness === 'available'
      ))
      .map((entry) => entry.ref.name) || [];

    // Bradley receives all effectively enabled skills. Specialized
    // agents receive their selected subset after organization policy resolution.
    const promptSkills = selectPromptSkillsForAgent(
      normalizedAgentId,
      skills,
      agentProfile?.relevantSkills,
      requiredSkillNames,
    );
    const skillsContext = getSkillsContext(promptSkills);
    
    const result = composeManagedAgentSystemPrompt(files, skillsContext, {
      agentId: normalizedAgentId,
      inheritedFiles: normalizedAgentId === DEFAULT_MANAGED_AGENT_ID ? [] : CANVAS_INHERITED_FILE_NAMES,
      scope: agentStorageScope,
    });
    
    let systemPrompt = result.systemPrompt;
    const authenticatedUserContext = await buildAuthenticatedUserContext(scope);
    if (authenticatedUserContext) {
      systemPrompt += '\n\n' + authenticatedUserContext;
    }

    const onboardingBootstrapContext = await buildOnboardingBootstrapContext(normalizedAgentId);
    if (onboardingBootstrapContext) {
      systemPrompt += '\n\n' + onboardingBootstrapContext;
    }

    return { ...result, systemPrompt: truncateComposedSystemPrompt(systemPrompt) };
  } catch (error) {
    console.error('[system-prompt] Failed to load managed agent system prompt:', error);
    return buildReadFailedFallbackSystemPrompt(normalizedAgentId);
  }
}
