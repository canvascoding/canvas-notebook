import 'server-only';
import { AgentWorkflowError, type StoredAgentWorkflowTarget } from '@/app/lib/agents/workflow-contracts';
import { parseStoredStandaloneExtensionBinding } from '@/app/lib/capabilities/extensions/stored-contracts';
import { standaloneExtensionSelectionSchema, type ExtensionSelection, type ExtensionPackagePin, type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { readAgentExtensionPackageVersion, type AgentExtensionPackageVersionSource } from '@/app/lib/agents/extension-package-options';
import type { AgentExtensionOptionEligibility, AgentExtensionSearchItem } from '@/app/lib/agents/extension-options-contracts';
import { projectPackageExtensionSelection, intersectPackageExtensionToolCaps } from '@/app/lib/capabilities/packages/extension-projection';
import type { ChatExtensionOptionsContext } from './extension-options-context';
import type { ExtensionConnectionScope, ExtensionConnectionAlternative } from '@/app/lib/agents/extension-options-connections';
import { inspectCapabilityResource } from '@/app/lib/capabilities/resources/actions';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { normalizeMcpConnectors } from '@/app/lib/plugins/plugin-connection-readiness';
import { readPluginMcpTemplateFile } from '@/app/lib/plugins/plugin-mcp-template-service';
import { projectCapabilityPackageMcpTemplateConfig } from '@/app/lib/capabilities/packages/mcp-template-projection';
import type { CapabilityPackageMcpTemplate } from '@/app/lib/capabilities/packages/presentation-contracts';

const no = (message: string): AgentExtensionOptionEligibility => ({ action: 'unavailable', reason: { code: 'CHAT_EXTENSION_AGENT_SCOPE', message } });
const key = (value: ExtensionConnectionAlternative): string | undefined => value.source === 'composio' ? `composio:${value.toolkit}` : value.connector ? `mcp:${value.connector}` : undefined;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function publicChatConnectionSelection(target: StoredAgentWorkflowTarget, alternative: ExtensionConnectionAlternative): StandaloneExtensionSelection {
  if (target.kind === 'shared') return standaloneExtensionSelectionSchema.parse({ kind: alternative.source, source: alternative.source,
    ...(alternative.source === 'composio' ? { toolkit: alternative.toolkit } : {}),
    target: { kind: 'shared', connectionRef: target.connectionRef, bindingRevision: target.bindingRevision } });
  const binding = target.personalBinding;
  if (!binding || binding.source !== alternative.source) throw new AgentWorkflowError('CHAT_EXTENSION_SOURCE_CHANGED', 'The configured source is inconsistent.', 409);
  return standaloneExtensionSelectionSchema.parse(binding.source === 'mcp'
    ? { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: `mcp-personal:${binding.connectionId}` } }
    : { kind: 'composio', source: 'composio', toolkit: binding.toolkit, target: { kind: 'personal', profileId: binding.profileId,
      accountBinding: binding.accountBinding, ...(binding.accountBinding === 'account' ? { accountId: binding.connectedAccountId,
        connectionRef: `composio-personal:${binding.profileId}:${binding.connectedAccountId}` } : {}) } });
}
export function chatPackageBinding(context: ChatExtensionOptionsContext, pin: ExtensionPackagePin) {
  return context.snapshot.bindings.find(binding => binding.configuration?.resourceRef === pin.resourceRef
    && binding.configuration.publishedRevisionRef === pin.publishedRevisionRef && binding.configuration.checksum === pin.checksum);
}
/** Metadata eligibility only, bounded by the genuine fixed configuration. It never issues a runtime source. */
export function chatPermittedPackageRoots(context: ChatExtensionOptionsContext, pin: ExtensionPackagePin,
  source: AgentExtensionPackageVersionSource): string[] {
  if (context.snapshot.workflowVersion === null) return source.metadata.skillRoots.map(root => root.relativeRoot);
  const binding = chatPackageBinding(context, pin);
  if (!binding?.configuration || (binding.resourceType !== 'plugin' && binding.resourceType !== 'skill')) return [];
  return [...projectPackageExtensionSelection({ source: binding.configuration, kind: source.metadata.kind, inventory: source.metadata.skillRoots,
    selections: binding.extensionSelections }).selectedRoots];
}
export async function chatPackageSelectionEligibility(context: ChatExtensionOptionsContext, selection: Extract<ExtensionSelection, { kind: 'plugin' | 'skill' }>,
  heldSource?: AgentExtensionPackageVersionSource): Promise<AgentExtensionOptionEligibility> {
  const resource = await inspectCapabilityResource({ userId: context.actor.userId, workspaceId: context.actor.workspaceId }, selection.package.resourceRef);
  if (!resource.access.canUse || resource.activation && !resource.activation.enabled) return no('This package is currently disabled or unavailable.');
  const source = heldSource ?? await readAgentExtensionPackageVersion({ userId: context.actor.userId, workspaceId: context.actor.workspaceId },
    selection.package, { allowPersonalPackages: true });
  if (selection.kind === 'plugin' ? source.metadata.kind !== 'plugin' : selection.origin === 'standalone' ? source.metadata.kind !== 'skill' : source.metadata.kind !== 'plugin')
    return no('The exact published resource has a different kind or child origin.');
  const inventory = new Set(source.metadata.skillRoots.map(root => root.relativeRoot));
  if (selection.kind === 'skill' && !inventory.has(selection.relativeRoot)) return no('This child is absent from the exact published package.');
  if (context.snapshot.workflowVersion !== null) {
    const binding = chatPackageBinding(context, selection.package);
    if (!binding?.configuration) return no('This package pin is outside this agent configuration.');
    if (selection.kind === 'plugin' && binding.resourceType !== 'plugin') return no('Only the configured child skills are available for this agent.');
    const allowed = new Set(chatPermittedPackageRoots(context, selection.package, source));
    const requested = selection.kind === 'skill' ? [selection.relativeRoot] : selection.skillSelection.kind === 'all'
      ? [...inventory] : selection.skillSelection.relativeRoots;
    if (requested.some(root => !inventory.has(root) || !allowed.has(root))) return no('The requested child selection exceeds this agent configuration.');
  } else if (selection.kind === 'plugin' && selection.skillSelection.kind === 'subset'
    && selection.skillSelection.relativeRoots.some(root => !inventory.has(root))) return no('A selected child is absent from this published plugin.');
  return { action: 'select' };
}
/** Fixed-agent policy matching uses exact own/shared identities; no default choice/account substitution. */
export function chatStandaloneEligibility(context: ChatExtensionOptionsContext, selection: StandaloneExtensionSelection, definitionId?: string): AgentExtensionOptionEligibility {
  if (context.snapshot.workflowVersion === null) return { action: 'select' };
  const matches: Array<{ toolCap: readonly string[] | null }> = [];
  for (const binding of context.snapshot.bindings) if (binding.standaloneConfiguration) {
    const slot = parseStoredStandaloneExtensionBinding(binding.standaloneConfiguration);
    const choices = slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices;
    if (choices.some(choice => same(choice.selection, selection) && (choice.target.kind === 'shared'
      || choice.target.ownerUserId === context.actor.userId && context.snapshot.agent.scopeType !== 'organization'))) { matches.push({ toolCap: choices.find(choice => same(choice.selection, selection))!.toolCap }); continue; }
    if (slot.mode !== 'selectable' || selection.target.kind !== 'personal' || !slot.personalPolicy) continue;
    const policy = slot.personalPolicy;
    if (selection.kind === 'composio' && policy.source === 'composio' && policy.toolkit === selection.toolkit
      || selection.kind === 'mcp' && policy.source === 'mcp' && definitionId && policy.serverDefinitionIds.includes(definitionId)) matches.push({ toolCap: policy.toolCap });
  }
  return matches.length === 1 ? { action: 'select' } : no(matches.length ? 'This connection matches more than one agent slot. Choose an unambiguous configured source.'
    : 'This exact connection is outside the agent’s permitted standalone sources.');
}
export async function projectChatExtensionSearchItem(context: ChatExtensionOptionsContext, item: AgentExtensionSearchItem): Promise<AgentExtensionSearchItem> {
  if (item.item.kind === 'integration' || item.item.kind === 'mcp') {
    if (context.snapshot.workflowVersion === null) return item;
    const source = item.item.kind === 'mcp' ? 'mcp' : 'composio';
    const toolkit = item.item.kind === 'integration' ? item.item.toolkit.slug : undefined;
    const configured = context.snapshot.bindings.some(binding => binding.standaloneConfiguration && (() => {
      const config = parseStoredStandaloneExtensionBinding(binding.standaloneConfiguration);
      return config.mode === 'fixed' ? config.entry.selection.source === source && (source === 'mcp'
        || config.entry.selection.kind === 'composio' && config.entry.selection.toolkit === toolkit)
        : config.source === source && (source === 'mcp' || config.toolkit === toolkit);
    })());
    return configured ? item : { ...item, eligibility: no('This source has no standalone slot in the current agent. Open a selected package to bind one of its requirements.') };
  }
  const ref = item.item.package?.parentResourceRef || item.item.package?.resourceRef;
  if (!ref) return item;
  let pin = item.selection && (item.selection.kind === 'plugin' || item.selection.kind === 'skill') ? item.selection.package : item.publishedVersions?.[0]?.pin;
  if (context.snapshot.workflowVersion !== null) {
    const configured = context.snapshot.bindings.find(binding => binding.configuration?.resourceRef === ref)?.configuration;
    if (!configured) return { ...item, eligibility: no('This package is outside the agent configuration.') };
    pin = { resourceRef: configured.resourceRef, publishedRevisionRef: configured.publishedRevisionRef, checksum: configured.checksum };
  }
  if (!pin) return item;
  const source = await readAgentExtensionPackageVersion({ userId: context.actor.userId, workspaceId: context.actor.workspaceId }, pin, { allowPersonalPackages: true });
  let selection: Extract<ExtensionSelection, { kind: 'plugin' | 'skill' }>;
  if (item.item.kind === 'plugin') selection = { kind: 'plugin', package: pin, skillSelection: context.snapshot.workflowVersion === null
    ? { kind: 'all' } : { kind: 'subset', relativeRoots: chatPermittedPackageRoots(context, pin, source) } };
  else {
    const child = source.metadata.skillRoots.find(root => root.name === item.item.name);
    if (!child) return { ...item, eligibility: no('This child is absent from the configured published version.') };
    selection = { kind: 'skill', origin: source.metadata.kind === 'plugin' ? 'plugin_child' : 'standalone', relativeRoot: child.relativeRoot, package: pin };
  }
  return { ...item, selection, eligibility: await chatPackageSelectionEligibility(context, selection, source),
    publishedVersions: item.publishedVersions?.filter(version => same(version.pin, pin)) };
}
export async function readChatPackageMcpTemplate(source: AgentExtensionPackageVersionSource, pin: ExtensionPackagePin, connectorName: string): Promise<CapabilityPackageMcpTemplate> {
  const connectors = source.metadata.kind === 'plugin' ? normalizeMcpConnectors(source.source.manifest?.connectors)
    : source.source.skills[0]?.skill.workflow?.mcpConnectors ?? [];
  const matches = connectors.filter(connector => connector.name === connectorName);
  if (matches.length !== 1 || !matches[0]!.configPath) throw new AgentWorkflowError('CHAT_EXTENSION_TEMPLATE_REQUIRED', 'An exact published MCP template is required.', 409);
  const connector = matches[0]!, file = await readPluginMcpTemplateFile({ rootDir: source.source.rootPath, configPath: connector.configPath! });
  if (!file.config) throw new AgentWorkflowError('CHAT_EXTENSION_TEMPLATE_REQUIRED', 'The exact MCP template is unavailable.', 409);
  return { resourceRef: pin.resourceRef, source: { resourceRef: pin.resourceRef, version: source.metadata.version, checksum: pin.checksum, artifactRevision: null },
    declaredBy: { kind: source.metadata.kind, name: source.metadata.name }, connector: { name: connectorName, ...(connector.oauth ? { oauth: true } : {}) },
    ...projectCapabilityPackageMcpTemplateConfig(file.config, connectorName) };
}
export async function resolveChatConnectionScope(context: ChatExtensionOptionsContext,
  selector: import('./extension-options-contracts').ChatExtensionConnectionChoicesRequest['selector']): Promise<ExtensionConnectionScope> {
  if (selector.kind === 'standalone') {
    const alternative: ExtensionConnectionAlternative = selector.source === 'mcp' ? { source: 'mcp' } : { source: 'composio', toolkit: selector.toolkit };
    if (alternative.source === 'composio' && !isComposioIntegrationApplicationVisible(alternative.toolkit)) throw new AgentWorkflowError('CHAT_EXTENSION_ALTERNATIVE_INVALID', 'Use this app’s native tool.', 400);
    if (context.snapshot.workflowVersion === null) return { alternatives: [alternative], personal: [alternative], toolCap: null, required: false, package: false };
    const slots = context.snapshot.bindings.flatMap(binding => binding.standaloneConfiguration ? [parseStoredStandaloneExtensionBinding(binding.standaloneConfiguration)] : [])
      .filter(slot => slot.mode === 'fixed' ? slot.entry.selection.source === selector.source && (selector.source === 'mcp'
        || slot.entry.selection.kind === 'composio' && slot.entry.selection.toolkit === selector.toolkit)
        : slot.source === selector.source && (selector.source === 'mcp' || slot.toolkit === selector.toolkit));
    if (!slots.length) throw new AgentWorkflowError('CHAT_EXTENSION_AGENT_SCOPE', 'This source is outside the current agent configuration.', 403);
    const allowed = slots.flatMap(slot => (slot.mode === 'fixed' ? [{ ...slot.entry, choiceId: slot.configurationId }] : slot.allowedChoices
      .map(choice => ({ ...choice, choiceId: JSON.stringify([slot.configurationId, choice.choiceId]) }))));
    const personalPolicy = slots.some(slot => slot.mode === 'selectable' && slot.personalPolicy);
    const refreshProfiles = context.snapshot.agent.scopeType === 'user' ? allowed.flatMap(choice => choice.selection.kind === 'composio' && choice.selection.target.kind === 'personal'
      && choice.target.kind === 'personal' && choice.target.ownerUserId === context.actor.userId ? [choice.selection.target.profileId] : []) : [];
    return { alternatives: [alternative], allowed,
      personal: personalPolicy || refreshProfiles.length ? [alternative] : [],
      ...(!personalPolicy ? { profileIds: [...new Set(refreshProfiles)], refreshOnly: true } : {}),
      definitionIds: selector.source === 'mcp' ? [...new Set(slots.flatMap(slot => slot.mode === 'selectable' && slot.personalPolicy?.source === 'mcp' ? slot.personalPolicy.serverDefinitionIds : []))] : undefined,
      toolCap: null, required: slots.some(slot => slot.mode === 'fixed' ? slot.entry.requirement === 'required' : slot.requirement === 'required'), package: false };
  }
  const source = await readAgentExtensionPackageVersion({ userId: context.actor.userId, workspaceId: context.actor.workspaceId }, selector.package, { allowPersonalPackages: true });
  const binding = chatPackageBinding(context, selector.package);
  if (context.snapshot.workflowVersion !== null && !binding?.configuration) throw new AgentWorkflowError('CHAT_EXTENSION_AGENT_SCOPE', 'This exact package pin is outside the agent configuration.', 403);
  const capability = source.metadata.declarations.find(declaration => declaration.declarationPath === selector.declarationPath)?.workflow.integrationCapabilities.find(value => value.id === selector.capabilityId);
  const alternative = capability?.alternatives.find(value => key(value) === selector.alternativeKey);
  if (!alternative || alternative.source === 'composio' && !isComposioIntegrationApplicationVisible(alternative.toolkit)) throw new AgentWorkflowError('CHAT_EXTENSION_ALTERNATIVE_INVALID', 'Choose one exact published requirement alternative.', 400);
  const effective = binding?.configuration ? projectPackageExtensionSelection({ source: binding.configuration, kind: source.metadata.kind,
    inventory: source.metadata.skillRoots, selections: binding.extensionSelections }).configuration : undefined;
  const configured = effective?.declarations.find(declaration => declaration.declarationPath === selector.declarationPath)?.capabilities.find(value => value.capabilityId === selector.capabilityId);
  if (context.snapshot.workflowVersion !== null && !configured) throw new AgentWorkflowError('CHAT_EXTENSION_AGENT_SCOPE', 'This requirement is outside the configured package scope.', 403);
  const selection = configured?.selection;
  const choices = selection ? selection.mode === 'fixed' ? [{ ...selection, choiceId: 'fixed' }] : selection.allowedChoices : undefined;
  const policy = selection?.mode === 'selectable' ? selection.personalPolicy : undefined;
  const personalPolicy = context.snapshot.workflowVersion === null || policy?.sources.includes(alternative.source) && policy.alternativeKeys.includes(selector.alternativeKey);
  const refreshProfiles = context.snapshot.agent.scopeType === 'user' ? (choices ?? []).flatMap(choice => choice.alternativeKey === selector.alternativeKey
    && choice.target.kind === 'personal' && choice.target.ownerUserId === context.actor.userId && choice.target.personalBinding?.source === 'composio'
      ? [choice.target.personalBinding.profileId] : []) : [];
  return { alternatives: [alternative], ...(choices ? { allowed: choices.filter(choice => choice.alternativeKey === selector.alternativeKey)
    .map(choice => ({ ...choice, selection: publicChatConnectionSelection(choice.target, alternative) })) } : {}),
    personal: personalPolicy || refreshProfiles.length ? [alternative] : [],
    ...(!personalPolicy ? { profileIds: [...new Set(refreshProfiles)], refreshOnly: true } : {}),
    definitionMappings: policy?.mcpDefinitionMappings, toolCap: policy?.toolCap ?? null,
    required: capability!.required || configured?.required === true, package: true,
    ...(alternative.source === 'mcp' && context.snapshot.workflowVersion === null ? { template: await readChatPackageMcpTemplate(source, selector.package, alternative.connector) } : {}) };
}
export function intersectChatCaps(...caps: (readonly string[] | null)[]): string[] | null { return intersectPackageExtensionToolCaps(...caps); }

export function chatStandaloneToolCap(context: ChatExtensionOptionsContext, selection: StandaloneExtensionSelection, definitionId?: string): string[] | null {
  if (context.snapshot.workflowVersion === null) return null;
  const caps: Array<readonly string[] | null> = [];
  for (const binding of context.snapshot.bindings) if (binding.standaloneConfiguration) {
    const slot = parseStoredStandaloneExtensionBinding(binding.standaloneConfiguration);
    const exact = (slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices).find(choice => same(choice.selection, selection));
    if (exact) { caps.push(exact.toolCap); continue; }
    const policy = slot.mode === 'selectable' ? slot.personalPolicy : undefined;
    if (selection.target.kind === 'personal' && policy && (selection.kind === 'composio' && policy.source === 'composio' && policy.toolkit === selection.toolkit
      || selection.kind === 'mcp' && policy.source === 'mcp' && definitionId && policy.serverDefinitionIds.includes(definitionId))) caps.push(policy.toolCap);
  }
  return intersectPackageExtensionToolCaps(...caps);
}
