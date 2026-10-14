import 'server-only';
import type { SqlConnection } from '@/app/lib/db';
import { authorizeAgentExtensionSharedOption, listAgentExtensionSharedOptions, revalidateAgentExtensionOptionsContext,
  type AgentExtensionOptionsContext } from './extension-options-context';
import { authorizeChatExtensionSharedOption, listChatExtensionSharedOptions, revalidateChatExtensionOptionsContext,
  isChatExtensionOptionsContext, type ChatExtensionOptionsContext } from '@/app/lib/chat/extension-options-context';

/** Purpose dispatch only. Existing configuration and per-user choice authority kernels are unchanged. */
export type ExtensionOptionsSourceContext = AgentExtensionOptionsContext | ChatExtensionOptionsContext;
export function revalidateExtensionOptionsSourceContext(context: ExtensionOptionsSourceContext, options: { database?: SqlConnection } = {}) {
  return isChatExtensionOptionsContext(context) ? revalidateChatExtensionOptionsContext(context, options)
    : revalidateAgentExtensionOptionsContext(context as AgentExtensionOptionsContext, options);
}
export function authorizeExtensionSharedOption(context: ExtensionOptionsSourceContext, reference: string) {
  return isChatExtensionOptionsContext(context) ? authorizeChatExtensionSharedOption(context, reference)
    : authorizeAgentExtensionSharedOption(context as AgentExtensionOptionsContext, reference);
}
export function listExtensionSharedOptions(context: ExtensionOptionsSourceContext, source?: 'mcp' | 'composio') {
  return isChatExtensionOptionsContext(context) ? listChatExtensionSharedOptions(context, source)
    : listAgentExtensionSharedOptions(context as AgentExtensionOptionsContext, source);
}
