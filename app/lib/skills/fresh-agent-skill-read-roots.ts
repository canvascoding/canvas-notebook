import 'server-only';

import path from 'node:path';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { loadCapabilityCandidates } from '@/app/lib/capabilities/catalog';
import { resolveEffectiveCapabilities } from '@/app/lib/capabilities/effective-resolver';
import { withCapabilityPolicyStore } from '@/app/lib/capabilities/policy-store';
import { resolveCapabilityExecutionContextForUser } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { getEffectiveSkillReadRoots } from './effective-skill-read-roots';
import { revalidateCapabilityPackageRuntimeBindings } from '@/app/lib/capabilities/packages/runtime-bindings';

/** Revalidate server-issued roots without discovering providers or granting new paths. */
export async function resolveFreshAgentSkillReadRoots(executionContext: AgentExecutionContext): Promise<string[]> {
  const captured = { ...executionContext, skillReadRoots: [...(executionContext.skillReadRoots ?? [])] };
  const approved = [...new Set(captured.skillReadRoots.map(root => path.resolve(root)))];
  if (!approved.length) return [];

  const state = await readOrganizationPermissionForUser(captured.userId);
  if ((state.configured && state.permission?.status !== 'active')
    || (state.organizationId ?? null) !== captured.organizationId) return [];
  const context = state.organizationId && state.permission?.status === 'active'
    ? await resolveCapabilityExecutionContextForUser({ userId: captured.userId, organizationId: state.organizationId,
      role: state.permission.role, requestedWorkspaceId: captured.workspaceId })
    : { userId: captured.userId, organizationId: '', ...(await resolveAgentSessionWorkspaceForUser({
      userId: captured.userId, workspaceId: captured.workspaceId, permissions: ['canRead', 'canRunAgent'],
    })) };
  if (context.workspaceId !== captured.workspaceId || (context.organizationId || null) !== captured.organizationId) return [];
  const agentId = normalizeManagedAgentId(captured.agentId);
  const [candidates, policies, profile] = await Promise.all([
    loadCapabilityCandidates({ ...context, organizationId: context.organizationId || '' }, { resolveConnections: false }),
    context.organizationId ? withCapabilityPolicyStore(store => store.listOrganizationPolicies(context.organizationId!)) : [],
    getAgentProfile(agentId),
  ]);
  // This boundary confirms local package permissions and activation only. A
  // captured root already passed its initial readiness check; deliberately
  // undiscovered provider health must neither revoke it nor grant a new root.
  const executionCandidates = candidates.map(candidate => candidate.ref.resourceType === 'plugin'
    ? { ...candidate, connectionRequirementCount: 0 } : candidate);
  const snapshot = resolveEffectiveCapabilities({ context: { ...context, organizationId: context.organizationId || '' },
    candidates: executionCandidates, policies });
  const current = new Set(getEffectiveSkillReadRoots({ snapshot, agentId, relevantSkills: profile?.relevantSkills })
    .map(root => path.resolve(root)));
  const bindings = await revalidateCapabilityPackageRuntimeBindings(captured, snapshot, profile?.relevantSkills);
  const declaredManagedRoots = new Set((captured.skillPackageBindings ?? []).map(binding => path.dirname(path.resolve(binding.runtimePath))));
  const managedRoots = new Set(bindings.map(binding => path.dirname(path.resolve(binding.runtimePath))));
  return approved.filter(root => managedRoots.has(root) || (!declaredManagedRoots.has(root)
    && !root.split(path.sep).join('/').includes('/capability-packages/published/') && current.has(root)));
}

/** A shell may retain arbitrary path references, so a revoked captured root closes its launch. */
export async function revalidateAgentBashSkillReadRoots(executionContext: AgentExecutionContext | null): Promise<AgentExecutionContext | null> {
  if (!executionContext) return null;
  const captured = { ...executionContext, skillReadRoots: [...(executionContext.skillReadRoots ?? [])] };
  const current = await resolveFreshAgentSkillReadRoots(captured);
  const approved = [...new Set(captured.skillReadRoots.map(root => path.resolve(root)))];
  if (current.length !== approved.length) throw new Error('Skill access is unavailable. Reload the agent context before running Bash.');
  return { ...captured, skillReadRoots: current };
}
