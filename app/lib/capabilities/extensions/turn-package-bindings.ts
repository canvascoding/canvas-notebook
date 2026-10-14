import 'server-only';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { AgentWorkflowError, agentWorkflowCapabilityKey, type StoredAgentWorkflowPackage,
  type StoredAgentWorkflowTarget } from '@/app/lib/agents/workflow-contracts';
import { getAuthorizedAgentWorkflowMcpTemplate, getAuthorizedAgentWorkflowPackageMetadata,
  isAuthorizedAgentWorkflowPackageSelections, type AuthorizedAgentWorkflowPackageSelections } from '@/app/lib/capabilities/packages/runtime-bindings';
import { capabilityPackageMcpConfigCompatibility } from '@/app/lib/capabilities/packages/mcp-template-matches';
import type { WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import { readAcceptedTurnRuntimeSelection, readDelegatedExtensionPackageFocus } from './turn-runtime';
import { extensionSelectionIdentity, type ExtensionPackageConnection } from './contracts';
import { intersectPackageExtensionToolCaps } from '@/app/lib/capabilities/packages/extension-projection';
import type { StoredStandaloneExtensionBinding, StoredStandaloneExtensionTarget } from './stored-contracts';

export type TurnPackageCapability = {
  pkg: StoredAgentWorkflowPackage;
  declaration: Pick<StoredAgentWorkflowPackage['declarations'][number], 'declarationPath'>;
  capability: Pick<StoredAgentWorkflowPackage['declarations'][number]['capabilities'][number],
    'capabilityId' | 'application' | 'required' | 'alternatives'>;
  chosen: { alternativeKey: string; target: StoredAgentWorkflowTarget; toolCap: string[] | null } | null;
};

function denied(message: string): never { throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', message, 403); }

/** Logical identities do not include revisions or private account/config identity. */
function sameTarget(left: StoredAgentWorkflowTarget, right: StoredAgentWorkflowTarget): boolean {
  if (left.source !== right.source || left.kind !== right.kind) return false;
  if (left.kind === 'shared') return right.kind === 'shared' && left.connectionRef === right.connectionRef
    && left.bindingRevision === right.bindingRevision;
  return right.kind === 'personal' && left.ownerUserId === right.ownerUserId && left.providerRef === right.providerRef
    && left.boundProviderRef === right.boundProviderRef && left.bindingFingerprint === right.bindingFingerprint
    && JSON.stringify(left.personalBinding) === JSON.stringify(right.personalBinding);
}

export type ConfiguredPackageTurnFocus = {
  target: StoredAgentWorkflowTarget;
  toolCap: readonly string[] | null;
  required: boolean;
  packageConnections: readonly Pick<ExtensionPackageConnection, 'package' | 'declarationPath' | 'capabilityId' | 'alternativeKey'>[];
};

/** Eligibility only, from an actual child frame; the caller must freshly issue source authority. */
export function getConfiguredPackageTurnFocus(context: AgentExecutionContext, packages: AuthorizedAgentWorkflowPackageSelections,
  entry: Extract<StoredStandaloneExtensionBinding, { mode: 'fixed' }>['entry']): ConfiguredPackageTurnFocus | null {
  if (!isAuthorizedAgentWorkflowPackageSelections(packages, context)) return denied('A current child package frame is required.');
  const matches: ConfiguredPackageTurnFocus[] = [];
  for (const pkg of packages.packages) for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
    const configured = capability.selection;
    const choices = configured.mode === 'fixed' ? [configured] : configured.allowedChoices;
    const eligible = choices.filter(choice => sameTarget(choice.target, entry.target));
    const alternatives = new Set(eligible.map(choice => choice.alternativeKey));
    if (alternatives.size > 1) return null;
    let selected: { alternativeKey: string; target: StoredAgentWorkflowTarget; toolCap: string[] | null } | undefined = eligible[0];
    if (!selected && configured.mode === 'selectable' && entry.target.kind === 'personal' && configured.personalPolicy) {
      const policy = configured.personalPolicy;
      const alternatives = capability.alternatives.filter(alternative => policy.alternativeKeys.includes(
        `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`)
        && policy.sources.includes(entry.target.source) && alternative.source === entry.target.source
        && (alternative.source === 'composio' ? entry.target.kind === 'personal' && entry.target.personalBinding?.source === 'composio'
          && entry.target.personalBinding.toolkit === alternative.toolkit : entry.target.kind === 'personal'
          && entry.target.personalBinding?.source === 'mcp' && Boolean(entry.target.personalBinding.serverDefinitionId)
          && policy.mcpDefinitionMappings?.some(mapping => mapping.connector === alternative.connector
            && mapping.serverDefinitionIds.includes(entry.target.kind === 'personal' && entry.target.personalBinding?.source === 'mcp'
              ? entry.target.personalBinding.serverDefinitionId! : ''))));
      if (alternatives.length === 1) {
        const alternative = alternatives[0];
        selected = { alternativeKey: `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`,
          target: entry.target, toolCap: policy.toolCap };
      }
    }
    if (!selected) continue;
    matches.push({ target: selected.target, toolCap: intersectPackageExtensionToolCaps(selected.toolCap, entry.toolCap),
      required: capability.required || entry.requirement === 'required', packageConnections: [{ package: {
        resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum },
      declarationPath: declaration.declarationPath, capabilityId: capability.capabilityId, alternativeKey: selected.alternativeKey }] });
  }
  if (!matches.length) return null;
  const caps = matches.some(match => match.toolCap === null) ? null : [...new Set(matches.flatMap(match => match.toolCap ?? []))].sort();
  return { target: matches[0].target, toolCap: caps, required: matches.some(match => match.required),
    packageConnections: matches.flatMap(match => match.packageConnections) };
}

/** Verifies compatibility against held bytes and current backend metadata, never a display name. */
async function mappedMcpTarget(context: AgentExecutionContext, packages: AuthorizedAgentWorkflowPackageSelections,
  mapping: ExtensionPackageConnection, target: StoredAgentWorkflowTarget,
  alternative: Extract<WorkflowIntegrationAlternative, { source: 'mcp' }>): Promise<StoredAgentWorkflowTarget> {
  const template = await getAuthorizedAgentWorkflowMcpTemplate(packages, context, mapping.package, alternative.connector);
  const { hashMcpLegacyConfig } = await import('@/app/lib/mcp/connection-identity');
  if (target.kind === 'shared') {
    const { resolveSharedMcpBackend } = await import('@/app/lib/mcp/shared-connections');
    const { revalidateAuthorizedIntegrationConnection } = await import('@/app/lib/integration-tools/connections/store');
    const backend = await resolveSharedMcpBackend({ userId: context.userId, organizationId: context.organizationId,
      workspaceId: context.workspaceId }, target.connectionRef, 'use');
    if (backend.authorization.resource.bindingRevision !== target.bindingRevision || backend.connection.enabled === false
      || !capabilityPackageMcpConfigCompatibility(template, backend.connection as Record<string, unknown>)) {
      return denied('The selected MCP connection does not match this held plugin connector.');
    }
    const definitions = backend.connection.serverDefinitionId
      ? await (await import('@/app/lib/mcp/server-definitions')).listMcpServerDefinitions(backend.authorization.resource.ownership.organizationId) : [];
    const definition = definitions.find(item => item.id === backend.connection.serverDefinitionId);
    if (backend.connection.serverDefinitionId && !definition?.enabled) return denied('The MCP definition is unavailable.');
    await revalidateAuthorizedIntegrationConnection(backend.authorization, 'use');
    return { ...target, verifiedMcpMapping: { connector: alternative.connector, configFingerprint: hashMcpLegacyConfig(backend.connection),
      definitionId: definition?.id ?? null, definitionRevision: definition?.revision ?? null, confirmedByUserId: context.userId } };
  }
  if (target.personalBinding?.source !== 'mcp' || target.ownerUserId !== context.userId) return denied('The MCP owner changed.');
  const { assertMcpConnectionAccess } = await import('@/app/lib/mcp/access');
  const current = await assertMcpConnectionAccess(target.personalBinding.connectionId, { userId: context.userId });
  if (!capabilityPackageMcpConfigCompatibility(template, current.connection as Record<string, unknown>)) {
    return denied('The selected MCP connection does not match this held plugin connector.');
  }
  return target;
}

/**
 * Explicit package mappings consume only an actual accepted source plus the
 * actual published declarations. A co-selected account alone is never a link.
 */
export async function resolveTurnPackageCapabilitySelections(context: AgentExecutionContext,
  packages: AuthorizedAgentWorkflowPackageSelections): Promise<readonly TurnPackageCapability[]> {
  if (!isAuthorizedAgentWorkflowPackageSelections(packages, context)) return denied('A current package selection is required.');
  const mappings = context.turnExtensions?.packageConnections ?? [];
  const delegatedFocus = context.delegatedExtensionSource ? readDelegatedExtensionPackageFocus(context, packages) : [];
  if (!packages.packages.length) {
    if (mappings.length || delegatedFocus.length) return denied('Package connections require an actual selected package.');
    return [];
  }
  if (packages.workflowVersion === 1 && !mappings.length && !delegatedFocus.length) return [];
  const metadata = getAuthorizedAgentWorkflowPackageMetadata(packages, context);
  const accepted = context.turnExtensionSource ? readAcceptedTurnRuntimeSelection(context.turnExtensionSource, context, packages) : null;
  if (mappings.length && !accepted) return denied('Package connections require an issued exact turn source.');
  const used = new Set<ExtensionPackageConnection>();
  const usedDelegated = new Set<object>();
  const result: TurnPackageCapability[] = [];
  for (const pkg of packages.packages) {
    const declared = metadata.find(item => item.resourceRef === pkg.resourceRef && item.publishedRevisionRef === pkg.publishedRevisionRef
      && item.checksum === pkg.checksum);
    if (!declared) return denied('The held package declaration is unavailable.');
    for (const declaration of declared.declarations) for (const capability of declaration.capabilities) {
      const mapping = mappings.find(value => value.package.resourceRef === pkg.resourceRef
        && value.package.publishedRevisionRef === pkg.publishedRevisionRef && value.package.checksum === pkg.checksum
        && value.declarationPath === declaration.declarationPath && value.capabilityId === capability.id);
      const delegated = delegatedFocus.find(value => value.package.resourceRef === pkg.resourceRef
        && value.package.publishedRevisionRef === pkg.publishedRevisionRef && value.package.checksum === pkg.checksum
        && value.declarationPath === declaration.declarationPath && value.capabilityId === capability.id);
      const stored = pkg.declarations.find(item => item.declarationPath === declaration.declarationPath)
        ?.capabilities.find(item => item.capabilityId === capability.id);
      if (!mapping && !delegated && packages.workflowVersion !== null && (stored || !capability.required)) continue;
      const projected: TurnPackageCapability = { pkg, declaration,
        capability: { capabilityId: capability.id, application: capability.application, required: capability.required,
          alternatives: capability.alternatives as readonly WorkflowIntegrationAlternative[] }, chosen: null };
      if (delegated) {
        usedDelegated.add(delegated);
        const heldTarget = delegated.target;
        const sourceTarget: StoredStandaloneExtensionTarget = heldTarget.kind === 'shared'
          ? { kind: 'shared', source: heldTarget.source, connectionRef: heldTarget.connectionRef, bindingRevision: heldTarget.bindingRevision }
          : heldTarget.boundProviderRef && heldTarget.bindingFingerprint && heldTarget.personalBinding
            ? { kind: 'personal', source: heldTarget.source, ownerUserId: heldTarget.ownerUserId, providerRef: heldTarget.providerRef,
              boundProviderRef: heldTarget.boundProviderRef, bindingFingerprint: heldTarget.bindingFingerprint, personalBinding: heldTarget.personalBinding }
            : denied('The delegated source lacks its exact private identity.');
        const current = getConfiguredPackageTurnFocus(context, packages, { selection: delegated.connectionSelection,
          target: sourceTarget, requirement: delegated.required ? 'required' : 'optional',
          toolCap: delegated.toolCap === null ? null : [...delegated.toolCap] });
        if (!current || !sameTarget(current.target, delegated.target) || !current.packageConnections.some(slot =>
          slot.package.resourceRef === pkg.resourceRef && slot.package.publishedRevisionRef === pkg.publishedRevisionRef
          && slot.package.checksum === pkg.checksum && slot.declarationPath === declaration.declarationPath
          && slot.capabilityId === capability.id && slot.alternativeKey === delegated.alternativeKey)) {
          return denied('The delegated package focus is outside this current child configuration.');
        }
        projected.capability.required ||= current.required || delegated.required;
        projected.chosen = { target: current.target, alternativeKey: delegated.alternativeKey,
          toolCap: intersectPackageExtensionToolCaps(current.toolCap, delegated.toolCap) };
        if (mapping && (mapping.alternativeKey !== delegated.alternativeKey
          || JSON.stringify(mapping.connectionSelection) !== JSON.stringify(delegated.connectionSelection))) {
          return denied('An explicit mapping cannot replace the accepted delegated connection.');
        }
      }
      if (mapping) {
        used.add(mapping);
        const bound = accepted!.privateFixedBindings.find(binding => extensionSelectionIdentity(binding.entry.selection)
          === extensionSelectionIdentity(mapping.connectionSelection));
        if (!bound || JSON.stringify(bound.entry.selection) !== JSON.stringify(mapping.connectionSelection)) {
          return denied('The package connection must be the exact accepted connection.');
        }
        const alternative = capability.alternatives.find(value => `${value.source}:${value.source === 'mcp' ? value.connector : value.toolkit}` === mapping.alternativeKey);
        if (!alternative || alternative.source !== bound.entry.target.source) return denied('Choose an actual declared alternative.');
        let target: StoredAgentWorkflowTarget = bound.entry.target;
        let toolCap: string[] | null = bound.entry.toolCap;
        if (packages.workflowVersion !== null) {
          if (!stored) return denied('A turn cannot add this capability to a fixed agent.');
          const configured = stored.selection;
          const exact = configured.mode === 'fixed' ? configured
            : configured.allowedChoices.find(choice => choice.alternativeKey === mapping.alternativeKey && sameTarget(choice.target, target));
          if (exact && exact.alternativeKey === mapping.alternativeKey && sameTarget(exact.target, target)) {
            target = exact.target;
            toolCap = intersectPackageExtensionToolCaps(toolCap, exact.toolCap);
          } else if (configured.mode === 'selectable' && target.kind === 'personal' && configured.personalPolicy
            && configured.personalPolicy.sources.includes(target.source) && configured.personalPolicy.alternativeKeys.includes(mapping.alternativeKey)) {
            toolCap = intersectPackageExtensionToolCaps(toolCap, configured.personalPolicy.toolCap);
            if (alternative.source === 'mcp' && (target.personalBinding?.source !== 'mcp' || !target.personalBinding.serverDefinitionId
              || !configured.personalPolicy.mcpDefinitionMappings?.some(definition => definition.connector === alternative.connector
                && definition.serverDefinitionIds.includes(target.kind === 'personal' && target.personalBinding?.source === 'mcp'
                  ? target.personalBinding.serverDefinitionId! : '')))) return denied('Choose a server definition allowed for this exact connector.');
          } else return denied('This exact connection is outside the configured capability choices.');
          projected.capability.required ||= stored.required;
        } else if (alternative.source === 'mcp') {
          target = await mappedMcpTarget(context, packages, mapping, target, alternative as Extract<WorkflowIntegrationAlternative, { source: 'mcp' }>);
        }
        // Parent and selected-child caps constrain a dynamically bound declaration too.
        const caps = context.turnExtensions!.selections.filter(entry => (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
          && entry.selection.package.resourceRef === pkg.resourceRef
          && (entry.selection.kind === 'plugin' || declaration.declarationPath === '.canvas-plugin/plugin.json'
            || declaration.declarationPath === (entry.selection.relativeRoot
            ? `${entry.selection.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml'))).map(entry => entry.toolCap);
        projected.chosen = { target, alternativeKey: mapping.alternativeKey,
          toolCap: intersectPackageExtensionToolCaps(toolCap, ...caps) };
      }
      result.push(projected);
    }
  }
  if (used.size !== mappings.length) return denied('A mapped capability is absent from the exact selected package scope.');
  if (usedDelegated.size !== delegatedFocus.length) return denied('A delegated capability is absent from the exact selected child package scope.');
  return result;
}

export function turnPackageCapabilityKey(entry: TurnPackageCapability): string {
  return agentWorkflowCapabilityKey(entry.pkg.resourceRef, entry.declaration.declarationPath, entry.capability.capabilityId);
}
