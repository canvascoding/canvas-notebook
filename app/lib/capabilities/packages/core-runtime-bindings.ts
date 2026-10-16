import 'server-only';

import path from 'node:path';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { loadCoreCanvasPlugin, resolveCorePluginSkillReadDependencies } from '@/app/lib/plugins/core-plugin-loader';
import type { CapabilityCandidate } from '../types';
import { CapabilityPackageError } from './contracts';
import { readExactPackageInventory } from './io';
import { corePluginDependencyParent } from './core-runtime-selection';
import { loadCoreSkillSource } from '../extensions/core-source';
import { isCoreSkillName } from '@/app/lib/skills/core-skills';

/** Exact source receipt for bundled Core content; it is deliberately not a published SQL package pin. */
export type HeldCorePluginSkillRuntimeBinding = Readonly<{
  kind: 'core_plugin_skill' | 'core_skill'; resourceId: string; skillName: string; runtimePath: string; checksum: string;
  parentResourceId: string; parentChecksum: string;
}>;
type Proof = { actorKey: string };
const host = globalThis as typeof globalThis & { __canvasCorePluginSkillBindingsV1?: WeakMap<object, Proof> };
const proofs = host.__canvasCorePluginSkillBindingsV1 ??= new WeakMap<object, Proof>();

function actorKey(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId, context.workspaceId, context.workspaceType,
    context.organizationId, context.customerId, context.projectId, context.workspaceRoot, context.workspaceRootRelativePath,
    context.canWrite, context.canDelete, context.canShare, context.turnExtensions ?? null]);
}

async function currentSource(candidate: CapabilityCandidate, candidates: readonly CapabilityCandidate[]): Promise<HeldCorePluginSkillRuntimeBinding | null> {
  if (candidate.ref.resourceType === 'skill' && candidate.ref.scopeType === 'system' && candidate.ref.sourceType === 'core'
    && isCoreSkillName(candidate.ref.name)) {
    const {source, skill} = await loadCoreSkillSource(candidate.ref.name);
    if (candidate.ref.resourceId !== source.resourceRef || candidate.runtimePath !== skill.path) {
      throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The exact Core skill source is unavailable.', 409);
    }
    return {kind:'core_skill',resourceId:source.resourceRef,skillName:skill.name,runtimePath:skill.path,checksum:source.checksum,
      parentResourceId:source.resourceRef,parentChecksum:source.checksum};
  }
  const parent = corePluginDependencyParent(candidate, candidates);
  if (!parent || !candidate.runtimePath) return null;
  const plugin = await loadCoreCanvasPlugin(parent.ref.name);
  const root = path.dirname(path.resolve(candidate.runtimePath));
  if (!plugin || plugin.resourceId !== parent.ref.resourceId || plugin.checksum !== parent.ref.checksum
    || !resolveCorePluginSkillReadDependencies('create-plugin').some(dependency => path.resolve(dependency) === root)
    || !plugin.skills.some(skill => skill.name === candidate.ref.name && path.resolve(skill.path) === path.resolve(candidate.runtimePath!))) {
    throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The exact Core plugin dependency is unavailable.', 409);
  }
  const inventory = await readExactPackageInventory(root);
  if ((await loadCoreCanvasPlugin(parent.ref.name))?.checksum !== plugin.checksum) {
    throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The Core plugin dependency changed while being captured.', 409);
  }
  return { kind: 'core_plugin_skill', resourceId: candidate.ref.resourceId, skillName: candidate.ref.name,
    runtimePath: candidate.runtimePath, checksum: inventory.checksum, parentResourceId: parent.ref.resourceId, parentChecksum: plugin.checksum };
}

export async function captureCorePluginSkillRuntimeBindings(context: AgentExecutionContext, candidates: readonly CapabilityCandidate[],
  selected: readonly CapabilityCandidate[], explicitCoreSkillRefs: readonly string[] = []): Promise<HeldCorePluginSkillRuntimeBinding[]> {
  const result: HeldCorePluginSkillRuntimeBinding[] = [];
  for (const candidate of selected) {
    if (candidate.ref.sourceType === 'core' && !explicitCoreSkillRefs.includes(candidate.ref.resourceId)) continue;
    const source = await currentSource(candidate, candidates);
    if (!source) continue;
    const binding = Object.freeze(source);
    proofs.set(binding, { actorKey: actorKey(context) });
    result.push(binding);
  }
  return result;
}

/** Fresh source checks and the actual actor-bound receipt are both required; strings cannot add read roots. */
export async function revalidateCorePluginSkillRuntimeBindings(context: AgentExecutionContext, candidates: readonly CapabilityCandidate[],
  selected: readonly CapabilityCandidate[]): Promise<HeldCorePluginSkillRuntimeBinding[]> {
  const authorized: HeldCorePluginSkillRuntimeBinding[] = [];
  for (const binding of context.corePluginSkillBindings ?? []) {
    if (proofs.get(binding)?.actorKey !== actorKey(context)) continue;
    const candidate = selected.find(value => value.ref.resourceId === binding.resourceId);
    if (!candidate) continue;
    try {
      const source = await currentSource(candidate, candidates);
      if (source && JSON.stringify(source) === JSON.stringify(binding)) authorized.push(binding);
    } catch { /* A changed Core source never grants its replacement bytes to the held context. */ }
  }
  return authorized;
}
