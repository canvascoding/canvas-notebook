import { z } from 'zod';
import { chatBodyV1Schema, type ChatBodyV1, type ChatReferenceBundleV1 } from './chat-body-contracts';
import { chatExtensionSelectionInputSchema, extensionSelectionSchema, EXTENSION_SELECTION_LIMITS,
  type ExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { createChatExtensionMetadataSearchRequestSchema, createExtensionMetadataPackageRequestSchema, createExtensionMetadataConnectionRequestSchema,
  type AgentExtensionOptionsResponse, type AgentExtensionPackageVersion, type AgentExtensionSearchItem,
  type AgentExtensionOptionsPagination, type AgentExtensionConfigurationPreview } from '@/app/lib/agents/extension-options-contracts';
import type { PluginExtensionCoverage } from '@/app/lib/plugins/plugin-extension-contracts';
import type { PluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { PluginWorkspaceCatalogResponse } from '@/app/lib/plugins/plugin-workspace-catalog-contracts';

export const CHAT_EXTENSION_OPTIONS_MAX_BYTES = 4 * 1024 * 1024;
const id = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
export const chatExtensionOptionsTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft_turn'), agentId: id, workspaceId: id }).strict(),
  z.object({ kind: z.literal('turn'), sessionId: id, expectedAgentId: id, expectedWorkspaceId: id }).strict(),
]);
export type ChatExtensionOptionsTarget = z.infer<typeof chatExtensionOptionsTargetSchema>;
export const chatExtensionSearchRequestSchema = createChatExtensionMetadataSearchRequestSchema(chatExtensionOptionsTargetSchema);
export const chatExtensionPackageRequestSchema = createExtensionMetadataPackageRequestSchema(chatExtensionOptionsTargetSchema);
export const chatExtensionConnectionChoicesRequestSchema = createExtensionMetadataConnectionRequestSchema(chatExtensionOptionsTargetSchema);
export const chatExtensionOptionsRequestSchema = z.union([
  chatExtensionSearchRequestSchema, chatExtensionPackageRequestSchema, chatExtensionConnectionChoicesRequestSchema,
  z.object({ operation: z.literal('preview'), target: chatExtensionOptionsTargetSchema, body: chatBodyV1Schema,
    intakeSelection: chatExtensionSelectionInputSchema.nullable() }).strict(),
  z.object({ operation: z.literal('recents'), target: chatExtensionOptionsTargetSchema,
    cursor: z.string().min(1).max(8192).nullable().default(null), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ operation: z.literal('presentation'), target: chatExtensionOptionsTargetSchema,
    selections: z.array(extensionSelectionSchema).max(20) }).strict(),
]).superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > CHAT_EXTENSION_OPTIONS_MAX_BYTES)
    context.addIssue({ code: 'custom', message: 'The complete Chat options request exceeds its byte limit.' });
});
export type ChatExtensionOptionsRequest = z.infer<typeof chatExtensionOptionsRequestSchema>;
export type ChatExtensionSearchRequest = Extract<ChatExtensionOptionsRequest, { operation: 'search' }>;
export type ChatExtensionConnectionChoicesRequest = Extract<ChatExtensionOptionsRequest, { operation: 'connection_choices' }>;
export type ChatExtensionOptionsHeader = {
  schemaVersion: 1; target: ChatExtensionOptionsTarget; contextKey: string;
  agentRevision: number; workflowRevision: number; preferenceRevision: number;
  coverage: PluginExtensionCoverage[]; limits: typeof EXTENSION_SELECTION_LIMITS; finalSendValidationRequired: true;
};
export type ChatExtensionRecentItem = { bodyBundle: ChatReferenceBundleV1; lastAcceptedAt: number;
  eligibility: AgentExtensionSearchItem['eligibility']; publicIcon?: PluginExtensionIcon;
  /** Search grouping only, never a retained connection or execution authorization. */
  chatAvailability?: 'ready' | 'setup' };
export type ChatExtensionOptionsPreview = Omit<AgentExtensionConfigurationPreview, 'budget' | 'finalSaveValidationRequired'> & {
  budget: null; finalSendValidationRequired: true;
};
type Connections = Extract<AgentExtensionOptionsResponse, { operation: 'connection_choices' }>;
export type ChatExtensionOptionsResponse =
  | (ChatExtensionOptionsHeader & { operation: 'search'; query: ChatExtensionSearchRequest; items: AgentExtensionSearchItem[];
    selectedItem: AgentExtensionSearchItem | null; scopes: PluginWorkspaceCatalogResponse['scopes'];
    pagination: AgentExtensionOptionsPagination; recents: ChatExtensionRecentItem[] })
  | (ChatExtensionOptionsHeader & { operation: 'package_version'; package: AgentExtensionPackageVersion })
  | (ChatExtensionOptionsHeader & Pick<Connections, 'connections' | 'profiles' | 'accounts' | 'pagination' | 'setupAlternatives' | 'noAuthSelection' | 'personalSelectionPolicy'>
    & { operation: 'connection_choices'; selector: ChatExtensionConnectionChoicesRequest['selector'] })
  | (ChatExtensionOptionsHeader & { operation: 'preview'; preview: ChatExtensionOptionsPreview })
  | (ChatExtensionOptionsHeader & { operation: 'recents'; items: ChatExtensionRecentItem[]; pagination: AgentExtensionOptionsPagination })
  | (ChatExtensionOptionsHeader & { operation: 'presentation'; entries: Array<{ selection: ExtensionSelection; publicIcon?: PluginExtensionIcon }> });
/** Body presentation never replaces exact selections, and receipts remain in the separate transient intake envelope. */
export type ChatExtensionPreviewBody = ChatBodyV1;
