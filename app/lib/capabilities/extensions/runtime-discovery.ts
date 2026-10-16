import 'server-only';

import path from 'node:path';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { resolveFreshAgentSkillReadRoots } from '@/app/lib/skills/fresh-agent-skill-read-roots';
import {
  getAuthorizedAgentWorkflowDiscoveryPackages,
  getAuthorizedAgentWorkflowPackageSelections,
  getAuthorizedAgentWorkflowSkillMetadata,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import { authoringExtensionSearchInputSchema, extensionSearchInputSchema, runtimeExtensionSearchInputSchema } from './discovery-contracts';
import { scoreExtensionMetadata } from './relevance';
import { corePluginResourceId } from '@/app/lib/plugins/core-plugins';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';

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

/** Read-only common-catalog projection; source metadata never adds runtime roots or provider authority. */
export async function searchAuthoringExtensions(contextInput: AgentExecutionContext, value: unknown) {
  const input = authoringExtensionSearchInputSchema.parse(value), context = { ...contextInput };
  const before = await getAuthorizedAgentWorkflowPackageSelections(context);
  const { searchPluginExtensionAuthoringMetadata } = await import('@/app/lib/plugins/plugin-extension-authoring-search');
  const result = await searchPluginExtensionAuthoringMetadata({ userId: context.userId, workspaceId: context.workspaceId }, {
    q: input.query, types: input.types ?? ['plugin', 'skill', 'integration', 'mcp'], limit: input.limit,
    stock: 'all', source: 'all', scope: 'all', audience: null, teamId: null, selected: null, cursor: input.cursor ?? null,
  });
  const after = await getAuthorizedAgentWorkflowPackageSelections(context);
  if (before.fingerprint !== after.fingerprint) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The current authoring context changed. Start the search again.', 409);
  }
  const items = result.items.map(item => ({
    kind: item.kind, id: item.id, name: item.name, title: item.displayName, description: item.description, source: item.source, stock: item.stock,
    ...((item.kind === 'plugin' || item.kind === 'skill') && item.package ? { package: {
      resourceRef: item.package.resourceRef, version: item.package.version,
      ...(item.package.parentResourceRef ? { parentResourceRef: item.package.parentResourceRef } : {}),
    } } : {}),
    ...(item.kind === 'integration' ? { toolkit: { slug: item.toolkit.slug, noAuth: item.toolkit.noAuth } } : {}),
    ...(item.kind === 'mcp' ? { mcp: { transport: item.mcp.transport, template: item.mcp.template,
      ...(item.mcp.definitionId ? { definitionId: item.mcp.definitionId } : {}) } } : {}),
  }));
  return { version: 1, purpose: 'authoring' as const, query: input.query, items, coverage: result.coverage, pagination: result.pagination,
    guidance: 'These are currently readable authoring catalog identities, not runtime selections, file read roots, account choices or tool grants. Inspect an exact package source and chosen version before composing its complete bytes. For MCP use an explicit portable connector name; for Composio use the exact toolkit slug. Account authorization, OAuth, live health and tool schemas were not inspected.' };
}

/** The explicit authoring branch cannot change the original runtime discovery contract. */
export async function searchCanvasExtensions(context: AgentExecutionContext, value: unknown) {
  const input = extensionSearchInputSchema.parse(value);
  if (input.purpose === 'authoring') return searchAuthoringExtensions(context, input);
  const { purpose: _purpose, ...runtime } = input;
  return searchRuntimeExtensions(context, runtime);
}
