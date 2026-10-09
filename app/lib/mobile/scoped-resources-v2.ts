import 'server-only';

import { z } from 'zod';
import { listCapabilityResources, inspectCapabilityResource, configureCapabilityResource, updateCapabilityResource,
  listCapabilityResourceTargets } from '@/app/lib/capabilities/resources/actions';
import type { CapabilityResourceDescriptor } from '@/app/lib/capabilities/resources/contracts';
import { createSharedConnection, updateSharedConnection, resolveSharedConnectionOwnership } from '@/app/lib/integration-tools/connections/actions';
import { listSharedIntegrationConnections, inspectSharedIntegrationConnection, listSharedIntegrationConnectionTargets,
  listManageableSharedIntegrationScopes, listSharedIntegrationSetupTargets } from '@/app/lib/integration-tools/connections/store';
import type { IntegrationConnectionDescriptor } from '@/app/lib/integration-tools/connections/contracts';
import { MobileScopedError, revalidateMobileScopedContext, mobileScopedJson, mobileScopedResponse,
  type MobileScopedContext } from './scoped-route-v2';

const scope = z.enum(['user', 'organization', 'team']);
const source = z.enum(['mcp', 'composio']);
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export function mobileResourceRef(value: string): string {
  // Unadopted installed artifacts keep their exact domain-issued identity until POST adoption returns canvas-resource:UUID.
  if (typeof value !== 'string' || value.length > 1000 || /[\s\u0000-\u001f\u007f]/u.test(value)
    || !new RegExp(`^canvas-resource:${uuid}$`, 'u').test(value) && !/^canvas-capability:v1:(?:plugin|skill|connection):/u.test(value)) {
    throw new MobileScopedError('INVALID_REQUEST', 'An exact installed resource reference is required.');
  }
  return value;
}
export function mobileConnectionRef(value: string): string {
  if (typeof value !== 'string' || !new RegExp(`^canvas-connection:${uuid}$`, 'u').test(value)) {
    throw new MobileScopedError('INVALID_REQUEST', 'An exact shared connection reference is required.');
  }
  return value;
}
function actor(context: MobileScopedContext) { return { userId: context.userId, workspaceId: context.workspaceId }; }
function resourceDto(value: CapabilityResourceDescriptor) {
  // Descriptor is the existing ACL-aware safe projection, not its private storage record.
  return { resourceRef: value.metadata.resourceRef, scope: value.metadata.ownership.type, ...value };
}
function connectionDto(value: IntegrationConnectionDescriptor) {
  return { connectionRef: value.resource.connectionRef, scope: value.resource.ownership.type, ...value,
    // The connection domain has inspect/use/manage. Editing its metadata is a management action, not an independent grant.
    access: { ...value.access, canEdit: value.access.canManage }, editAuthority: 'manage' as const };
}
export async function listMobileCapabilityResources(context: MobileScopedContext, request: Request) {
  const query = new URL(request.url).searchParams, selectedScope = scope.optional().parse(query.get('scope') ?? undefined);
  const kind = z.enum(['skill', 'plugin', 'connection']).optional().parse(query.get('resourceType') ?? undefined);
  await revalidateMobileScopedContext(context);
  const resources = (await listCapabilityResources(actor(context))).filter(value => (!selectedScope || value.metadata.ownership.type === selectedScope)
    && (!kind || value.artifact.resourceType === kind)).map(resourceDto);
  return mobileScopedResponse(context, { resources });
}
export async function readMobileCapabilityResource(context: MobileScopedContext, reference: string) {
  await revalidateMobileScopedContext(context);
  return mobileScopedResponse(context, { resource: resourceDto(await inspectCapabilityResource(actor(context), mobileResourceRef(reference))) });
}
export async function writeMobileCapabilityResource(context: MobileScopedContext, request: Request, reference: string, configure = false) {
  const ref = mobileResourceRef(reference), input = await mobileScopedJson(request, 65_536);
  await revalidateMobileScopedContext(context);
  const resource = configure ? await configureCapabilityResource(actor(context), ref, input) : await updateCapabilityResource(actor(context), ref, input);
  return mobileScopedResponse(context, { resource: resourceDto(resource) });
}
export async function readMobileCapabilityTargets(context: MobileScopedContext, reference: string) {
  await revalidateMobileScopedContext(context);
  return mobileScopedResponse(context, { targets: await listCapabilityResourceTargets(actor(context), mobileResourceRef(reference)) });
}
export async function readMobileSharedConnections(context: MobileScopedContext, request: Request) {
  const query = new URL(request.url).searchParams, selectedSource = source.optional().parse(query.get('source') ?? undefined);
  const selectedScope = z.enum(['organization', 'team']).optional().parse(query.get('scope') ?? undefined);
  await revalidateMobileScopedContext(context);
  const connections = (await listSharedIntegrationConnections(actor(context), selectedSource))
    .filter(value => !selectedScope || value.resource.ownership.type === selectedScope).map(connectionDto);
  return mobileScopedResponse(context, { connections });
}
export async function readMobileSharedConnection(context: MobileScopedContext, reference: string) {
  await revalidateMobileScopedContext(context);
  return mobileScopedResponse(context, { connection: connectionDto(await inspectSharedIntegrationConnection(actor(context), mobileConnectionRef(reference))) });
}
export async function writeMobileSharedConnection(context: MobileScopedContext, request: Request, reference?: string) {
  const input = await mobileScopedJson(request, 262_144);
  const ref = reference === undefined ? undefined : mobileConnectionRef(reference);
  await revalidateMobileScopedContext(context);
  const connection = ref === undefined ? await createSharedConnection(actor(context), input) : await updateSharedConnection(actor(context), ref, input);
  return mobileScopedResponse(context, { connection: connectionDto(connection) });
}
export async function readMobileSharedConnectionTargets(context: MobileScopedContext, reference: string) {
  await revalidateMobileScopedContext(context);
  return mobileScopedResponse(context, { targets: await listSharedIntegrationConnectionTargets(actor(context), mobileConnectionRef(reference)) });
}
export async function readMobileSharedConnectionSetup(context: MobileScopedContext, request: Request) {
  const query = new URL(request.url).searchParams;
  await revalidateMobileScopedContext(context);
  if (!query.has('ownershipType')) {
    if (query.has('teamWorkspaceId')) throw new MobileScopedError('INVALID_REQUEST', 'Choose an explicit team ownership scope.');
    return mobileScopedResponse(context, { scopes: await listManageableSharedIntegrationScopes(actor(context)) });
  }
  const type = z.enum(['organization', 'team']).parse(query.get('ownershipType'));
  if (type === 'organization' && query.has('teamWorkspaceId')) throw new MobileScopedError('INVALID_REQUEST', 'Unexpected team selector.');
  const ownership = await resolveSharedConnectionOwnership(actor(context), type === 'team'
    ? { type, workspaceId: query.get('teamWorkspaceId') } : { type });
  await revalidateMobileScopedContext(context);
  return mobileScopedResponse(context, { ownership, targets: await listSharedIntegrationSetupTargets(actor(context), ownership) });
}
