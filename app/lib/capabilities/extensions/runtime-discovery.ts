import 'server-only';

import path from 'node:path';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { resolveFreshAgentSkillReadRoots } from '@/app/lib/skills/fresh-agent-skill-read-roots';
import {
  getAuthorizedAgentWorkflowDiscoveryPackages,
  getAuthorizedAgentWorkflowPackageSelections,
  getAuthorizedAgentWorkflowSkillMetadata,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import { runtimeExtensionSearchInputSchema } from './discovery-contracts';
import { scoreExtensionMetadata } from './relevance';
import { corePluginResourceId } from '@/app/lib/plugins/core-plugins';

/** Fresh local metadata only. No provider health/account probe or durable assignment occurs here. */
export async function searchRuntimeExtensions(contextInput: AgentExecutionContext, value: unknown) {
  const input = runtimeExtensionSearchInputSchema.parse(value), context = { ...contextInput };
  const selection = await getAuthorizedAgentWorkflowPackageSelections(context);
  const roots = new Set((await resolveFreshAgentSkillReadRoots(context)).map(root => path.resolve(root)));
  const skills = input.types && !input.types.includes('skill') ? []
    : await getAuthorizedAgentWorkflowSkillMetadata(selection, context, { bindings: context.skillPackageBindings });
  const packages = input.types && !input.types.includes('plugin') ? [] : await getAuthorizedAgentWorkflowDiscoveryPackages(selection, context);
  const entries = [
    ...skills.filter(skill => roots.has(path.dirname(path.resolve(skill.runtimePath)))).map(skill => ({
      kind: 'skill' as const, id: skill.resourceId, name: skill.name, title: skill.title, description: skill.description,
      ...(skill.package ? { package: skill.package } : {}), core: skill.core, required: skill.required,
      // A location is metadata. Only the final effective tool set can supply a
      // read recipe; this search must not recommend an unavailable native tool.
      skillPath: skill.runtimePath,
    })),
    ...packages.map(pkg => ({ ...pkg, kind: 'plugin' as const, id: pkg.resourceId })),
  ].map(entry => ({ entry, score: scoreExtensionMetadata(entry, input.query) })).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name)
      || left.entry.id.localeCompare(right.entry.id));
  const page = entries.slice(0, input.limit).map(item => item.entry);
  const coreCreatorVisible = input.query.toLocaleLowerCase('en-US') !== 'create-plugin'
    && page.some(entry => entry.kind === 'plugin' && entry.id === corePluginResourceId('plugin-creator'));
  const items = page.filter(entry => !coreCreatorVisible || entry.kind !== 'skill'
    || entry.id !== 'canvas-capability:v1:skill:system:core:create-plugin');
  return { version: 1, query: input.query, selectionFingerprint: selection.fingerprint,
    items, hasMore: entries.length > input.limit,
    guidance: 'These are currently permitted installed metadata results, not new grants or executable tool recipes. If your effective tools include a permitted read route, read the exact skillPath before using a skill. Otherwise skill reading is unavailable. Use an explicit plugin selection to request its package context. Provider accounts and tool schemas were not inspected.' };
}
