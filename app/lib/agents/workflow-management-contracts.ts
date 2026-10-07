import { z } from 'zod';
import type { AgentWorkflowConfiguration } from './workflow-contracts';
import type { WorkflowDeclaration } from '@/app/lib/capabilities/workflow-contracts';
import type { AgentWorkflowPersonalOptions } from './workflow-personal-options';

const id = z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const resourceRef = z.string().regex(new RegExp(`^canvas-resource:${uuid}$`, 'u'));
const publishedRevisionRef = z.string().regex(new RegExp(`^canvas-package-revision:${uuid}$`, 'u'));
const path = z.string().min(1).max(1024).refine(value => !value.startsWith('/') && !/^[A-Za-z]:|[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const current = { agentId: id, expectedRevision: revision.refine(value => value > 0), expectedWorkflowRevision: revision };
const pagination = { q: z.string().max(512).optional(), page: z.number().int().min(1).max(100000).default(1),
  limit: z.number().int().min(1).max(50).default(20) };
const slot = { resourceRef, publishedRevisionRef, declarationPath: path, capabilityId: id, alternativeKey: id };

export const agentWorkflowManagementPersonalConnectionsRequestSchema = z.object({
  view: z.literal('personal-connections'), ...current, ...slot, providerRef: id.optional(),
}).strict();

export const agentWorkflowManagementRequestSchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('management'), agentId: id }).strict(),
  z.object({ view: z.literal('packages'), ...current, ...pagination, kind: z.enum(['plugin', 'skill']).optional() }).strict(),
  z.object({ view: z.literal('package-version'), ...current, resourceRef, publishedRevisionRef }).strict(),
  z.object({ view: z.literal('connections'), ...current, ...slot, ...pagination }).strict(),
  agentWorkflowManagementPersonalConnectionsRequestSchema,
  z.object({ view: z.literal('personal-mcp-definitions'), ...current, ...slot }).strict(),
]);
export type AgentWorkflowManagementRequest = z.infer<typeof agentWorkflowManagementRequestSchema>;
export type AgentWorkflowManagementHeader = { schemaVersion: 1; agentId: string; revision: number; workflowRevision: number };
export type AgentWorkflowManagement = AgentWorkflowManagementHeader & {
  view: 'management'; access: { canUse: boolean; canEdit: boolean; canManage: boolean };
  profile: { agentId: string; name: string; iconId: string | null; scopeType: 'user' | 'organization' | 'system'; enabledTools: string[] | null };
  workflowVersion: 1 | null; configurationState: 'legacy' | 'available' | 'blocked';
  configuration: AgentWorkflowConfiguration | null; unavailablePackageCount: number; unavailableConnectionCount: number;
};
export type AgentWorkflowPackageVersionOption = { revisionRef: string; version: string; checksum: string; publishedAt: number };
export type AgentWorkflowPackageOption = { resourceRef: string; name: string; displayName: string; kind: 'plugin' | 'skill';
  scopeLabel: 'personal' | 'organization' | 'team' | 'system'; versions: AgentWorkflowPackageVersionOption[] };
export type AgentWorkflowManagementPagination = { page: number; limit: number; totalItems: number; totalPages: number };
export type AgentWorkflowManagementPackageVersion = AgentWorkflowManagementHeader & {
  view: 'package-version'; resourceRef: string; publishedRevisionRef: string; checksum: string; kind: 'plugin' | 'skill'; name: string; version: string;
  skillRoots: Array<{ name: string; relativeRoot: string }>; declarations: WorkflowDeclaration[];
};
export type AgentWorkflowManagementConnection = { connectionRef: string; bindingRevision: number; source: 'mcp' | 'composio';
  label: string; scopeLabel: 'organization' | 'team'; ownershipLabel?: string; application: string | null;
  allowedToolNames: string[] | null; status: 'unknown' | 'setup_required'; mappingRequired: boolean };
export type AgentWorkflowManagementOptions = AgentWorkflowManagement
  | (AgentWorkflowManagementHeader & { view: 'packages'; packages: AgentWorkflowPackageOption[]; pagination: AgentWorkflowManagementPagination })
  | AgentWorkflowManagementPackageVersion
  | (AgentWorkflowManagementHeader & { view: 'connections'; connections: AgentWorkflowManagementConnection[]; pagination: AgentWorkflowManagementPagination })
  | (AgentWorkflowManagementHeader & { view: 'personal-connections'; alternatives: AgentWorkflowPersonalOptions['alternatives'] })
  | (AgentWorkflowManagementHeader & { view: 'personal-mcp-definitions'; definitions: Array<{ definitionId: string; label: string; connector: string }> });
