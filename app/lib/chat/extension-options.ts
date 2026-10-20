import 'server-only';
import { observeExtensionStage } from '@/app/lib/plugins/extension-search-observation';
import { listCapabilityResources } from '@/app/lib/capabilities/resources/actions';
import { findCapabilityResourceRecord } from '@/app/lib/capabilities/resources/store';
import { readAgentExtensionPackageVersion } from '@/app/lib/agents/extension-package-options';
import { agentExtensionPackageIcon } from '@/app/lib/agents/extension-options-icons';
import { searchChatExtensionOptions, getChatExtensionSearchConnections } from '@/app/lib/agents/extension-options-search';
import { isChatStandaloneSelectionReady } from './extension-options-connection-inventory';
import { listChatExtensionConnectionChoices } from '@/app/lib/agents/extension-options-connections';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { chatExtensionOptionsRequestSchema, type ChatExtensionOptionsResponse } from './extension-options-contracts';
import { chatExtensionOptionsHeader, resolveChatExtensionOptionsContext, revalidateChatExtensionOptionsContext } from './extension-options-context';
import { chatPackageBinding, chatPermittedPackageRoots } from './extension-options-eligibility';
import { presentChatExtensionIcon } from './extension-options-presentation';
import { readChatExtensionRecents, type ChatRecentPackageReadiness } from './extension-options-recents';
import { previewChatExtensionSelection } from './extension-options-preview';
import { captureChatTransportJson } from './message-submission';

/** One catalogue for actual Agent Use and a real workspace, before or after Session creation. */
export async function listChatExtensionOptions(actorInput: AgentManagementActor, requestInput: unknown,
  options: { signal?: AbortSignal } = {}): Promise<ChatExtensionOptionsResponse> {
  const deadline = AbortSignal.timeout(15_000);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), deadline]);
  const reason = () => deadline.aborted
    ? new AgentWorkflowError('CHAT_EXTENSION_OPTIONS_TIMEOUT', 'The extension selection took too long. Retry this step.', 504)
    : signal.reason;
  if (signal.aborted) throw reason();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      readChatExtensionOptions(actorInput, requestInput, signal),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(reason());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function readChatExtensionOptions(actorInput: AgentManagementActor, requestInput: unknown,
  signal: AbortSignal): Promise<ChatExtensionOptionsResponse> {
  let request;
  try { request = chatExtensionOptionsRequestSchema.parse(captureChatTransportJson(requestInput)); }
  catch { throw new AgentWorkflowError('CHAT_EXTENSION_OPTIONS_INVALID', 'Choose one exact Chat selection operation and current target.', 400); }
  // A live HTTP Request always has a signal. Its presence must not disable our
  // own deadline; obsolete searches and slow sources both need bounded work.
  signal.throwIfAborted();
  const context = await observeExtensionStage('context', () => resolveChatExtensionOptionsContext(actorInput, request.target));
  signal.throwIfAborted();
  const header = () => chatExtensionOptionsHeader(context);
  if (request.operation === 'search') {
    const result = await searchChatExtensionOptions(context, request, signal);
    signal.throwIfAborted();
    const packageReadiness: ChatRecentPackageReadiness = new Map();
    const connections = getChatExtensionSearchConnections(result);
    const recents = request.q === '' && request.phase !== 'remote'
      ? (await observeExtensionStage('recents', () => readChatExtensionRecents(context, { limit: request.limit, cursor: null }, signal, request, { packageReadiness, connections }))).items : [];
    for (const recent of recents) {
      const standalone = [recent.bodyBundle.primary, ...recent.bodyBundle.supporting].map(entry => entry.selection)
        .filter(selection => selection.kind === 'mcp' || selection.kind === 'composio');
      const row = result.items.find(item => item.selection && JSON.stringify(item.selection) === JSON.stringify(recent.bodyBundle.primary.selection));
      const usable = recent.eligibility.action !== 'unavailable' && recent.eligibility.action !== 'setup'
        && standalone.every(selection => isChatStandaloneSelectionReady(selection, connections));
      const primary = recent.bodyBundle.primary.selection, packageReady = packageReadiness.get(recent);
      if (packageReady !== undefined && (primary.kind === 'plugin' || primary.kind === 'skill')) {
        // A fully revalidated exact bundle supplies fresh immutable declarations
        // even when the background descriptor cache was cold or expired. It
        // cannot override current catalogue Use/activation/eligibility denials.
        const rowUsable = !row || row.item.stock === 'installed' && row.item.access.canUse
          && (row.eligibility.action === 'select' || row.eligibility.action === 'choose_connection')
          && (row.item.kind !== 'plugin' && row.item.kind !== 'skill' || !row.item.package?.activation || row.item.package.activation.enabled);
        const ready = usable && rowUsable && packageReady;
        recent.chatAvailability = ready ? 'ready' : 'setup';
        // The default has no historical optional bindings. Their failure blocks
        // the exact recent intent, while its independently usable package stays available.
        if (row && rowUsable) row.chatAvailability = packageReady ? 'ready' : 'setup';
      } else recent.chatAvailability = usable && row?.chatAvailability !== 'setup' ? 'ready' : 'setup';
    }
    signal.throwIfAborted();
    return { ...result, ...header(), coverage: result.coverage, operation: 'search', recents };
  }
  if (request.operation === 'recents') return { ...header(), operation: 'recents', ...await observeExtensionStage('recents', () => readChatExtensionRecents(context, request, signal)) };
  if (request.operation === 'presentation') {
    const entries = [];
    for (const selection of request.selections) {
      signal.throwIfAborted();
      const publicIcon = await presentChatExtensionIcon(context, selection, signal).catch(() => undefined);
      entries.push({ selection, ...(publicIcon ? { publicIcon } : {}) });
    }
    signal.throwIfAborted();
    await revalidateChatExtensionOptionsContext(context);
    return { ...header(), operation: 'presentation', entries };
  }
  if (request.operation === 'preview') return { ...header(), operation: 'preview', preview: await observeExtensionStage('preview', () => previewChatExtensionSelection(context, request, signal)) };
  if (request.operation === 'connection_choices') {
    const choices = await listChatExtensionConnectionChoices(context, request, signal);
    const { connections, profiles, accounts, noAuthSelection, personalSelectionPolicy, pagination, coverage, setupAlternatives } = choices;
    return { ...header(), operation: 'connection_choices', selector: request.selector, connections: connections.map(({ packageBinding: _binding, ...choice }) => choice),
      profiles, accounts: accounts.map(({ packageBinding: _binding, ...choice }) => choice), pagination, coverage,
      ...(noAuthSelection ? { noAuthSelection } : {}), ...(personalSelectionPolicy ? { personalSelectionPolicy } : {}),
      ...(setupAlternatives ? { setupAlternatives } : {}) };
  }
  const resourceActor = { userId: context.actor.userId, workspaceId: context.actor.workspaceId };
  const { metadata, source } = await readAgentExtensionPackageVersion(resourceActor, { resourceRef: request.resourceRef,
    publishedRevisionRef: request.publishedRevisionRef, ...(request.checksum ? { checksum: request.checksum } : {}) }, { allowPersonalPackages: true });
  signal.throwIfAborted();
  const pin = { resourceRef: metadata.resourceRef, publishedRevisionRef: metadata.publishedRevisionRef, checksum: metadata.checksum };
  const binding = chatPackageBinding(context, pin);
  if (context.snapshot.workflowVersion !== null && !binding?.configuration) throw new AgentWorkflowError('CHAT_EXTENSION_AGENT_SCOPE', 'This exact package pin is outside the current agent configuration.', 403);
  const permitted = new Set(chatPermittedPackageRoots(context, pin, { metadata, source }));
  const resources = await listCapabilityResources(resourceActor), record = await findCapabilityResourceRecord(pin.resourceRef);
  signal.throwIfAborted();
  const icon = agentExtensionPackageIcon(pin, metadata.kind === 'plugin' ? [source.manifest?.interface?.logo, source.manifest?.interface?.icon]
    : [source.skills[0]?.skill.interface?.iconSmall, source.skills[0]?.skill.interface?.iconLarge], context.actor.workspaceId);
  const children = metadata.skillRoots.filter(child => permitted.has(child.relativeRoot)).map(child => {
    const skill = source.skills.find(value => value.relativeRoot === child.relativeRoot)?.skill;
    return { ...child, origin: metadata.kind === 'plugin' ? 'plugin_child' as const : 'standalone' as const,
      required: resources.some(resource => resource.access.canUse && resource.activation?.effectivePolicy === 'required'
        && (metadata.kind === 'skill' ? resource.metadata.resourceRef === pin.resourceRef
          : resource.artifact.sourcePluginId === record?.storage.resourceId && resource.artifact.name === child.name)),
      icon: agentExtensionPackageIcon(pin, [skill?.interface?.iconSmall, skill?.interface?.iconLarge], context.actor.workspaceId, child.relativeRoot) };
  });
  await revalidateChatExtensionOptionsContext(context);
  return { ...header(), operation: 'package_version', coverage: [{ source: 'packages', status: 'complete' }],
    package: { pin, kind: metadata.kind, name: metadata.name, displayName: metadata.title, description: metadata.description,
      version: metadata.version, ...(icon ? { icon } : {}), children, declarations: metadata.declarations.filter(declaration => declaration.declarationPath === '.canvas-plugin/plugin.json'
        || children.some(child => declaration.declarationPath === (child.relativeRoot ? `${child.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml'))) } };
}
