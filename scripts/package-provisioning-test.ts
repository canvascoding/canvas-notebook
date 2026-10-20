import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageProvisioning } from '../app/lib/capabilities/packages/provisioning-contracts';

/** Actual post-publication authority, SQL/file commits, normal gateway schemas and targeted recovery. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({native:process.argv.includes('--native')});
  try {
    const {NextRequest} = await import('next/server');
    const route = await import('../app/api/capabilities/packages/[resourceRef]/provisioning/route');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const {setCapabilityPackageDefaultActivationAction} = await import('../app/lib/capabilities/packages/activation');
    const {creatorPluginManifestTemplate} = await import('../app/lib/plugins/creator-plugin-manifest');
    const {resolveScopedPluginRegistryPath} = await import('../app/lib/runtime-data-paths');
    const {readCapabilityPreferences,setCapabilityPreference} = await import('../app/lib/capabilities/preference-store');
    const {CapabilityPolicyStore} = await import('../app/lib/capabilities/policy-store');
    const {DEFAULT_MANAGED_AGENT_ID, writePiRuntimeConfig} = await import('../app/lib/agents/storage');
    const {DEFAULT_PI_CONFIG} = await import('../app/lib/pi/config');
    await writePiRuntimeConfig({...DEFAULT_PI_CONFIG,runtimeMigrations:{skillToolsDefaultEnabled:true}});
    const request = (user:string|null,ref:string,query='',body?:unknown)=>new NextRequest(`http://localhost:3001/api/capabilities/packages/${encodeURIComponent(ref)}/provisioning${query}`,{
      method:body===undefined?'GET':'POST',headers:user?fixture.headers(user):new Headers(),...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    const context = (resourceRef:string)=>({params:Promise.resolve({resourceRef})});
    async function success<T>(response:Response):Promise<T>{
      assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');
      const value=await response.json();assert.equal(value.success,true);assert(!JSON.stringify(value).includes(fixture.root));return value.data as T;
    }
    async function denied(response:Response,status:number){assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json()).success,false);}
    const write=async(draft:CapabilityPackageDraft,path:string,text:string)=>(await packages.writeCapabilityPackageDraftFileAction(fixture.owner,draft.draftRef,
      {expectedDraftRevision:draft.draftRevision,path,encoding:'base64',content:Buffer.from(text).toString('base64')})).draft;
    let draft=await packages.createCapabilityPackageDraftAction(fixture.owner,{operation:'create',kind:'plugin',targetName:'provisioned-account-brief',requestId:randomUUID()});
    draft=await write(draft,'.canvas-plugin/plugin.json',JSON.stringify({...structuredClone(creatorPluginManifestTemplate),name:draft.name}));
    draft=await write(draft,'skills/provisioned-brief/SKILL.md','---\nname: provisioned-brief\ndescription: Use only the exact permitted organization revision\nmetadata:\n  version: "1.0.0"\n---\n\nPinned organization source one.\n');
    draft=await write(draft,'assets/logo.svg','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Organization brief</title><desc>A precise account brief for permitted users</desc><rect width="32" height="32" fill="#17614b"/></svg>');
    const publishRequest={draftRef:draft.draftRef,expectedDraftRevision:draft.draftRevision,expectedPackageRevision:0,expectedPublishedRevisionRef:null,
      expectedMetadataRevision:0,expectedGrantsRevision:0,requestId:randomUUID()};
    const publication=await packages.publishCapabilityPackageDraftAction(fixture.owner,publishRequest),ref=publication.state.resourceRef;
    const pin={resourceRef:ref,publishedRevisionRef:publication.published.revisionRef,checksum:publication.published.checksum};
    const query=`?publishedRevisionRef=${encodeURIComponent(pin.publishedRevisionRef)}&checksum=${pin.checksum}`;
    const get=async(user='owner')=>success<CapabilityPackageProvisioning>(await route.GET(request(user,ref,query),context(ref)));
    const post=(state:CapabilityPackageProvisioning,operation:'set_use_audience'|'activate'|'enable_for_me',audience?:unknown,user='owner')=>route.POST(request(user,ref,'',{
      operation,pin:state.pin,...state.expected,...(operation==='enable_for_me'?{expectedPersonalActivationRevision:state.personalActivation.revision}:{}),...(audience===undefined?{}:{audience}),
    }),context(ref));
    const versionCount=async()=>Number((await fixture.sql.get('SELECT COUNT(*)::integer AS count FROM capability_package_versions') as {count:number}).count);
    assert.equal(await versionCount(),1);assert.equal((await packages.publishCapabilityPackageDraftAction(fixture.owner,publishRequest)).published.revisionRef,pin.publishedRevisionRef);
    await assert.rejects(packages.readCapabilityPackageDraftAction(fixture.owner,draft.draftRef),{status:404});
    let state=await get();assert.equal(state.currentHead.matchesPin,true);assert.equal(state.defaultEnabled,false);assert.deepEqual(state.audience,{kind:'users',userIds:[]});
    assert.deepEqual(state.personalActivation,{resourceId:state.personalActivation.resourceId,revision:0,enabled:null});assert.equal(state.policy.canUse,false);
    await denied(await post(state,'enable_for_me'),403);
    assert.equal((await readCapabilityPreferences('owner')).preferences[state.personalActivation.resourceId],undefined,'Management alone never creates a personal execution preference.');
    assert.equal((await resources.inspectCapabilityResource(fixture.owner,ref)).access.canUse,false,'Organization management grants no execution.');
    await denied(await route.GET(request(null,ref,query),context(ref)),401);
    await denied(await route.GET(request('alice',ref,query),context(ref)),404);
    const activated=await success<{provisioning:CapabilityPackageProvisioning;changed:boolean}>(await post(state,'activate'));
    assert.equal(activated.changed,true);state=activated.provisioning;assert.equal(state.defaultEnabled,true);
    assert.equal((await resources.inspectCapabilityResource(fixture.owner,ref)).access.canUse,false,'Activation remains independent from Use.');
    const own=await resources.inspectCapabilityResource(fixture.owner,ref);
    await resources.updateCapabilityResource(fixture.owner,ref,{expectedMetadataRevision:own.metadata.metadataRevision,expectedGrantsRevision:own.metadata.grantsRevision,
      grants:[{targetType:'user',targetId:'alice',canUse:false,canEdit:true,canManage:false},{targetType:'user',targetId:'manager',canUse:false,canEdit:false,canManage:true}]});
    state=await get();await setCapabilityPackageDefaultActivationAction(fixture.owner,ref,{...state.expected,enabled:false});state=await get();
    let grantCommitted=false,lostGrantReply=false;
    fixture.setAfterQuery(async sql=>{
      if(sql.startsWith('UPDATE capability_resources SET'))grantCommitted=true;
      if(sql==='COMMIT'&&grantCommitted&&!lostGrantReply){lostGrantReply=true;fixture.setAfterQuery(undefined);throw new Error('Lost acknowledgement after the actual grant commit.');}
    });
    try{await denied(await post(state,'set_use_audience',{kind:'users',userIds:['alice']}),503);}finally{fixture.setAfterQuery(undefined);}
    assert(lostGrantReply);state=await get();assert.deepEqual(state.audience,{kind:'users',userIds:['alice']});assert.equal(state.defaultEnabled,false);
    assert.equal(await versionCount(),1,'Sharing failure never republishes the package.');
    let current=await resources.inspectCapabilityResource(fixture.owner,ref);
    assert(current.grants?.some(grant=>grant.targetId==='alice'&&grant.canUse&&grant.canEdit&&!grant.canManage));
    assert(current.grants?.some(grant=>grant.targetId==='manager'&&!grant.canUse&&!grant.canEdit&&grant.canManage));
    assert.equal((await resources.inspectCapabilityResource(fixture.actor('manager'),ref)).access.canUse,false);
    const repeated=await success<{provisioning:CapabilityPackageProvisioning;changed:boolean}>(await post(state,'set_use_audience',{kind:'users',userIds:['alice']}));
    assert.equal(repeated.changed,false);assert.equal(repeated.provisioning.expected.expectedGrantsRevision,state.expected.expectedGrantsRevision);
    const registryPath=resolveScopedPluginRegistryPath(fixture.organizationScope);
    let lostActivationReply=false;
    fixture.setAfterQuery(async sql=>{
      if(sql!=='COMMIT'||lostActivationReply)return;
      const registry=JSON.parse(await fs.readFile(registryPath,'utf8')) as {plugins:Record<string,{enabled:boolean}>};
      if(registry.plugins[draft.name]?.enabled){lostActivationReply=true;fixture.setAfterQuery(undefined);throw new Error('Lost acknowledgement after actual activation bytes were saved.');}
    });
    try{await denied(await post(state,'activate'),503);}finally{fixture.setAfterQuery(undefined);}
    assert(lostActivationReply);state=await get();assert.equal(state.defaultEnabled,true);assert.equal(await versionCount(),1);
    assert.equal((await success<{changed:boolean}>(await post(state,'activate'))).changed,false,'A recovered completed activation is not repeated.');
    const empty=await success<{provisioning:CapabilityPackageProvisioning}>(await post(state,'set_use_audience',{kind:'users',userIds:[]}));state=empty.provisioning;
    current=await resources.inspectCapabilityResource(fixture.owner,ref);assert(current.grants?.every(grant=>!grant.canUse));
    assert(current.grants?.find(grant=>grant.targetId==='alice')?.canEdit);assert(current.grants?.find(grant=>grant.targetId==='manager')?.canManage);
    const organization=await success<{provisioning:CapabilityPackageProvisioning}>(await post(state,'set_use_audience',{kind:'organization'}));state=organization.provisioning;
    assert.deepEqual(state.audience,{kind:'organization'});assert.equal((await resources.inspectCapabilityResource(fixture.actor('bob'),ref)).access.canUse,true);
    assert.equal((await resources.inspectCapabilityResource(fixture.actor('bob'),ref)).access.canEdit,false);
    assert.equal(state.policy.canUse,true);assert.equal(state.policy.enabled,false,'Optional organization policy still requires explicit personal activation.');
    const personalBefore=state;
    let lostPersonalReply=false;
    fixture.setAfterQuery(async sql=>{
      if(sql==='COMMIT'&&!lostPersonalReply&&(await readCapabilityPreferences('owner')).preferences[state.personalActivation.resourceId]?.enabled===true){
        lostPersonalReply=true;fixture.setAfterQuery(undefined);throw new Error('Lost acknowledgement after actual personal preference bytes were committed.');
      }
    });
    try{await denied(await post(state,'enable_for_me'),503);}finally{fixture.setAfterQuery(undefined);}
    assert(lostPersonalReply);state=await get();assert.equal(state.personalActivation.enabled,true);assert.equal(state.personalActivation.revision,1);assert.equal(state.policy.enabled,true);
    const personalReplay=await success<{provisioning:CapabilityPackageProvisioning;changed:boolean;completedStep:string}>(await post(state,'enable_for_me'));
    assert.equal(personalReplay.changed,false);assert.equal(personalReplay.completedStep,'personal_activation');assert.equal(personalReplay.provisioning.personalActivation.revision,1);
    await denied(await post(personalBefore,'enable_for_me'),409);
    assert.equal((await readCapabilityPreferences('alice')).preferences[state.personalActivation.resourceId],undefined,'Only the explicitly acting user is enabled.');
    const policyStore=new CapabilityPolicyStore(fixture.sql);
    const blocked=await policyStore.upsertPolicy({organizationId:fixture.organizationId,resourceType:'plugin',resourceId:state.personalActivation.resourceId,
      targetType:'user',targetId:'owner',effect:'blocked',actorUserId:'owner',expectedRevision:0});
    state=await get();assert.equal(state.policy.effectivePolicy,'blocked');await denied(await post(state,'enable_for_me'),403);
    await policyStore.deletePolicy({id:blocked.id,organizationId:fixture.organizationId,expectedRevision:blocked.revision});
    state=await get();assert.equal(await versionCount(),1,'Personal activation never republishes or edits the package.');
    state=(await success<{provisioning:CapabilityPackageProvisioning}>(await post(state,'set_use_audience',{kind:'users',userIds:['alice','bob']}))).provisioning;
    await denied(await post(state,'enable_for_me'),403);assert.equal(state.personalActivation.enabled,true);assert.equal(state.policy.enabled,false,'An existing preference never overrides revoked Use.');
    await denied(await post({...state,expected:{...state.expected,expectedGrantsRevision:state.expected.expectedGrantsRevision-1}},'activate'),409);
    await fixture.sql.run('INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES($1,$1,$2,\'user\',1,0,1,1)',
      ['foreign-organization-user','foreign@provisioning.example.test']);
    await fixture.sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES('foreign-org','foreign-organization-user','team',1,2,2)");
    await fixture.sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,created_at,updated_at) VALUES('foreign-org','foreign-organization-user','member','active',1,1)");
    await denied(await post(state,'set_use_audience',{kind:'users',userIds:['foreign-organization-user']}),400);
    await denied(await route.POST(request('owner',ref,'',{operation:'activate',pin,...state.expected,actorUserId:'alice'}),context(ref)),400);

    const profiles=await import('../app/lib/agents/registry');await profiles.getAgentProfile(DEFAULT_MANAGED_AGENT_ID);
    const session='provisioning-owner-session';
    await fixture.sql.run(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,created_at,updated_at)
      VALUES($1,'owner',$2,'fixture','fixture',$3,'personal-owner','personal',1,1)`,[session,DEFAULT_MANAGED_AGENT_ID,fixture.organizationId]);
    const execution=await import('../app/lib/pi/agent-execution-context');
    const ownerContext=await (await import('../app/lib/pi/session-workspace-context')).resolveAgentExecutionContextForStoredSession({userId:'owner',agentId:DEFAULT_MANAGED_AGENT_ID,sessionId:session});
    const scoped=await import('../app/lib/pi/scoped-tools'),progressive=await import('../app/lib/pi/progressive-tool-gateway');
    const {createExtensionDiscoveryTool}=await import('../app/lib/pi/extension-discovery-tool');
    const definition=progressive.PROGRESSIVE_GATEWAY_DEFINITIONS.find(gateway=>gateway.name==='canvas_extensions');assert(definition);
    const gateway=progressive.createProgressiveGatewayTool(definition,[...scoped.createUserScopedTools('owner',DEFAULT_MANAGED_AGENT_ID,session),createExtensionDiscoveryTool('owner',DEFAULT_MANAGED_AGENT_ID,session)]);
    const details=(value:unknown)=>(value as {details:Record<string,unknown>}).details;
    const invoke=(tool:typeof gateway,operation:string,args:Record<string,unknown>,action:'call'|'describe'='call')=>execution.runWithAgentExecutionContext(ownerContext,()=>tool.execute(randomUUID(),{action,operation,...(action==='call'?{arguments:args}:{})}));
    for(const operation of ['inspect_canvas_package_provisioning','provision_canvas_package']){
      const described=details(await invoke(gateway,operation,{},'describe'));assert.equal(described.error,undefined);assert(described.schema);
    }
    const exactInspect={resourceRef:ref,publishedRevisionRef:pin.publishedRevisionRef,checksum:pin.checksum};
    const inspected=details(await invoke(gateway,'inspect_canvas_package_provisioning',exactInspect));assert.equal(inspected.error,undefined,JSON.stringify(inspected));
    const result=(inspected.capabilityPackage as {result:CapabilityPackageProvisioning}).result;assert.deepEqual(result.pin,pin);
    state=(await success<{provisioning:CapabilityPackageProvisioning}>(await post(state,'set_use_audience',{kind:'users',userIds:['alice','bob','owner']}))).provisioning;
    const personalGateway=details(await invoke(gateway,'provision_canvas_package',{resourceRef:ref,operation:'enable_for_me',pin,...state.expected,expectedPersonalActivationRevision:state.personalActivation.revision}));
    assert.equal(personalGateway.error,undefined,JSON.stringify(personalGateway));assert.equal((personalGateway.capabilityPackage as {result:{changed:boolean}}).result.changed,false);
    state=(await success<{provisioning:CapabilityPackageProvisioning}>(await post(state,'set_use_audience',{kind:'users',userIds:['alice','bob']}))).provisioning;
    const gatewayMutation={resourceRef:ref,operation:'set_use_audience',pin,...state.expected,audience:{kind:'users',userIds:['alice','bob']}};
    const gatewayResult=details(await invoke(gateway,'provision_canvas_package',gatewayMutation));assert.equal(gatewayResult.error,undefined,JSON.stringify(gatewayResult));
    assert.equal((gatewayResult.capabilityPackage as {result:{changed:boolean}}).result.changed,false);
    for(const forged of [{...gatewayMutation,actorUserId:'owner'},{...gatewayMutation,rootPath:fixture.root},{resourceRef:ref,operation:'activate',pin,...state.expected,audience:{kind:'organization'}}]){
      assert(details(await invoke(gateway,'provision_canvas_package',forged)).error,'Strict gateway arguments reject forged identity/root/union fields.');
    }
    const planning=(await import('../app/lib/pi/planning-mode')).filterToolsForPlanningMode([gateway]);assert.equal(planning.length,1);
    const planningGateway=planning[0] as typeof gateway;
    assert.equal(details(await invoke(planningGateway,'inspect_canvas_package_provisioning',exactInspect)).error,undefined);
    assert(details(await invoke(planningGateway,'provision_canvas_package',gatewayMutation)).error);
    if(fixture.native){
      const race=await Promise.all([post(state,'set_use_audience',{kind:'users',userIds:['alice']}),post(state,'set_use_audience',{kind:'users',userIds:['bob']})]);
      assert.deepEqual(race.map(response=>response.status).sort(),[200,409],'Independent PostgreSQL leases commit exactly one explicit audience under the inspected CAS.');
      state=await get();assert.equal(await versionCount(),1);
      state=(await success<{provisioning:CapabilityPackageProvisioning}>(await post(state,'set_use_audience',{kind:'organization'}))).provisioning;
      await setCapabilityPreference({userId:'owner',resourceId:state.personalActivation.resourceId,enabled:false,expectedRevision:state.personalActivation.revision});state=await get();
      const personalRace=await Promise.all([post(state,'enable_for_me'),post(state,'enable_for_me')]);
      assert.deepEqual(personalRace.map(response=>response.status).sort(),[200,409],'The same personal preference CAS has exactly one winner across independent PostgreSQL leases.');
      state=await get();assert.equal(state.personalActivation.enabled,true);assert.equal(state.policy.enabled,true);
    }
    const before=await packages.inspectCapabilityPackage(fixture.owner,ref);
    let edit=await packages.createCapabilityPackageDraftAction(fixture.owner,{operation:'edit',resourceRef:ref,expectedMetadataRevision:before.resource.metadataRevision,
      expectedGrantsRevision:before.resource.grantsRevision,expectedPackageRevision:before.state!.packageRevision,expectedPublishedRevisionRef:before.state!.currentPublishedRevisionRef});
    edit=await write(edit,'.canvas-plugin/plugin.json',JSON.stringify({...structuredClone(creatorPluginManifestTemplate),name:draft.name,version:'2.0.0'}));
    const v2=await packages.publishCapabilityPackageDraftAction(fixture.owner,{draftRef:edit.draftRef,expectedDraftRevision:edit.draftRevision,
      expectedMetadataRevision:before.resource.metadataRevision,expectedGrantsRevision:before.resource.grantsRevision,
      expectedPackageRevision:before.state!.packageRevision,expectedPublishedRevisionRef:before.state!.currentPublishedRevisionRef});
    assert.notEqual(v2.published.revisionRef,pin.publishedRevisionRef);const old=await get();assert.deepEqual(old.pin,pin);assert.equal(old.version,'1.0.0');assert.equal(old.currentHead.matchesPin,false);
    await denied(await post(old,'activate'),409);await denied(await post(old,'set_use_audience',{kind:'organization'}),409);
    await denied(await post(old,'enable_for_me'),409);
    assert.equal(await versionCount(),2,'Provisioning an old pin never publishes or switches to the newer head.');
    assert.equal(fixture.providerRequests(),0);
    console.info(`PASS ${fixture.native?'native PostgreSQL':'PGlite'} provisioning: exact org publication and consumed-draft replay, explicit users/all-org/empty Use-only scope, preserved Edit/Manage, activation without Use, actual lost grant/activation replies and targeted recovery, exact old head409, real canvas_extensions describe/call/strict planning and forged argument denial; no provider actions or republish.`);
  }finally{await fixture.close();}
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
