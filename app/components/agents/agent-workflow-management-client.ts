import { agentWorkflowManagementRequestSchema, type AgentWorkflowManagement, type AgentWorkflowManagementOptions,
  type AgentWorkflowManagementRequest } from '@/app/lib/agents/workflow-management-contracts';
import type { AgentWorkflowConfiguration, AgentWorkflowDescriptor } from '@/app/lib/agents/workflow-contracts';
import type { AgentProfile } from '@/app/lib/agents/registry';
import type { CapabilityPackagePublishedSummary } from '@/app/lib/capabilities/packages/contracts';
import { agentExtensionConfigurationInputSchema, type AgentExtensionConfigurationInput } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionConfigurationDescriptor } from '@/app/lib/agents/extension-inspection';
import { AgentWorkflowClientError, requestWorkflow } from './agent-workflow-client';

export type AgentWorkflowManagementContext = Readonly<{ agentId: string; workspaceId: string | null;
  projectId?: string | null; organizationId?: string | null; actorId?: string | null }>;
export type AgentWorkflowManagementSaveInput = { agentId: string; expectedRevision: number; expectedWorkflowRevision: number;
  workflow?: AgentWorkflowConfiguration | null; extensions?: AgentExtensionConfigurationInput; enabledTools?: string[] | null };
export type AgentWorkflowManagementSaveResult = { agent: AgentProfile & { access: AgentWorkflowManagement['access'] };
  workflow: AgentWorkflowDescriptor };
export class AgentWorkflowManagementClientError extends AgentWorkflowClientError {
  constructor(code: 'WORKFLOW_CLIENT_INVALID' | 'WORKFLOW_REPLY_INVALID', readonly mutationCompleted = false) {
    super(code === 'WORKFLOW_CLIENT_INVALID' ? 400 : 409, code);
  }
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function revision(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0);
}
function capture(context: AgentWorkflowManagementContext): AgentWorkflowManagementContext {
  if (!identifier(context.agentId) || [context.workspaceId, context.projectId, context.organizationId, context.actorId]
    .some(value => value !== undefined && value !== null && !identifier(value))) throw new AgentWorkflowManagementClientError('WORKFLOW_CLIENT_INVALID');
  return Object.freeze({ agentId: context.agentId, workspaceId: context.workspaceId ?? null,
    projectId: context.projectId ?? null, organizationId: context.organizationId ?? null, actorId: context.actorId ?? null });
}
export function agentWorkflowManagementContextKey(context: AgentWorkflowManagementContext): string {
  const value = capture(context);
  return JSON.stringify([value.agentId, value.workspaceId, value.projectId, value.organizationId, value.actorId]);
}
function url(path: string, context: AgentWorkflowManagementContext, selectors?: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(selectors ?? {})) if (value !== undefined) query.set(key, String(value));
  for (const key of ['workspaceId', 'projectId', 'organizationId'] as const) if (context[key] !== null && context[key] !== undefined) query.set(key, context[key]);
  return `${path}${query.size ? `?${query}` : ''}`;
}
function validHeader(value: unknown, request: AgentWorkflowManagementRequest): value is AgentWorkflowManagementOptions {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<AgentWorkflowManagementOptions>;
  if (row.schemaVersion !== 1 || row.view !== request.view || row.agentId !== request.agentId || !revision(row.revision, true)
    || !revision(row.workflowRevision)) return false;
  if (request.view !== 'management' && (row.revision !== request.expectedRevision || row.workflowRevision !== request.expectedWorkflowRevision)) return false;
  if (request.view === 'package-version' && (row.view !== 'package-version' || row.resourceRef !== request.resourceRef
    || row.publishedRevisionRef !== request.publishedRevisionRef || typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(row.checksum))) return false;
  if (row.view === 'management') return row.profile?.agentId === row.agentId && typeof row.access?.canEdit === 'boolean'
    && typeof row.configurationState === 'string' && ['legacy', 'available', 'blocked'].includes(row.configurationState)
    && (row.workflowVersion === null || row.workflowVersion === 1)
    && (row.configurationState !== 'available' || row.workflowVersion === 1 && row.configuration?.version === 1 && Array.isArray(row.configuration.packages))
    && (row.configurationState === 'available' || row.configuration === null);
  return true;
}
/** The caller also fences delivery by its selection epoch; this helper never reads a mutable global context. */
export async function readAgentWorkflowManagementOptions<R extends AgentWorkflowManagementRequest>(contextInput: AgentWorkflowManagementContext,
  input: R, signal?: AbortSignal): Promise<Extract<AgentWorkflowManagementOptions, { view: R['view'] }>> {
  const context = capture(contextInput), request = agentWorkflowManagementRequestSchema.safeParse(structuredClone(input));
  if (!request.success || request.data.agentId !== context.agentId) throw new AgentWorkflowManagementClientError('WORKFLOW_CLIENT_INVALID');
  const data = await requestWorkflow<unknown>(url('/api/agents/workflow', context, request.data), { signal });
  if (!validHeader(data, request.data)) throw new AgentWorkflowManagementClientError('WORKFLOW_REPLY_INVALID');
  return data as Extract<AgentWorkflowManagementOptions, { view: R['view'] }>;
}
export function readAgentWorkflowManagement(context: AgentWorkflowManagementContext, signal?: AbortSignal): Promise<AgentWorkflowManagement> {
  return readAgentWorkflowManagementOptions(context, { view: 'management', agentId: context.agentId }, signal);
}
export type AgentExtensionManagementSnapshot = { agent: AgentProfile; access: AgentWorkflowManagement['access'];
  extensions: AgentExtensionConfigurationDescriptor };
/** Genuine configure inspection, not a V1 reconstruction from names or an empty fallback. */
export async function readAgentExtensionManagement(contextInput: AgentWorkflowManagementContext,
  signal?: AbortSignal): Promise<AgentExtensionManagementSnapshot> {
  const context = capture(contextInput);
  const data = await requestWorkflow<AgentExtensionManagementSnapshot>(url('/api/agents', context,
    { agentId: context.agentId, purpose: 'configure', includeFiles: false }), { signal });
  const extension = data?.extensions;
  if (data?.agent?.agentId !== context.agentId || !revision(data.agent.revision, true)
    || extension?.agentId !== context.agentId || extension.revision !== data.agent.revision
    || !revision(extension.workflowRevision) || extension.workflowRevision !== (data.agent.workflowRevision ?? 0)
    || !data.access || ['canUse', 'canEdit', 'canManage'].some(key => typeof Reflect.get(data.access, key) !== 'boolean')
    || !['legacy', 'available', 'blocked'].includes(extension.configurationState) || !Array.isArray(extension.readiness)) {
    throw new AgentWorkflowManagementClientError('WORKFLOW_REPLY_INVALID');
  }
  if (extension.configurationState === 'blocked') {
    if (extension.configuration !== null) throw new AgentWorkflowManagementClientError('WORKFLOW_REPLY_INVALID');
  } else {
    const parsed = agentExtensionConfigurationInputSchema.safeParse(extension.configuration);
    if (!parsed.success || (extension.configurationState === 'legacy') !== (parsed.data.mode === 'legacy_inherit')) {
      throw new AgentWorkflowManagementClientError('WORKFLOW_REPLY_INVALID');
    }
    extension.configuration = parsed.data;
  }
  return data;
}
/** History supplies candidate metadata only; applying a version still requires the exact manager package-version gate. */
export async function readAgentWorkflowPackageVersions(contextInput: AgentWorkflowManagementContext, resourceRef: string,
  signal?: AbortSignal): Promise<CapabilityPackagePublishedSummary[]> {
  const context = capture(contextInput), uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const publishedPattern = new RegExp(`^canvas-package-revision:${uuid}$`, 'u');
  if (!new RegExp(`^canvas-resource:${uuid}$`, 'u').test(resourceRef)) throw new AgentWorkflowManagementClientError('WORKFLOW_CLIENT_INVALID');
  // This existing resource route derives organization/project authority from the requested workspace.
  const data = await requestWorkflow<{ versions?: CapabilityPackagePublishedSummary[] }>(url(`/api/capabilities/packages/${encodeURIComponent(resourceRef)}/versions`,
    { ...context, organizationId: null, projectId: null }), { signal });
  if (!Array.isArray(data.versions) || data.versions.length > 100 || data.versions.some(value => !value || value.resourceRef !== resourceRef
    || !publishedPattern.test(value.revisionRef) || !/^[a-f0-9]{64}$/u.test(value.checksum) || !['plugin', 'skill'].includes(value.kind)
    || !identifier(value.name) || !identifier(value.version) || !revision(value.publishedAt) || !revision(value.fileCount) || !revision(value.totalBytes)
    || value.publishedByUserId !== null && !identifier(value.publishedByUserId)
    || value.baseRevisionRef !== null && !publishedPattern.test(value.baseRevisionRef))
    || new Set(data.versions.map(value => value.revisionRef)).size !== data.versions.length) throw new AgentWorkflowManagementClientError('WORKFLOW_REPLY_INVALID');
  return data.versions.map(value => ({ resourceRef: value.resourceRef, revisionRef: value.revisionRef, kind: value.kind, name: value.name,
    version: value.version, checksum: value.checksum, publishedByUserId: value.publishedByUserId, publishedAt: value.publishedAt,
    baseRevisionRef: value.baseRevisionRef, fileCount: value.fileCount, totalBytes: value.totalBytes }));
}
/** A successful reply is an acknowledgement, not the next editable management snapshot. Reload management after it. */
export async function saveAgentWorkflowManagement(contextInput: AgentWorkflowManagementContext, input: AgentWorkflowManagementSaveInput,
  signal?: AbortSignal): Promise<AgentWorkflowManagementSaveResult> {
  const context = capture(contextInput), body = structuredClone(input);
  if (body.agentId !== context.agentId || !revision(body.expectedRevision, true) || !revision(body.expectedWorkflowRevision)
    || Object.keys(body).some(key => !['agentId', 'expectedRevision', 'expectedWorkflowRevision', 'workflow', 'extensions', 'enabledTools'].includes(key))
    || body.workflow === undefined && body.extensions === undefined && body.enabledTools === undefined
    || body.workflow !== undefined && body.extensions !== undefined
    || body.extensions !== undefined && !agentExtensionConfigurationInputSchema.safeParse(body.extensions).success
    || body.enabledTools !== undefined && body.enabledTools !== null && (!Array.isArray(body.enabledTools) || body.enabledTools.length > 512
      || body.enabledTools.some(tool => !identifier(tool)) || new Set(body.enabledTools).size !== body.enabledTools.length)) {
    throw new AgentWorkflowManagementClientError('WORKFLOW_CLIENT_INVALID');
  }
  const data = await requestWorkflow<AgentWorkflowManagementSaveResult>(url('/api/agents', context), { method: 'PATCH', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const workflowRevision = body.expectedWorkflowRevision + (body.workflow === undefined && body.extensions === undefined ? 0 : 1);
  if (data.agent?.agentId !== context.agentId || data.agent.revision !== body.expectedRevision + 1
    || data.agent.workflowRevision !== workflowRevision || data.workflow?.agentId !== context.agentId
    || data.workflow.revision !== data.agent.revision || data.workflow.workflowRevision !== workflowRevision) {
    throw new AgentWorkflowManagementClientError('WORKFLOW_REPLY_INVALID', true);
  }
  return data;
}
