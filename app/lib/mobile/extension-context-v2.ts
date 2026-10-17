import 'server-only';

import { NextRequest } from 'next/server';
import { createManagedAgent, inspectManagedAgent, type AgentManagementActor } from '@/app/lib/agents/management-actions';
import { listManagedAgentExtensionOptions } from '@/app/lib/agents/extension-options';
import { updateManagedAgentConfiguration } from '@/app/lib/agents/workflow-configuration';
import { createAgentConfigurationSchema, updateAgentConfigurationSchema } from '@/app/lib/agents/workflow-api-contracts';
import { listChatExtensionOptions } from '@/app/lib/chat/extension-options';
import { CHAT_EXTENSION_OPTIONS_MAX_BYTES } from '@/app/lib/chat/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '@/app/lib/capabilities/extensions/contracts';
import { mobileWorkflowAgentId } from './agent-workflow-v2';
import { projectMobileExtensionIcons } from './extension-icons-v2';
import { MobileScopedError, mobileScopedJson, mobileScopedResponse, revalidateMobileScopedContext,
  type MobileScopedContext } from './scoped-route-v2';

function actor(context: MobileScopedContext): AgentManagementActor {
  return { userId: context.userId, sessionId: context.authSessionId, source: 'api', organizationId: context.organizationId,
    workspaceId: context.workspaceId, projectId: context.projectId };
}

/** Only the version envelope is adapted. Shared services recheck exact Agent, Session, package and connection authority. */
export async function readMobileChatExtensionOptions(context: MobileScopedContext, request: NextRequest) {
  const body = await mobileScopedJson(request, CHAT_EXTENSION_OPTIONS_MAX_BYTES + 32);
  await revalidateMobileScopedContext(context);
  const data = await listChatExtensionOptions(actor(context), body, { signal: request.signal });
  return mobileScopedResponse(context, projectMobileExtensionIcons(data, context.workspaceId));
}

export async function readMobileAgentExtensionOptions(context: MobileScopedContext, request: NextRequest) {
  const body = await mobileScopedJson(request, EXTENSION_SELECTION_LIMITS.bytes + 32);
  await revalidateMobileScopedContext(context);
  const data = await listManagedAgentExtensionOptions(actor(context), body, { signal: request.signal });
  return mobileScopedResponse(context, projectMobileExtensionIcons(data, context.workspaceId));
}

/** A current editable projection, including unreadable-configuration nulls and exact saved revisions. */
export async function readMobileAgentConfiguration(context: MobileScopedContext, request: NextRequest) {
  const query = request.nextUrl.searchParams;
  for (const key of ['includeFiles', 'includeAccess']) {
    if (query.has(key) && !['true', 'false'].includes(query.get(key)!)) {
      throw new MobileScopedError('INVALID_REQUEST', 'Choose supported configuration selectors.');
    }
  }
  const agentId = mobileWorkflowAgentId(query.get('agentId') ?? '');
  await revalidateMobileScopedContext(context);
  const data = await inspectManagedAgent(actor(context), agentId, { purpose: 'configure',
    includeFiles: query.get('includeFiles') === 'true', includeAccess: query.get('includeAccess') === 'true' });
  return mobileScopedResponse(context, projectMobileExtensionIcons(data, context.workspaceId));
}

/** Existing writers retain their atomic CAS/source/rights checks; omitted extensions preserve saved configuration. */
export async function createMobileAgentConfiguration(context: MobileScopedContext, request: NextRequest) {
  const body = await mobileScopedJson(request, EXTENSION_SELECTION_LIMITS.bytes + 32);
  const input = createAgentConfigurationSchema.parse(body);
  await revalidateMobileScopedContext(context);
  return mobileScopedResponse(context, await createManagedAgent(actor(context), input));
}

export async function updateMobileAgentConfiguration(context: MobileScopedContext, request: NextRequest) {
  const body = await mobileScopedJson(request, EXTENSION_SELECTION_LIMITS.bytes + 32);
  const input = updateAgentConfigurationSchema.parse(body);
  if (!Object.keys(body).some(key => !['agentId', 'expectedRevision', 'expectedWorkflowRevision', 'expectedCatalogRevision'].includes(key))) {
    throw new MobileScopedError('INVALID_REQUEST', 'Choose a supported configuration change.');
  }
  await revalidateMobileScopedContext(context);
  const { agent, workflow, extensions } = await updateManagedAgentConfiguration({ actor: actor(context), ...input });
  return mobileScopedResponse(context, { agent: { ...agent, access: workflow.access }, workflow, extensions });
}
