import 'server-only';
import type { AgentExtensionPackageVersionSource } from '@/app/lib/agents/extension-package-options';
import { projectExtensionSharedConnectionChoice } from '@/app/lib/agents/extension-options-connections';
import { standaloneExtensionSelectionSchema, type ExtensionPackagePin, type ExtensionSelection, type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { PluginExtensionItem, PluginExtensionConnection } from '@/app/lib/plugins/plugin-extension-contracts';
import { normalizeComposioConnectors, normalizeMcpConnectors, normalizeEmailConnectors } from '@/app/lib/plugins/plugin-connection-readiness';
import { authorizeChatExtensionSharedOption, type ChatExtensionOptionsContext } from './extension-options-context';
import { resolveChatConnectionScope, readChatPackageMcpTemplate, type ChatPackageScopeMetadataOptions } from './extension-options-eligibility';
import { validateChatConnectionMetadata } from './extension-options-validation';
import { isChatConnectionReady } from './extension-options-connection-inventory';
import { readAgentOwnMcpOptionMetadata } from '@/app/lib/agents/extension-options-inventory';
import { listMcpServerDefinitions, matchesMcpServerDefinition } from '@/app/lib/mcp/server-definitions';

type Descriptor = { metadata: NonNullable<ChatPackageScopeMetadataOptions['packageMetadata']>;
  templates: NonNullable<ChatPackageScopeMetadataOptions['mcpTemplates']>; legacyRequired: string[] };
const descriptors = new Map<string, { value: Descriptor; expiresAt: number; bytes: number }>();
let descriptorBytes = 0;
const descriptorKey = (pin: ExtensionPackagePin) => JSON.stringify([pin.resourceRef, pin.publishedRevisionRef, pin.checksum]);
/** Immutable declarations only; no source contents, runtime path, user, grant,
 * permission or ready decision is retained. Current Use precedes every lookup. */
export function getChatPackageReadinessDescriptor(pin: ExtensionPackagePin): Descriptor | undefined {
  const key = descriptorKey(pin), entry = descriptors.get(key);
  if (!entry) return;
  if (entry.expiresAt <= Date.now()) { descriptors.delete(key); descriptorBytes -= entry.bytes; return; }
  return structuredClone(entry.value);
}
export async function prepareChatPackageReadinessDescriptor(source: AgentExtensionPackageVersionSource, pin: ExtensionPackagePin): Promise<Descriptor> {
  if (source.metadata.resourceRef !== pin.resourceRef || source.metadata.publishedRevisionRef !== pin.publishedRevisionRef
    || source.metadata.checksum !== pin.checksum) throw new Error('The exact published readiness metadata changed.');
  const connectors = source.source.manifest?.connectors;
  const metadata = structuredClone({ kind: source.metadata.kind, skillRoots: source.metadata.skillRoots, declarations: source.metadata.declarations });
  const names = new Set(metadata.declarations.flatMap(declaration => declaration.workflow.integrationCapabilities.flatMap(capability => capability.alternatives
    .flatMap(alternative => alternative.source === 'mcp' ? [alternative.connector] : []))));
  const templates: Record<string, Awaited<ReturnType<typeof readChatPackageMcpTemplate>>> = Object.create(null);
  for (const name of names) templates[name] = await readChatPackageMcpTemplate(source, pin, name);
  const value: Descriptor = { metadata, templates, legacyRequired: [
    ...normalizeEmailConnectors(connectors).filter(connector => connector.required).map(() => 'email'),
    ...normalizeMcpConnectors(connectors).filter(connector => connector.required).map(connector => `mcp:${connector.name}`),
    ...(source.metadata.kind === 'skill' ? source.source.skills[0]?.skill.workflow?.mcpConnectors ?? [] : [])
      .filter(connector => connector.required).map(connector => `mcp:${connector.name}`),
    ...normalizeComposioConnectors(connectors).filter(connector => connector.required).map(connector => `composio:${connector.toolkit}`),
  ] };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= 256 * 1024) {
    const key = descriptorKey(pin), previous = descriptors.get(key);
    if (previous) { descriptorBytes -= previous.bytes; descriptors.delete(key); }
    while (descriptors.size >= 128 || descriptorBytes + bytes > 2 * 1024 * 1024) {
      const oldest = descriptors.keys().next().value;
      if (oldest === undefined) break;
      descriptorBytes -= descriptors.get(oldest)!.bytes; descriptors.delete(oldest);
    }
    descriptors.set(key, { value: structuredClone(value), expiresAt: Date.now() + 60_000, bytes }); descriptorBytes += bytes;
  }
  return value;
}

/** Current status observations are only candidate filters. The same exact
 * connector template, definition and fixed-agent policy as the chooser is
 * checked before a package is ranked ready. No selection or receipt is issued. */
export async function chatPackageConnectionsReady(context: ChatExtensionOptionsContext,
  selection: Extract<ExtensionSelection, { kind: 'plugin' | 'skill' }>, descriptor: Descriptor,
  inventory: readonly PluginExtensionItem[], signal: AbortSignal): Promise<boolean> {
  const roots = selection.kind === 'skill' ? [selection.relativeRoot] : selection.skillSelection.kind === 'all'
    ? descriptor.metadata.skillRoots.map(root => root.relativeRoot) : selection.skillSelection.relativeRoots;
  const declarations = descriptor.metadata.declarations.filter(declaration => declaration.declarationPath === '.canvas-plugin/plugin.json'
    || roots.some(root => declaration.declarationPath === (root ? `${root}/agents/canvas.yaml` : 'agents/canvas.yaml')));
  const requirements = declarations.flatMap(declaration => declaration.workflow.integrationCapabilities.filter(capability => capability.required)
    .map(capability => ({ declarationPath: declaration.declarationPath, capability })));
  // Legacy declarations without an exact workflow selector still need explicit
  // setup. Optional connectors never hold back an otherwise usable package.
  const alternatives = requirements.flatMap(requirement => requirement.capability.alternatives);
  if (descriptor.legacyRequired.some(key => !alternatives.some(alternative => key === (alternative.source === 'mcp'
    ? `mcp:${alternative.connector}` : `composio:${alternative.toolkit}`)))) return false;
  const scopeOptions = { packageMetadata: descriptor.metadata, mcpTemplates: descriptor.templates };
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const choose = async (item: PluginExtensionItem, connection: PluginExtensionConnection): Promise<StandaloneExtensionSelection | null> => {
    if (item.kind !== 'mcp' && item.kind !== 'integration' || !isChatConnectionReady(connection)) return null;
    const sourceKind = item.kind === 'mcp' ? 'mcp' : 'composio';
    if (connection.ownership.type !== 'user') {
      const binding = await authorizeChatExtensionSharedOption(context, connection.connectionRef);
      if (!binding.canUse || binding.resource.status !== 'active' || binding.resource.source !== sourceKind) return null;
      return standaloneExtensionSelectionSchema.parse({ kind: sourceKind, source: sourceKind,
        ...(item.kind === 'integration' ? { toolkit: item.toolkit.slug } : {}),
        target: { kind: 'shared', connectionRef: connection.connectionRef, bindingRevision: binding.resource.bindingRevision } });
    }
    if (connection.ownership.ownerUserId !== context.actor.userId) return null;
    if (item.kind === 'mcp') return standaloneExtensionSelectionSchema.parse({ kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: connection.connectionRef } });
    // Only explicit observed account identities enter this status projection.
    // The personal no-auth chooser requires separate catalogue proof and is not
    // invoked by search. Its receipt remains an explicit later user action.
    if (!connection.profileId || !connection.accountId) return null;
    return standaloneExtensionSelectionSchema.parse({ kind: 'composio', source: 'composio', toolkit: item.toolkit.slug,
      target: { kind: 'personal', profileId: connection.profileId, accountBinding: 'account', accountId: connection.accountId,
        connectionRef: connection.connectionRef } });
  };
  for (const { declarationPath, capability } of requirements) {
    let satisfied = false;
    for (const alternative of capability.alternatives) {
      signal.throwIfAborted();
      const alternativeKey = alternative.source === 'mcp' ? `mcp:${alternative.connector}` : `composio:${alternative.toolkit}`;
      const scope = await resolveChatConnectionScope(context, { kind: 'package', package: selection.package,
        declarationPath, capabilityId: capability.id, alternativeKey }, scopeOptions);
      for (const item of inventory) {
        if (alternative.source === 'mcp' ? item.kind !== 'mcp' : item.kind !== 'integration' || item.toolkit.slug !== alternative.toolkit) continue;
        if (item.kind !== 'mcp' && item.kind !== 'integration') continue;
        for (const connection of item.connections) {
          signal.throwIfAborted();
          try {
            const candidate = await choose(item, connection);
            if (!candidate) continue;
            const allowed = scope.allowed?.find(choice => same(choice.selection, candidate));
            if (candidate.target.kind === 'shared') {
              // Includes configured shared MCP mapping fingerprints and current
              // definition checks, rather than accepting an arbitrary server.
              if (scope.allowed && !allowed) continue;
              const choice = await projectExtensionSharedConnectionChoice(context, scope,
                await authorizeChatExtensionSharedOption(context, candidate.target.connectionRef), allowed);
              if (choice?.eligibility.action !== 'select' || choice.mappingRequired) continue;
              if (candidate.kind === 'mcp' && !scope.template && !allowed) continue;
            } else if (candidate.kind === 'mcp' && alternative.source === 'mcp' && !allowed) {
              const metadata = await readAgentOwnMcpOptionMetadata(context, candidate.target.connectionRef);
              if (!metadata) continue;
              const ids = scope.definitionMappings?.find(mapping => mapping.connector === alternative.connector)?.serverDefinitionIds;
              if (!scope.template && !ids?.length) continue;
              if (!scope.template || ids) {
                const definitions = context.organizationId ? await listMcpServerDefinitions(context.organizationId) : [];
                if (!definitions.some(definition => definition.enabled && definition.id === metadata.connection.serverDefinitionId
                  && (!ids || ids.includes(definition.id)) && matchesMcpServerDefinition(metadata.connection, definition))) continue;
              }
            }
            const mapping = { package: selection.package, declarationPath, capabilityId: capability.id, alternativeKey, connectionSelection: candidate };
            await validateChatConnectionMetadata(context, { selection: candidate, requirement: 'required', toolCap: null }, signal,
              mapping, false, scopeOptions);
            satisfied = true; break;
          } catch { /* An unreadable, unrelated or revoked candidate cannot satisfy the requirement. */ }
        }
        if (satisfied) break;
      }
      if (satisfied) break;
    }
    if (!satisfied) return false;
  }
  return true;
}
