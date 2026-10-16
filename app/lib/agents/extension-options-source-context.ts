import 'server-only';
import type { SqlConnection } from '@/app/lib/db';
import { authorizeAgentExtensionSharedOption, listAgentExtensionSharedOptions, revalidateAgentExtensionOptionsContext,
  type AgentExtensionOptionsContext } from './extension-options-context';
import { authorizeChatExtensionSharedOption, listChatExtensionSharedOptions, revalidateChatExtensionOptionsContext,
  isChatExtensionOptionsContext, type ChatExtensionOptionsContext } from '@/app/lib/chat/extension-options-context';
import { authorizePluginExtensionAuthoringSharedMetadata, listPluginExtensionAuthoringSharedMetadata,
  revalidatePluginExtensionAuthoringContext, isPluginExtensionAuthoringContext,
  type PluginExtensionAuthoringContext } from '@/app/lib/plugins/plugin-extension-authoring-context';

/** Purpose dispatch only. Existing configuration and per-user choice authority kernels are unchanged. */
export type ExtensionOptionsSourceContext = AgentExtensionOptionsContext | ChatExtensionOptionsContext | PluginExtensionAuthoringContext;
export function revalidateExtensionOptionsSourceContext(context: ExtensionOptionsSourceContext, options: { database?: SqlConnection } = {}) {
  return isPluginExtensionAuthoringContext(context) ? revalidatePluginExtensionAuthoringContext(context, options)
    : isChatExtensionOptionsContext(context) ? revalidateChatExtensionOptionsContext(context, options)
    : revalidateAgentExtensionOptionsContext(context as AgentExtensionOptionsContext, options);
}
export function authorizeExtensionSharedOption(context: ExtensionOptionsSourceContext, reference: string) {
  return isPluginExtensionAuthoringContext(context) ? authorizePluginExtensionAuthoringSharedMetadata(context, reference)
    : isChatExtensionOptionsContext(context) ? authorizeChatExtensionSharedOption(context, reference)
    : authorizeAgentExtensionSharedOption(context as AgentExtensionOptionsContext, reference);
}
export function listExtensionSharedOptions(context: ExtensionOptionsSourceContext, source?: 'mcp' | 'composio') {
  return isPluginExtensionAuthoringContext(context) ? listPluginExtensionAuthoringSharedMetadata(context, source)
    : isChatExtensionOptionsContext(context) ? listChatExtensionSharedOptions(context, source)
    : listAgentExtensionSharedOptions(context as AgentExtensionOptionsContext, source);
}
