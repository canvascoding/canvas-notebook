import { isCoreExtensionSelection } from './core-source-contracts';
import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  captureCapabilityPackageRuntimeBindings,
  getAuthorizedCapabilityPackageRuntimeBindings,
  getAuthorizedAgentWorkflowPackageMetadata,
  getAuthorizedAgentWorkflowPackageSelections,
  getAuthorizedAgentWorkflowSkillMetadata,
  getAuthorizedCorePluginSkillRuntimeBindings,
  getAuthorizedCorePluginContextMetadata,
  isAuthorizedAgentWorkflowPackageSelections,
  type AuthorizedAgentWorkflowPackageMetadata,
  type AuthorizedAgentWorkflowPackageSelections,
  type AuthorizedAgentWorkflowSkillMetadata,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import { resolveAgentWorkflowRuntimeProjection, type AgentWorkflowRuntimeProjection } from '@/app/lib/agents/workflow-runtime';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { hasIssuedTurnExtensionSource, type HeldAcceptedTurnRuntimeSelection } from './turn-runtime';
import type { HeldDelegatedExtensionSource } from './delegation-source';
import type { CoreInstructionContextMetadata } from '../packages/core-context-metadata';

/** Only this small opaque handle may travel with server context copies. */
export type HeldEffectiveExtensionContext = Readonly<{ kind: 'effective_extension_context'; fingerprint: string }>;
export type EffectiveExtensionContextData = Readonly<{
  fingerprint: string;
  mode: 'general' | 'legacy_specialized' | 'fixed';
  packageSelection: AuthorizedAgentWorkflowPackageSelections;
  packages: readonly AuthorizedAgentWorkflowPackageMetadata[];
  corePackages?: readonly CoreInstructionContextMetadata[];
  skills: readonly AuthorizedAgentWorkflowSkillMetadata[];
  workflowProjection: AgentWorkflowRuntimeProjection | null;
}>;
type Record = { actorKey: string; turnSource?: HeldAcceptedTurnRuntimeSelection;
  delegatedSource?: HeldDelegatedExtensionSource; data: EffectiveExtensionContextData };
const host = globalThis as typeof globalThis & { __canvasEffectiveExtensionContextsV1?: WeakMap<object, Record> };
const records = host.__canvasEffectiveExtensionContextsV1 ??= new WeakMap<object, Record>();

function actorKey(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId, context.organizationId,
    context.workspaceId, context.workspaceType, context.workspaceRoot, context.workspaceRootRelativePath,
    context.projectId, context.customerId, context.canWrite, context.canDelete, context.canShare,
    context.turnExtensions ?? null, context.turnExtensionSource?.fingerprint ?? null, context.delegatedExtensionSource?.fingerprint ?? null,
    context.turnExtensionSource ? context.agentTurnId ?? null : null]);
}

/**
 * One actual issued package selection supplies roots, prompt metadata and exact
 * provider hints. None of this replaces fresh file/describe/call authorization.
 */
export async function resolveEffectiveExtensionContext(contextInput: AgentExecutionContext,
  options: { packageSelection?: AuthorizedAgentWorkflowPackageSelections; preserveIssuedBindings?: boolean } = {}): Promise<AgentExecutionContext> {
  const context = { ...contextInput, ...(contextInput.turnExtensions ? { turnExtensions: structuredClone(contextInput.turnExtensions) } : {}) };
  const namespace = actorKey(context);
  const selection = options.packageSelection ?? await getAuthorizedAgentWorkflowPackageSelections(context);
  if (!isAuthorizedAgentWorkflowPackageSelections(selection, context)) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'A current issued extension selection is required.', 403);
  }
  const fresh = await captureCapabilityPackageRuntimeBindings(context, { selection });
  const retained = options.preserveIssuedBindings ? await getAuthorizedCapabilityPackageRuntimeBindings(context, { selection }) : null;
  // Delegation reissues the parent's actual held source for this child actor.
  // Keep those exact immutable versions; current legacy roots can only narrow.
  const freshPublishedRoots = new Set(fresh.skillPackageBindings.map(binding => path.dirname(path.resolve(binding.runtimePath))));
  const previousRoots = new Set((context.skillReadRoots ?? []).map(root => path.resolve(root)));
  const captured = retained === null ? fresh : {
    skillPackageBindings: retained,
    corePluginSkillBindings: context.corePluginSkillBindings
      ? await getAuthorizedCorePluginSkillRuntimeBindings(context, { selection }) : fresh.corePluginSkillBindings,
    skillReadRoots: [...new Set([...retained.map(binding => path.dirname(path.resolve(binding.runtimePath))),
      ...fresh.skillReadRoots.filter(root => !freshPublishedRoots.has(path.resolve(root)) && previousRoots.has(path.resolve(root)))])],
  };
  const packages = getAuthorizedAgentWorkflowPackageMetadata(selection, context);
  const corePackages = getAuthorizedCorePluginContextMetadata(selection, context);
  const skills = await getAuthorizedAgentWorkflowSkillMetadata(selection, context, {
    bindings: captured.skillPackageBindings, coreBindings: captured.corePluginSkillBindings });
  const workflowProjection = await resolveAgentWorkflowRuntimeProjection(context, { packageSelection: selection });
  const mode = selection.snapshot.agent.agentId === DEFAULT_MANAGED_AGENT_ID ? 'general'
    : selection.workflowVersion === null ? 'legacy_specialized' : 'fixed';
  const fingerprint = createHash('sha256').update(JSON.stringify([namespace, selection.fingerprint,
    workflowProjection?.revision ?? null, captured.skillPackageBindings.map(binding => [binding.resourceRef,
      binding.publishedRevisionRef, binding.childRelativeRoot, binding.checksum]), skills.map(skill => [skill.resourceId,
      skill.runtimePath, skill.core, skill.required, skill.title, skill.description, skill.origin, skill.coreSource ?? null]), packages, corePackages])).digest('hex');
  const proof = Object.freeze({ kind: 'effective_extension_context' as const, fingerprint });
  records.set(proof, { actorKey: namespace, turnSource: context.turnExtensionSource, delegatedSource: context.delegatedExtensionSource,
    data: Object.freeze({ fingerprint, mode, packageSelection: selection, packages, corePackages, skills, workflowProjection }) });
  return { ...context, skillReadRoots: captured.skillReadRoots, skillPackageBindings: captured.skillPackageBindings,
    corePluginSkillBindings: captured.corePluginSkillBindings, effectiveExtensions: proof };
}

/** Server-only metadata access, not an execution grant. Clones and changed scopes are rejected. */
export function readEffectiveExtensionContext(context: AgentExecutionContext): EffectiveExtensionContextData | null {
  if (!context.effectiveExtensions) return null;
  const record = records.get(context.effectiveExtensions);
  if (!record || record.actorKey !== actorKey(context) || record.turnSource !== context.turnExtensionSource
    || record.delegatedSource !== context.delegatedExtensionSource) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The issued extension context no longer matches this turn.', 403);
  }
  return record.data;
}

/** A present but invalid selection must never fall back to general gateway access. */
export function isIssuedScopedIntegrationTurn(context: AgentExecutionContext): boolean {
  if (context.delegatedExtensionSource && !context.turnExtensionSource) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'A delegated context requires its actual issued turn source.', 403);
  }
  if (context.turnExtensionSource) return hasIssuedTurnExtensionSource(context);
  if (context.turnExtensions?.selections.some(entry => entry.selection.kind === 'mcp' || entry.selection.kind === 'composio')) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'An issued exact connection turn is required.', 403);
  }
  const selected = context.turnExtensions?.selections.filter(entry => entry.selection.kind === 'plugin' || entry.selection.kind === 'skill'
    || isCoreExtensionSelection(entry.selection)) ?? [];
  if (!selected.length) return false;
  const data = readEffectiveExtensionContext(context);
  if (!data || !isAuthorizedAgentWorkflowPackageSelections(data.packageSelection, context)
    || selected.some(entry => {
      if (isCoreExtensionSelection(entry.selection)) return !data.corePackages?.some(pkg =>
        JSON.stringify(pkg.coreSource) === JSON.stringify(isCoreExtensionSelection(entry.selection) ? entry.selection.coreSource : null));
      const pin = entry.selection.kind === 'plugin' || entry.selection.kind === 'skill' ? entry.selection.package : null;
      return !pin || !data.packages.some(pkg => pkg.resourceRef === pin.resourceRef
        && pkg.publishedRevisionRef === pin.publishedRevisionRef && pkg.checksum === pin.checksum);
    })) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'A current issued package turn is required.', 403);
  }
  return true;
}
