import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft } from '../app/lib/capabilities/packages/contracts';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';
import { verifyCapabilityPackageCreation } from './helpers/capability-package-creation-cases';
import { verifyCapabilityPackageComposition } from './helpers/capability-package-composition-cases';
import { verifyCapabilityPackageCompositionConcurrency } from './helpers/capability-package-composition-concurrency';
import { verifyCapabilityPackageCreatorValidation } from './helpers/capability-package-creator-validation-cases';
import { verifyCapabilityPackageDraftPresentation } from './helpers/capability-package-draft-presentation-cases';

async function main() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-package-actions-'));
  const envKeys=['DATA','CANVAS_DATA_ROOT','INTEGRATIONS_ENV_MASTER_KEY','QMD_ENABLED','CANVAS_MCP_DIRECT_ENABLED'] as const;
  const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{DATA:root,CANVAS_DATA_ROOT:root,INTEGRATIONS_ENV_MASTER_KEY:randomBytes(32).toString('base64url'),QMD_ENABLED:'false',CANVAS_MCP_DIRECT_ENABLED:'false'});
  process.env.BASE_URL ??='http://localhost:3001';
  const database=await createSharedConnectionTestDatabase(),raw=await database.openDb();
  const loader=Module as typeof Module & {_load:(name:string,parent:NodeModule|null,main:boolean)=>unknown};
  const original=loader._load;
  let revokeAfterPreparedDraft:(()=>Promise<void>)|undefined;
  loader._load=(name,parent,isMain)=>{
    if(name==='server-only') return {};
    if(name==='@/app/lib/db'||/\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if(name==='@/app/lib/auth'||/\/app\/lib\/auth(?:\.ts)?$/u.test(name)) return {auth:{api:{getSession:async({headers}:{headers:Headers})=>{
      const userId=headers.get('x-fixture-user');return userId?{user:{id:userId},session:{id:`session-${userId}`}}:null;
    }}}};
    if(name==='@earendil-works/pi-ai'||name==='@earendil-works/pi-ai/compat') return {getModels:()=>[],getProviders:()=>[],registerBuiltInApiProviders:()=>undefined,isContextOverflow:()=>false};
    if(name==='@/app/lib/pi/live-runtime'||name.endsWith('/pi/live-runtime.ts')) return {requestPiRuntimePromptRefreshForUser:async()=>{}};
    if(name==='./store'&&parent?.filename.endsWith('/capabilities/packages/actions.ts')){
      const actual=original(name,parent,isMain) as typeof import('../app/lib/capabilities/packages/store');
      return {...actual,getCapabilityPackageDraftRecord:async(...args:Parameters<typeof actual.getCapabilityPackageDraftRecord>)=>{
        const record=await actual.getCapabilityPackageDraftRecord(...args);const revoke=revokeAfterPreparedDraft;revokeAfterPreparedDraft=undefined;if(revoke)await revoke();return record;
      }};
    }
    return original(name,parent,isMain);
  };
  try {
    for(const id of ['owner','editor','runner','manager','unassigned']) await raw.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)',[id,`${id}@package-actions.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org-packages','owner','team',1,1000,1000)");
    for(const id of ['owner','editor','runner','manager','unassigned']) {
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-packages',$1,$2,'active',$3,1000,1000)",[id,id==='owner'?'owner':'member',Number(id==='owner')]);
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'org-packages','personal',$2,$1,$2,'active',1000,1000)",[`personal-${id}`,id]);
    }
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team-packages','org-packages','team','team-packages','Package team','active',1000,1000)");
    await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ('org-packages','team-packages','manager','member','active',1,1,1000,1000)");
    const registry=await import('../app/lib/plugins/canvas-plugin-registry');
    const resources=await import('../app/lib/capabilities/resources/actions');
    const packages=await import('../app/lib/capabilities/packages/actions');
    const packageStore=await import('../app/lib/capabilities/packages/store');
    const collection=await import('../app/api/capabilities/packages/drafts/route');
    const inspectRoute=await import('../app/api/capabilities/packages/[resourceRef]/route');
    const draftRoute=await import('../app/api/capabilities/packages/drafts/[draftRef]/route');
    const statusRoute=await import('../app/api/capabilities/packages/drafts/[draftRef]/status/route');
    const fileRoute=await import('../app/api/capabilities/packages/drafts/[draftRef]/file/route');
    const publishRoute=await import('../app/api/capabilities/packages/drafts/[draftRef]/publish/route');
    const owner={userId:'owner',workspaceId:'personal-owner'},editor={userId:'editor',workspaceId:'personal-editor'},manager={userId:'manager',workspaceId:'team-packages'};
    const scope={scopeType:'organization' as const,organizationId:'org-packages'};
    if(process.argv.includes('--composition-concurrency')) {
      assert(database.native,'The focused concurrency entry requires the isolated native PostgreSQL fixture.');
      await verifyCapabilityPackageCompositionConcurrency({packages,raw,owner,pool:database.getPostgresRuntimeQueryable()});
      return;
    }
    const makePlugin=async(name:string)=>{
      const childName=name==='package-actions'?'package-context':`${name}-context`;
      const directory=path.join(root,'fixtures',name);
      await fs.mkdir(path.join(directory,'.canvas-plugin'),{recursive:true});await fs.mkdir(path.join(directory,'skills',childName,'scripts'),{recursive:true});await fs.mkdir(path.join(directory,'assets'));
      await fs.writeFile(path.join(directory,'.canvas-plugin','plugin.json'),JSON.stringify({name,version:'1.0.0',description:'Actual package editing fixture',skills:'skills'}));
      await fs.writeFile(path.join(directory,'skills',childName,'SKILL.md'),`---\nname: ${childName}\ndescription: Use the package code and assets\nmetadata:\n  version: "1.0.0"\n---\nFull package context.\n`);
      await fs.writeFile(path.join(directory,'skills',childName,'scripts','main.js'),'process.stdout.write("version-one");\n');
      await fs.writeFile(path.join(directory,'assets','icon.bin'),Buffer.from([0,255,128,13]));
      return directory;
    };
    const installed=await registry.installCanvasPluginFromPath(await makePlugin('package-actions'),{scope,enable:true});
    assert(installed.success&&installed.plugin?.resourceId,JSON.stringify(installed.validation?.errors));
    const legacy=installed.plugin.resourceId;
    const configured=await resources.configureCapabilityResource(owner,legacy,{expectedMetadataRevision:0,expectedGrantsRevision:0,ownership:{type:'team',workspaceId:'team-packages'},accessMode:'restricted',grants:[
      {targetType:'user',targetId:'editor',canUse:false,canEdit:true,canManage:false},{targetType:'user',targetId:'runner',canUse:true,canEdit:false,canManage:false},
    ]});
    const ref=configured.metadata.resourceRef;
    const request=(userId:string|null,method='GET',body?:unknown,url='http://localhost/api/capabilities/packages')=>new Request(url,{method,
      headers:{...(userId?{'x-fixture-user':userId}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const context=(params:Record<string,string>={})=>({params:Promise.resolve(params)});
    const responseData=async<T>(response:Response,status=200):Promise<T>=>{assert.equal(response.status,status,await response.clone().text());return (await response.json() as {data:T}).data;};
    if(process.argv.includes('--creator-validation')) {
      await verifyCapabilityPackageCreatorValidation({packages,raw,owner,other:editor,request,legacyRef:ref});
      return;
    }
    if(process.argv.includes('--draft-presentation')) {
      await verifyCapabilityPackageDraftPresentation({packages,raw,owner,other:editor,request});
      return;
    }
    if(process.argv.includes('--composition-cases')) {
      await verifyCapabilityPackageComposition({packages,raw,owner,other:editor,request,root});
      return;
    }
    await verifyCapabilityPackageCreation({packages,raw,owner,other:editor,request,native:database.native});
    await verifyCapabilityPackageComposition({packages,raw,owner,other:editor,request,root});
    await verifyCapabilityPackageCreatorValidation({packages,raw,owner,other:editor,request,legacyRef:ref});
    await verifyCapabilityPackageDraftPresentation({packages,raw,owner,other:editor,request});
    if(database.native) await verifyCapabilityPackageCompositionConcurrency({packages,raw,owner,pool:database.getPostgresRuntimeQueryable()});
    assert.equal((await inspectRoute.GET(request(null),context({resourceRef:ref}))).status,401);
    const inspected=await responseData<{package:CapabilityPackageDescriptor}>(await inspectRoute.GET(request('editor'),context({resourceRef:ref})));
    assert.equal(inspected.package.access.canEdit,true);assert.equal(inspected.package.access.canUse,false);assert.equal(inspected.package.access.canManage,false);
    const editInput=(descriptor:CapabilityPackageDescriptor)=>({operation:'edit' as const,resourceRef:descriptor.resource.resourceRef,expectedMetadataRevision:descriptor.resource.metadataRevision,
      expectedGrantsRevision:descriptor.resource.grantsRevision,expectedPackageRevision:descriptor.state?.packageRevision??0,expectedPublishedRevisionRef:descriptor.state?.currentPublishedRevisionRef??null});
    for(const rawFields of [{actorUserId:'owner'},{storage:{scopeType:'user'}},{ownership:{type:'user'}},{rootPath:'/tmp/forged'}]) assert.equal((await collection.POST(request('editor','POST',{...editInput(inspected.package),...rawFields}),context())).status,400);
    const created=await responseData<{draft:CapabilityPackageDraft}>(await collection.POST(request('editor','POST',editInput(inspected.package)),context()));
    let draft=created.draft;
    const files=await packages.listCapabilityPackageDraftFilesAction(editor,draft.draftRef);
    assert(files.files.some(file=>file.path==='.canvas-plugin/plugin.json'),'Editor tree includes the complete package manifest.');
    assert(files.files.some(file=>file.path==='skills/package-context/scripts/main.js'));assert(files.files.some(file=>file.path==='assets/icon.bin'));
    assert.equal((await draftRoute.GET(request('runner'),context({draftRef:draft.draftRef}))).status,404,'Reader cannot inspect another actor private draft.');
    assert.equal((await fileRoute.GET(request('editor','GET',undefined,'http://localhost/api/capabilities/packages?path=assets%2Ficon.bin'),context({draftRef:draft.draftRef}))).status,200);
    const write=async(actor:typeof editor,current:CapabilityPackageDraft,file:string,content:Buffer)=>{
      const result=await packages.writeCapabilityPackageDraftFileAction(actor,current.draftRef,{expectedDraftRevision:current.draftRevision,path:file,encoding:'base64',content:content.toString('base64')});return result.draft;
    };
    const oldDraft=draft;draft=await write(editor,draft,'skills/package-context/scripts/main.js',Buffer.from('process.stdout.write("version-two");\n'));
    assert.equal((await fileRoute.PUT(request('editor','PUT',{expectedDraftRevision:oldDraft.draftRevision,path:'assets/icon.bin',encoding:'base64',content:'AAAA'}),context({draftRef:draft.draftRef}))).status,409);
    assert.equal((await fileRoute.PUT(request('editor','PUT',{expectedDraftRevision:draft.draftRevision,path:'../escape',encoding:'base64',content:'AAAA'}),context({draftRef:draft.draftRef}))).status,400);
    assert.equal((await fileRoute.PUT(new Request('http://localhost/api/capabilities/packages',{method:'PUT',headers:{'x-fixture-user':'editor','Content-Type':'application/json'},body:'{broken'}),context({draftRef:draft.draftRef}))).status,400);
    const validate=await packages.validateCapabilityPackageDraftAction(editor,draft.draftRef);assert(validate.validation.valid,validate.validation.errors.join(' '));
    const publishInput=(current:CapabilityPackageDraft,descriptor:CapabilityPackageDescriptor)=>({draftRef:current.draftRef,expectedDraftRevision:current.draftRevision,
      expectedMetadataRevision:descriptor.resource.metadataRevision,expectedGrantsRevision:descriptor.resource.grantsRevision,expectedPackageRevision:descriptor.state?.packageRevision??0,expectedPublishedRevisionRef:descriptor.state?.currentPublishedRevisionRef??null});
    assert.equal((await publishRoute.POST(request('editor','POST',{...publishInput(draft,inspected.package),expectedMetadataRevision:0}),context({draftRef:draft.draftRef}))).status,409);
    assert.equal((await publishRoute.POST(request('editor','POST',{...publishInput(draft,inspected.package),expectedGrantsRevision:0}),context({draftRef:draft.draftRef}))).status,409);
    assert.equal((await packages.readCapabilityPackageDraftAction(editor,draft.draftRef)).draft.draftRevision,draft.draftRevision);
    const first=await packages.publishCapabilityPackageDraftAction(editor,publishInput(draft,inspected.package));
    assert.equal(first.state.packageRevision,1);assert.equal(first.published.publishedByUserId,'editor');
    assert.equal((await resources.inspectCapabilityResource(editor,ref)).access.canUse,false,'Publication must preserve independent grant flags.');
    const oldRead=await packages.readCapabilityPackageFileAction(editor,ref,{revisionRef:first.published.revisionRef,path:'skills/package-context/scripts/main.js'});
    assert.match(Buffer.from(oldRead.file.content,'base64').toString(),/version-two/u);
    const current=await packages.inspectCapabilityPackage(editor,ref);const secondDraft=await packages.createCapabilityPackageDraftAction(editor,editInput(current));
    const stalePublish=await packages.createCapabilityPackageDraftAction(editor,editInput(current));
    const secondWritten=await write(editor,secondDraft,'skills/package-context/scripts/main.js',Buffer.from('process.stdout.write("version-three");\n'));
    const second=await packages.publishCapabilityPackageDraftAction(editor,publishInput(secondWritten,current));assert.equal(second.state.packageRevision,2);
    await assert.rejects(()=>packages.publishCapabilityPackageDraftAction(editor,publishInput(stalePublish,current)),{code:'PACKAGE_SOURCE_CHANGED'});
    assert.equal((await packages.readCapabilityPackageDraftAction(editor,stalePublish.draftRef)).draft.draftRevision,stalePublish.draftRevision,'Stale publish preserves editable draft.');
    const pinned=await packages.readCapabilityPackageFileAction(editor,ref,{revisionRef:first.published.revisionRef,path:'skills/package-context/scripts/main.js'});
    assert.match(Buffer.from(pinned.file.content,'base64').toString(),/version-two/u,'Published v1 bytes remain available after v2.');
    const latest=await packages.readCapabilityPackageFileAction(editor,ref,{path:'skills/package-context/scripts/main.js'});assert.match(Buffer.from(latest.file.content,'base64').toString(),/version-three/u);
    const beforeFork=await packages.inspectCapabilityPackage(owner,ref);
    const forkInput=(name:string,ownership:{type:'organization'|'user'}|{type:'team';workspaceId:string},descriptor=beforeFork)=>({operation:'fork' as const,resourceRef:ref,targetName:name,ownership,
      expectedSourceMetadataRevision:descriptor.resource.metadataRevision,expectedSourceGrantsRevision:descriptor.resource.grantsRevision,expectedSourcePackageRevision:descriptor.state?.packageRevision??0,expectedSourcePublishedRevisionRef:descriptor.state?.currentPublishedRevisionRef??null});
    const fork=await packages.createCapabilityPackageDraftAction(owner,forkInput('package-org-copy',{type:'organization'}));
    assert.equal(await packageStore.getCapabilityPackageState(fork.resourceRef),null);
    const resourceStore=await import('../app/lib/capabilities/resources/store');assert.equal(await resourceStore.findCapabilityResourceRecord(fork.resourceRef),null);
    const manifest=JSON.parse(Buffer.from((await packages.readCapabilityPackageDraftFileAction(owner,fork.draftRef,{path:'.canvas-plugin/plugin.json'})).file.content,'base64').toString()) as Record<string,unknown>;
    const renamed=await write(owner,fork,'.canvas-plugin/plugin.json',Buffer.from(JSON.stringify({...manifest,name:'package-org-copy'})));
    const forkResult=await packages.publishCapabilityPackageDraftAction(owner,{draftRef:renamed.draftRef,expectedDraftRevision:renamed.draftRevision,expectedMetadataRevision:0,expectedGrantsRevision:0,expectedPackageRevision:0,expectedPublishedRevisionRef:null});
    const copy=await resources.inspectCapabilityResource(owner,forkResult.state.resourceRef);
    assert.equal(copy.metadata.ownership.type,'organization');assert.equal(copy.metadata.accessMode,'restricted');assert.deepEqual(copy.grants,[]);assert.equal(copy.access.canUse,false);
    const binary=await packages.readCapabilityPackageFileAction(owner,forkResult.state.resourceRef,{path:'assets/icon.bin'});assert.deepEqual(Buffer.from(binary.file.content,'base64'),Buffer.from([0,255,128,13]));
    assert.match(Buffer.from((await packages.readCapabilityPackageFileAction(owner,forkResult.state.resourceRef,{path:'skills/package-context/scripts/main.js'})).file.content,'base64').toString(),/version-three/u);
    assert.equal((await resources.inspectCapabilityResource(editor,ref)).access.canEdit,true,'Forking never changes the original grant set.');
    const collision=await registry.installCanvasPluginFromPath(await makePlugin('package-existing'),{scope,enable:false});assert(collision.success&&collision.plugin);
    const collisionBefore=await fs.readFile(path.join(collision.plugin.installDir,'.canvas-plugin','plugin.json'),'utf8');
    const collisionDraft=await packages.createCapabilityPackageDraftAction(owner,forkInput('package-existing',{type:'organization'}));
    const collisionManifest={...manifest,name:'package-existing'};const collisionRenamed=await write(owner,collisionDraft,'.canvas-plugin/plugin.json',Buffer.from(JSON.stringify(collisionManifest)));
    await assert.rejects(()=>packages.publishCapabilityPackageDraftAction(owner,{draftRef:collisionRenamed.draftRef,expectedDraftRevision:collisionRenamed.draftRevision,expectedMetadataRevision:0,expectedGrantsRevision:0,expectedPackageRevision:0,expectedPublishedRevisionRef:null}),{code:'PACKAGE_REVISION_CONFLICT'});
    assert.equal(await fs.readFile(path.join(collision.plugin.installDir,'.canvas-plugin','plugin.json'),'utf8'),collisionBefore,'A new fork cannot overwrite an unadopted legacy package.');
    const childRef=(await resources.listCapabilityResources(owner)).find(value=>value.artifact.resourceType==='skill'&&value.artifact.sourcePluginId===legacy)!.metadata.resourceRef;
    const child=await packages.inspectCapabilityPackage(owner,childRef);assert.equal(child.readOnly,true);assert(child.sourceStamp.parentRevisionRef);
    await assert.rejects(()=>packages.createCapabilityPackageDraftAction(owner,editInput(child)),{code:'PACKAGE_READ_ONLY'});
    const childFork=await packages.createCapabilityPackageDraftAction(manager,{...forkInput('package-team-skill',{type:'team',workspaceId:'team-packages'},child),resourceRef:childRef});
    const childText=Buffer.from((await packages.readCapabilityPackageDraftFileAction(manager,childFork.draftRef,{path:'SKILL.md'})).file.content,'base64').toString();
    const childRenamed=await write(manager,childFork,'SKILL.md',Buffer.from(childText.replace('name: package-context','name: package-team-skill')));
    const team=await packages.publishCapabilityPackageDraftAction(manager,{draftRef:childRenamed.draftRef,expectedDraftRevision:childRenamed.draftRevision,expectedMetadataRevision:0,expectedGrantsRevision:0,expectedPackageRevision:0,expectedPublishedRevisionRef:null});
    const teamResource=await resources.inspectCapabilityResource(manager,team.state.resourceRef);assert.equal(teamResource.metadata.ownership.type,'team');assert.equal(teamResource.access.canUse,false);assert.deepEqual(teamResource.grants,[]);
    const {createCapabilityResourceId}=await import('../app/lib/capabilities/reference');
    const coreRef=createCapabilityResourceId({resourceType:'skill',scopeType:'system',sourceType:'core',name:'create-plugin'});
    const core=await packages.inspectCapabilityPackage(owner,coreRef);assert(core.readOnly);assert.equal(core.resource.metadataRevision,0);
    await assert.rejects(()=>packages.createCapabilityPackageDraftAction(owner,editInput(core)),{code:'PACKAGE_READ_ONLY'});
    const coreCopy=await packages.createCapabilityPackageDraftAction(owner,{...forkInput('package-core-variant',{type:'user'},core),resourceRef:coreRef});
    assert((await packages.listCapabilityPackageDraftFilesAction(owner,coreCopy.draftRef)).files.some(file=>file.path==='SKILL.md'));
    assert.equal(await resourceStore.findCapabilityResourceRecord(coreRef),null,'Reading/forking built-in packages does not adopt a system row.');
    const personalScope={scopeType:'user' as const,userId:'owner'};
    const legacyPersonal=await registry.installCanvasPluginFromPath(await makePlugin('package-legacy-personal'),{scope:personalScope,enable:false});
    assert(legacyPersonal.success&&legacyPersonal.plugin?.resourceId);
    const personalRef=legacyPersonal.plugin.resourceId;
    await fs.appendFile(path.join(legacyPersonal.plugin.installDir,'skills','package-legacy-personal-context','SKILL.md'),'\nLegacy direct content edit.\n');
    const personalInspection=await packages.inspectCapabilityPackage(owner,personalRef);
    assert.notEqual(personalInspection.sourceStamp.registryChecksum,personalInspection.sourceStamp.checksum,'Registry digest is distinct from actual complete bytes after a legacy direct edit.');
    assert.equal(await resourceStore.findCapabilityResourceRecord(personalRef),null);
    const historyBefore=(await raw.get('SELECT COUNT(*)::integer AS count FROM capability_resource_history') as {count:number}).count;
    for(const badHead of [{expectedPackageRevision:9,expectedPublishedRevisionRef:null},{expectedPackageRevision:0,expectedPublishedRevisionRef:'canvas-package-revision:00000000-0000-0000-0000-000000000000'}]){
      await assert.rejects(()=>packages.createCapabilityPackageDraftAction(owner,{...editInput(personalInspection),...badHead}),{code:'PACKAGE_REVISION_CONFLICT'});
      assert.equal(await resourceStore.findCapabilityResourceRecord(personalRef),null,'A stale legacy head must fail before implicit adoption.');
      assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_resource_history') as {count:number}).count,historyBefore,'Rejected legacy head must not create adoption history.');
      assert.equal((await packages.inspectCapabilityPackage(owner,personalRef)).resource.metadataRevision,0);
    }
    const personalDraft=await packages.createCapabilityPackageDraftAction(owner,editInput(personalInspection));
    const personalHead=await packages.inspectCapabilityPackage(owner,personalRef);
    const personalResult=await packages.publishCapabilityPackageDraftAction(owner,publishInput(personalDraft,personalHead));
    const personalBytes=await packages.readCapabilityPackageFileAction(owner,personalResult.state.resourceRef,{path:'skills/package-legacy-personal-context/SKILL.md'});
    assert.match(Buffer.from(personalBytes.file.content,'base64').toString(),/Legacy direct content edit/u,'Publication retains actual source bytes even if old registry checksum was stale.');
    const revokedInput=await packages.inspectCapabilityPackage(editor,ref);const revokedDraft=await packages.createCapabilityPackageDraftAction(editor,editInput(revokedInput));
    const prepared=await packageStore.getCapabilityPackageDraftRecord(editor,revokedDraft.draftRef);
    const draftPath=(await import('../app/lib/capabilities/packages/io')).resolveCapabilityPackageDraftLocation({...revokedDraft,owner:prepared.targetOwnership}).rootPath;
    const oldBytes=await fs.readFile(path.join(draftPath,'assets/icon.bin'));
    let lateRevokeCount=0;revokeAfterPreparedDraft=async()=>{lateRevokeCount++;await resources.updateCapabilityResource(owner,ref,{expectedMetadataRevision:revokedInput.resource.metadataRevision,expectedGrantsRevision:revokedInput.resource.grantsRevision,grants:[{targetType:'user',targetId:'runner',canUse:true,canEdit:false,canManage:false}]});};
    assert.equal((await fileRoute.PUT(request('editor','PUT',{expectedDraftRevision:revokedDraft.draftRevision,path:'assets/icon.bin',encoding:'base64',content:'AAAA'}),context({draftRef:revokedDraft.draftRef}))).status,403);
    assert.equal(lateRevokeCount,1,'Actual grants were revoked after the preliminary draft receipt and before the held write authorization.');
    assert.deepEqual(await fs.readFile(path.join(draftPath,'assets/icon.bin')),oldBytes,'Late revocation must leave the current private draft bytes unchanged.');
    assert.equal((await raw.get('SELECT draft_revision FROM capability_package_drafts WHERE draft_ref=$1',[revokedDraft.draftRef]) as {draft_revision:number}).draft_revision,revokedDraft.draftRevision);
    const status=await responseData<{status:{draftRef:string;draftRevision:number}}>(await statusRoute.GET(request('editor'),context({draftRef:revokedDraft.draftRef})));
    assert.equal(status.status.draftRevision,revokedDraft.draftRevision);assert(!JSON.stringify(status).includes('sourceStamp')&&!JSON.stringify(status).includes('rootPath'));
    assert.equal((await statusRoute.GET(request('owner'),context({draftRef:revokedDraft.draftRef}))).status,404,'Management must not expose another creator recovery status.');
    assert.equal((await fileRoute.GET(request('editor','GET',undefined,'http://localhost/api/capabilities/packages?path=assets%2Ficon.bin'),context({draftRef:revokedDraft.draftRef}))).status,403,'Recovery metadata does not restore file reading.');
    assert.equal((await publishRoute.POST(request('editor','POST',publishInput(revokedDraft,revokedInput)),context({draftRef:revokedDraft.draftRef}))).status,403);
    assert.equal((await draftRoute.DELETE(request('editor','DELETE',{expectedDraftRevision:revokedDraft.draftRevision}),context({draftRef:revokedDraft.draftRef}))).status,200,'A revoked editor can discard their own private draft.');
    console.log('PASS actual PG package actions + authenticated HTTP: shared editing/publishing, complete code/assets, CAS, immutable history, deferred restricted org/team forks, legacy collision, core/child readonly, authority injection and revoked rights.');
  } finally {loader._load=original;await raw.close();await database.close();for(const key of envKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    const unlock=async(directory:string):Promise<void>=>{const stat=await fs.lstat(directory);if(stat.isDirectory()&&!stat.isSymbolicLink()){await fs.chmod(directory,0o700);for(const name of await fs.readdir(directory))await unlock(path.join(directory,name));}};
    await unlock(root);await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
