import 'server-only';

import { createHash } from 'node:crypto';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  captureCapabilityPackageRuntimeBindings,
  getAuthorizedAgentWorkflowPackageMetadata,
  getAuthorizedAgentWorkflowPackageSelections,
  getAuthorizedAgentWorkflowSkillMetadata,
  isAuthorizedAgentWorkflowPackageSelections,
  type AuthorizedAgentWorkflowPackageMetadata,
  type AuthorizedAgentWorkflowPackageSelections,
  type AuthorizedAgentWorkflowSkillMetadata,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import { resolveAgentWorkflowRuntimeProjection, type AgentWorkflowRuntimeProjection } from '@/app/lib/agents/workflow-runtime';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';

/** Only this small opaque handle may travel with server context copies. */
export type HeldEffectiveExtensionContext = Readonly<{ kind: 'effective_extension_context'; fingerprint: string }>;
export type EffectiveExtensionContextData = Readonly<{
  fingerprint: string;
  mode: 'general' | 'legacy_specialized' | 'fixed';
  packageSelection: AuthorizedAgentWorkflowPackageSelections;
  packages: readonly AuthorizedAgentWorkflowPackageMetadata[];
  skills: readonly AuthorizedAgentWorkflowSkillMetadata[];
  workflowProjection: AgentWorkflowRuntimeProjection | null;
}>;
type Record = { actorKey: string; data: EffectiveExtensionContextData };
const host = globalThis as typeof globalThis & { __canvasEffectiveExtensionContextsV1?: WeakMap<object, Record> };
const records = host.__canvasEffectiveExtensionContextsV1 ??= new WeakMap<object, Record>();

function actorKey(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId, context.organizationId,
    context.workspaceId, context.workspaceType, context.workspaceRoot, context.workspaceRootRelativePath,
    context.projectId, context.customerId, context.canWrite, context.canDelete, context.canShare,
    context.turnExtensions ?? null]);
}

/**
 * One actual issued package selection supplies roots, prompt metadata and exact
 * provider hints. None of this replaces fresh file/describe/call authorization.
 */
export async function resolveEffectiveExtensionContext(contextInput: AgentExecutionContext,
  options: { packageSelection?: AuthorizedAgentWorkflowPackageSelections } = {}): Promise<AgentExecutionContext> {
  const context = { ...contextInput, ...(contextInput.turnExtensions ? { turnExtensions: structuredClone(contextInput.turnExtensions) } : {}) };
  const namespace = actorKey(context);
  const selection = options.packageSelection ?? await getAuthorizedAgentWorkflowPackageSelections(context);
  if (!isAuthorizedAgentWorkflowPackageSelections(selection, context)) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'A current issued extension selection is required.', 403);
  }
  const captured = await captureCapabilityPackageRuntimeBindings(context, { selection });
  const packages = getAuthorizedAgentWorkflowPackageMetadata(selection, context);
  const skills = await getAuthorizedAgentWorkflowSkillMetadata(selection, context, { bindings: captured.skillPackageBindings });
  const workflowProjection = await resolveAgentWorkflowRuntimeProjection(context, { packageSelection: selection });
  const mode = selection.snapshot.agent.agentId === DEFAULT_MANAGED_AGENT_ID ? 'general'
    : selection.workflowVersion === null ? 'legacy_specialized' : 'fixed';
  const fingerprint = createHash('sha256').update(JSON.stringify([namespace, selection.fingerprint,
    workflowProjection?.revision ?? null, captured.skillPackageBindings.map(binding => [binding.resourceRef,
      binding.publishedRevisionRef, binding.childRelativeRoot, binding.checksum]), skills.map(skill => [skill.resourceId,
      skill.runtimePath, skill.core, skill.required])])).digest('hex');
  const proof = Object.freeze({ kind: 'effective_extension_context' as const, fingerprint });
  records.set(proof, { actorKey: namespace, data: Object.freeze({ fingerprint, mode, packageSelection: selection, packages, skills, workflowProjection }) });
  return { ...context, skillReadRoots: captured.skillReadRoots, skillPackageBindings: captured.skillPackageBindings, effectiveExtensions: proof };
}

/** Server-only metadata access, not an execution grant. Clones and changed scopes are rejected. */
export function readEffectiveExtensionContext(context: AgentExecutionContext): EffectiveExtensionContextData | null {
  if (!context.effectiveExtensions) return null;
  const record = records.get(context.effectiveExtensions);
  if (!record || record.actorKey !== actorKey(context)) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The issued extension context no longer matches this turn.', 403);
  }
  return record.data;
}
