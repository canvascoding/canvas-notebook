import 'server-only';

import { inspectManagedAgentWorkflow, listManagedAgentWorkflowOptions, setManagedAgentWorkflowChoice,
  updateManagedAgentConfiguration } from '@/app/lib/agents/workflow-configuration';
import { updateAgentConfigurationSchema, updateAgentWorkflowChoiceSchema, bindOwnAgentWorkflowChoiceInput,
  agentWorkflowPersonalOptionsSchema } from '@/app/lib/agents/workflow-api-contracts';
import { agentWorkflowManagementRequestSchema } from '@/app/lib/agents/workflow-management-contracts';
import { listAgentWorkflowManagementOptions } from '@/app/lib/agents/workflow-management';
import { listAgentWorkflowPersonalOptions } from '@/app/lib/agents/workflow-personal-options';
import type { AgentManagementActor } from '@/app/lib/agents/management-actions';
import { MobileScopedError, revalidateMobileScopedContext, mobileScopedJson, mobileScopedResponse,
  type MobileScopedContext } from './scoped-route-v2';

export function mobileWorkflowAgentId(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) throw new MobileScopedError('INVALID_REQUEST', 'An exact agent identity is required.');
  return value;
}
function actor(context: MobileScopedContext): AgentManagementActor {
  return { userId: context.userId, sessionId: context.authSessionId, source: 'api', organizationId: context.organizationId,
    workspaceId: context.workspaceId, projectId: context.projectId };
}
export async function readMobileAgentWorkflow(context: MobileScopedContext, request: Request, agentId: string) {
  const query = new URL(request.url).searchParams, view = query.get('view');
  if (view !== null && view !== 'options' && view !== 'personal-options') throw new MobileScopedError('INVALID_REQUEST', 'Choose a supported workflow view.');
  const selectors = ['capabilityKey', 'alternativeKey', 'providerRef', 'expectedWorkflowRevision'];
  if (view !== 'personal-options' && selectors.some(key => query.has(key))) throw new MobileScopedError('INVALID_REQUEST', 'Unexpected workflow selectors.');
  const id = mobileWorkflowAgentId(agentId);
  await revalidateMobileScopedContext(context);
  if (view === 'personal-options') {
    const parsed = agentWorkflowPersonalOptionsSchema.parse({ agentId: id, capabilityKey: query.get('capabilityKey'),
      alternativeKey: query.get('alternativeKey') ?? undefined, providerRef: query.get('providerRef') ?? undefined,
      expectedWorkflowRevision: query.has('expectedWorkflowRevision') ? Number(query.get('expectedWorkflowRevision')) : undefined });
    return mobileScopedResponse(context, { options: await listAgentWorkflowPersonalOptions(actor(context), parsed) });
  }
  const workflow = view === 'options' ? await listManagedAgentWorkflowOptions(actor(context), id) : await inspectManagedAgentWorkflow(actor(context), id);
  return mobileScopedResponse(context, { workflow });
}
export async function readMobileAgentConfigurationSources(context: MobileScopedContext, request: Request, agentId: string) {
  const params = new URL(request.url).searchParams, raw: Record<string, unknown> = { view: 'management', agentId: mobileWorkflowAgentId(agentId) };
  for (const [key, value] of params) {
    if (key === 'workspaceId') continue;
    raw[key] = ['expectedRevision', 'expectedWorkflowRevision', 'page', 'limit'].includes(key) ? Number(value) : value;
  }
  const input = agentWorkflowManagementRequestSchema.parse(raw);
  await revalidateMobileScopedContext(context);
  return mobileScopedResponse(context, { sources: await listAgentWorkflowManagementOptions(actor(context), input) });
}
/** Choice changes use the same strict personal-selection policy; an omitted owner means this authenticated user only. */
export async function chooseMobileAgentWorkflow(context: MobileScopedContext, request: Request, agentId: string) {
  const body = await mobileScopedJson(request), id = mobileWorkflowAgentId(agentId);
  if (Object.hasOwn(body, 'agentId')) throw new MobileScopedError('INVALID_REQUEST', 'The route selects the agent.');
  const input = updateAgentWorkflowChoiceSchema.parse({ ...body, agentId: id });
  await revalidateMobileScopedContext(context);
  const workflow = await setManagedAgentWorkflowChoice({ ...bindOwnAgentWorkflowChoiceInput(input, context.userId), actor: actor(context) });
  return mobileScopedResponse(context, { workflow });
}
export async function configureMobileAgentWorkflow(context: MobileScopedContext, request: Request, agentId: string) {
  const body = await mobileScopedJson(request), id = mobileWorkflowAgentId(agentId);
  if (Object.hasOwn(body, 'agentId')) throw new MobileScopedError('INVALID_REQUEST', 'The route selects the agent.');
  const input = updateAgentConfigurationSchema.parse({ ...body, agentId: id });
  if (input.expectedWorkflowRevision === undefined || !Object.hasOwn(body, 'workflow')) {
    throw new MobileScopedError('INVALID_REQUEST', 'The exact workflow and agent revisions are required.');
  }
  await revalidateMobileScopedContext(context);
  const { workflow } = await updateManagedAgentConfiguration({ ...input, actor: actor(context) });
  return mobileScopedResponse(context, { workflow });
}
