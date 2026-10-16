import 'server-only';
import type { SqlConnection } from '@/app/lib/db';
import { setPersonalCapabilityActivation } from '../activation-actions';
import { loadCapabilityCandidates } from '../catalog';
import { resolveEffectiveCapabilities } from '../effective-resolver';
import { CapabilityPolicyStore } from '../policy-store';
import { CapabilityPreferenceConflictError, readCapabilityPreferences } from '../preference-store';
import type { CapabilityResolutionContext } from '../types';
import { readCanvasPluginRegistry } from '@/app/lib/plugins/canvas-plugin-registry';
import { readCanvasSkillRegistry } from '@/app/lib/skills/canvas-skill-store';
import { inspectCapabilityResource, listCapabilityResourceTargets, updateCapabilityResource } from '../resources/actions';
import { withAuthorizedCapabilityPackageResource } from '../resources/store';
import type { CapabilityResourceActor, CapabilityResourceGrantInput, CapabilityResourceStorageBinding } from '../resources/contracts';
import type { ExtensionPackagePin } from '../extensions/contracts';
import { capabilityPackageRegistryStorage, resolveCapabilityPackageArtifact } from './artifacts';
import { CapabilityPackageError, type CapabilityPackageState } from './contracts';
import { getCapabilityPackagePublishedRevision, getCapabilityPackageState } from './store';
import { setCapabilityPackageDefaultActivationAction } from './activation';
import { capabilityPackageProvisioningQuerySchema, capabilityPackageProvisioningRequestSchema,
  type CapabilityPackageProvisioning, type CapabilityPackageUseAudience } from './provisioning-contracts';

const conflict = () => new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'The package or its provisioning changed. Reload this exact publication before continuing.', 409);
const denied = () => new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Organization package management is required for provisioning.', 403);
const grantInputs = (grants: readonly CapabilityResourceGrantInput[]) => grants.map(({targetType,targetId,canUse,canEdit,canManage}) => ({targetType,targetId,canUse,canEdit,canManage}));
const canonicalGrants = (grants: readonly CapabilityResourceGrantInput[]) => JSON.stringify(grantInputs(grants).sort((a,b) => `${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`)));

/** Package publication takes the same resource row lock before changing this SQL head. */
async function assertExactHead(database: SqlConnection, pin: ExtensionPackagePin, expectedPackageRevision: number) {
  const state = await getCapabilityPackageState(pin.resourceRef, database);
  const published = await getCapabilityPackagePublishedRevision(pin.resourceRef, pin.publishedRevisionRef, database);
  if (!state || state.packageRevision !== expectedPackageRevision || state.currentPublishedRevisionRef !== pin.publishedRevisionRef
    || published?.checksum !== pin.checksum) throw conflict();
  return state;
}

async function currentDefaultActivation(storage: CapabilityResourceStorageBinding, state: CapabilityPackageState) {
  const scope = capabilityPackageRegistryStorage(storage);
  const plugins = storage.resourceType === 'plugin' ? await readCanvasPluginRegistry(scope) : null;
  const skills = storage.resourceType === 'skill' ? await readCanvasSkillRegistry(scope) : null;
  const installed = plugins?.plugins[storage.name] ?? skills?.skills[storage.name];
  if (!installed || installed.packageResourceRef !== state.resourceRef || installed.publishedRevisionRef !== state.currentPublishedRevisionRef) {
    throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The current published package is unavailable.', 503);
  }
  return plugins ? plugins.plugins[storage.name].enabled : skills!.skills[storage.name].packageDefaultEnabled !== false;
}

async function readProvisioning(actor: CapabilityResourceActor, resourceRef: string, pin: ExtensionPackagePin) {
  if (resourceRef !== pin.resourceRef) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'Choose one exact published package.');
  const source = await resolveCapabilityPackageArtifact(actor, resourceRef);
  const descriptor = await inspectCapabilityResource(actor, resourceRef);
  if (!descriptor.access.canManage || source.readOnly || descriptor.metadata.ownership.type !== 'organization') throw denied();
  const targets = await listCapabilityResourceTargets(actor, resourceRef);
  return withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', {
    expectedMetadataRevision: descriptor.metadata.metadataRevision, expectedGrantsRevision: descriptor.metadata.grantsRevision,
  }, async (authorization, database) => {
    if (!authorization.access.canManage || authorization.record.metadata.ownership.type !== 'organization') throw denied();
    const state = await getCapabilityPackageState(resourceRef, database);
    const published = await getCapabilityPackagePublishedRevision(resourceRef, pin.publishedRevisionRef, database);
    if (!state || !state.currentPublishedRevisionRef || !published || published.checksum !== pin.checksum) throw conflict();
    const defaultEnabled = await currentDefaultActivation(source.storage,state);
    const personal = (await readCapabilityPreferences(actor.userId)).preferences[source.storage.resourceId];
    const grants = grantInputs(descriptor.grants ?? []), metadata = authorization.record.metadata, ownership = metadata.ownership;
    if(ownership.type!=='organization') throw denied();
    const provisioning: CapabilityPackageProvisioning = { schemaVersion: 1, pin, kind: source.storage.resourceType, name: published.name, version: published.version,
      ownership, currentHead: {packageRevision: state.packageRevision, publishedRevisionRef: state.currentPublishedRevisionRef,
        matchesPin: state.currentPublishedRevisionRef === pin.publishedRevisionRef},
      expected: {expectedMetadataRevision: metadata.metadataRevision, expectedGrantsRevision: metadata.grantsRevision,
        expectedPackageRevision: state.packageRevision, expectedPublishedRevisionRef: state.currentPublishedRevisionRef, expectedDefaultEnabled: defaultEnabled},
      defaultEnabled, personalActivation:{resourceId:source.storage.resourceId,revision:personal?.revision ?? 0,enabled:personal?.enabled ?? null},
      audience: metadata.accessMode === 'inherit' ? {kind:'organization'} : {kind:'users',userIds:grants.filter(grant=>grant.targetType==='user'&&grant.canUse).map(grant=>grant.targetId).sort()},
      otherUseTargets: grants.flatMap(grant=>grant.canUse&&grant.targetType!=='user'?[{targetType:grant.targetType,targetId:grant.targetId}]:[]),
      targets:{users:targets.users}, policy: {canUse:authorization.access.canUse,...(descriptor.activation ?? {effectivePolicy:'optional',enabled:false,readiness:'unknown',blockedReason:null})} };
    return {provisioning,grants,storage:source.storage};
  });
}

export async function inspectCapabilityPackageProvisioningAction(actor: CapabilityResourceActor, resourceRef: string, value: unknown): Promise<CapabilityPackageProvisioning> {
  const query = capabilityPackageProvisioningQuerySchema.parse(value);
  return (await readProvisioning(actor,resourceRef,{resourceRef,...query})).provisioning;
}

function audienceGrants(existing: readonly CapabilityResourceGrantInput[], audience: CapabilityPackageUseAudience) {
  const users = new Set(audience.kind==='users'?audience.userIds:[]);
  const grants = existing.map(grant=>({...grant,canUse:audience.kind==='organization'?grant.canUse:grant.targetType==='user'&&users.has(grant.targetId)}));
  for(const userId of users) if(!grants.some(grant=>grant.targetType==='user'&&grant.targetId===userId)) grants.push({targetType:'user',targetId:userId,canUse:true,canEdit:false,canManage:false});
  // Rights held by unrelated editors/managers are preserved. Empty obsolete Use-only rows are unnecessary.
  return grants.filter(grant=>grant.canUse||grant.canEdit||grant.canManage);
}

/** Explicit follow-up steps on one published pin. This service can never publish or recreate a consumed draft. */
export async function provisionCapabilityPackageAction(actor: CapabilityResourceActor, resourceRef: string, value: unknown) {
  const input = capabilityPackageProvisioningRequestSchema.parse(structuredClone(value));
  const current = await readProvisioning(actor,resourceRef,input.pin), state = current.provisioning;
  if (!state.currentHead.matchesPin || Object.entries(state.expected).some(([key,value])=>Reflect.get(input,key)!==value)) throw conflict();
  let changed = false;
  if (input.operation==='activate') {
    if (!state.defaultEnabled) {
      await setCapabilityPackageDefaultActivationAction(actor,resourceRef,{...state.expected,enabled:true}); changed=true;
    }
  } else if(input.operation==='enable_for_me') {
    if(!state.defaultEnabled || !state.policy.canUse) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED','Activate the published package and obtain Use before enabling it for yourself.',403);
    if(state.personalActivation.revision!==input.expectedPersonalActivationRevision) throw conflict();
    const context:CapabilityResolutionContext={organizationId:state.ownership.organizationId,userId:actor.userId,workspaceId:actor.workspaceId ?? null};
    const withCurrentSource = async <T>(mutation:(snapshot:ReturnType<typeof resolveEffectiveCapabilities>)=>Promise<T>) =>
      withAuthorizedCapabilityPackageResource(actor,current.storage,'use',state.expected,async(authorization,database)=>{
        const head=await assertExactHead(database,input.pin,input.expectedPackageRevision);
        if(await currentDefaultActivation(current.storage,head)!==input.expectedDefaultEnabled) throw conflict();
        const member=await database.get('SELECT role FROM organization_user_permissions WHERE organization_id=$1 AND user_id=$2 AND status=\'active\'',[context.organizationId,actor.userId]) as {role:string}|undefined;
        const workspace=actor.workspaceId ? await database.get('SELECT project_id FROM canvas_workspaces WHERE id=$1',[actor.workspaceId]) as {project_id:string|null}|undefined : undefined;
        const effectiveContext={...context,role:member?.role ?? null,projectId:workspace?.project_id ?? null};
        const candidates=await loadCapabilityCandidates(effectiveContext,{resolveConnections:false,database});
        const snapshot=resolveEffectiveCapabilities({context:effectiveContext,candidates,policies:await new CapabilityPolicyStore(database).listOrganizationPolicies(context.organizationId)});
        const capability=snapshot.capabilities.find(entry=>entry.ref.resourceId===current.storage.resourceId);
        if(!authorization.access.canUse || !capability || capability.resourceAccess?.canUse!==true || capability.ref.checksum!==input.pin.checksum
          || capability.effectivePolicy==='blocked' || capability.readiness==='conflict') throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED','The current package cannot be enabled for this user.',403);
        return mutation(snapshot);
      });
    try {
      await setPersonalCapabilityActivation({context,actorUserId:actor.userId,resourceId:current.storage.resourceId,
        enabled:true,expectedRevision:input.expectedPersonalActivationRevision},{withAuthorizedMutation:mutation=>withCurrentSource(async snapshot=>{
          const preference=(await readCapabilityPreferences(actor.userId)).preferences[current.storage.resourceId];
          if((preference?.revision ?? 0)!==input.expectedPersonalActivationRevision) throw conflict();
          if(preference?.enabled===true) return {preference,capability:snapshot.capabilities.find(entry=>entry.ref.resourceId===current.storage.resourceId)!};
          const result=await mutation(snapshot);changed=true;return result;
        })});
    } catch(error) {
      if(error instanceof CapabilityPreferenceConflictError) throw conflict();
      throw error;
    }
  } else {
    const selected = new Set(state.targets.users.map(user=>user.userId));
    if(input.audience.kind==='users'&&input.audience.userIds.some(userId=>!selected.has(userId))) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID','Choose active members of this organization.');
    const grants=audienceGrants(current.grants,input.audience), accessMode=input.audience.kind==='organization'?'inherit':'restricted';
    if(grants.length>100) throw new CapabilityPackageError('PACKAGE_LIMIT_EXCEEDED','The audience and preserved management grants exceed the resource grant limit.',413);
    const sameAudience=state.audience.kind===input.audience.kind&&(input.audience.kind==='organization'
      ||state.audience.kind==='users'&&JSON.stringify(state.audience.userIds)===JSON.stringify([...input.audience.userIds].sort()));
    if(!sameAudience||canonicalGrants(grants)!==canonicalGrants(current.grants)) {
      await updateCapabilityResource(actor,resourceRef,{expectedMetadataRevision:state.expected.expectedMetadataRevision,
        expectedGrantsRevision:state.expected.expectedGrantsRevision,grants,accessMode},{beforeMutation:async database=>{
          const head=await assertExactHead(database,input.pin,input.expectedPackageRevision);
          if(await currentDefaultActivation(current.storage,head)!==input.expectedDefaultEnabled) throw conflict();
        }}); changed=true;
    }
  }
  const provisioning=await inspectCapabilityPackageProvisioningAction(actor,resourceRef,{publishedRevisionRef:input.pin.publishedRevisionRef,checksum:input.pin.checksum});
  if(!provisioning.currentHead.matchesPin||provisioning.expected.expectedMetadataRevision!==input.expectedMetadataRevision
    ||provisioning.expected.expectedGrantsRevision!==input.expectedGrantsRevision+Number(changed&&input.operation==='set_use_audience')
    ||input.operation==='activate'&&!provisioning.defaultEnabled
    ||input.operation==='enable_for_me'&&(!provisioning.personalActivation.enabled || !provisioning.policy.canUse
      ||provisioning.policy.effectivePolicy==='blocked' ||provisioning.policy.readiness==='conflict'
      ||provisioning.personalActivation.revision!==input.expectedPersonalActivationRevision+Number(changed))) throw conflict();
  return {provisioning,changed,completedStep:input.operation==='activate'?'activation' as const:input.operation==='enable_for_me'?'personal_activation' as const:'audience' as const};
}
