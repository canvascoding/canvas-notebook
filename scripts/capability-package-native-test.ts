import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {AuthorizedCapabilityPackageSource,CapabilityPackageDraft,CapabilityPackagePublishRequest,CapabilityPackageState} from '../app/lib/capabilities/packages/contracts';
import type {CapabilityResourceStorageBinding} from '../app/lib/capabilities/resources/contracts';
import {createSharedConnectionTestDatabase} from './helpers/shared-connection-test-database';

async function main(){
  assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST,'1','Native concurrency gate never silently falls back to PGlite.');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-package-native-'));await fs.chmod(root,0o700);
  const envKeys=['DATA','CANVAS_DATA_ROOT','CANVAS_ORGANIZATION_ID','CANVAS_APP_ROOT'] as const,previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{DATA:root,CANVAS_DATA_ROOT:root,CANVAS_ORGANIZATION_ID:'org-native-package',CANVAS_APP_ROOT:process.cwd()});
  const database=await createSharedConnectionTestDatabase();assert(database.native);const raw=await database.openDb();
  const loader=Module as typeof Module & {_load:(name:string,parent:NodeModule|null,main:boolean)=>unknown};const original=loader._load;
  loader._load=(name,parent,isMain)=>{if(name==='server-only')return{};if(name==='@/app/lib/db'||/\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name))return database;return original(name,parent,isMain);};
  let locker:Awaited<ReturnType<typeof database.openDb>>|undefined;
  try{
    for(const id of ['native-owner','native-editor'])await raw.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1,1)',[id,`${id}@fixture.example.test`]);
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org-native-package','native-owner','team',1,1,1)");
    for(const id of ['native-owner','native-editor'])await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org-native-package',$1,$2,'active',$3,1,1)",[id,id==='native-owner'?'owner':'member',Number(id==='native-owner')]);
    const resources=await import('../app/lib/capabilities/resources/store');const store=await import('../app/lib/capabilities/packages/store');const io=await import('../app/lib/capabilities/packages/io');
    const artifacts=await import('../app/lib/capabilities/packages/artifacts');const skills=await import('../app/lib/skills/canvas-skill-store');
    const paths=await import('../app/lib/runtime-data-paths');const scope={scopeType:'organization' as const,organizationId:'org-native-package'};
    const owner={userId:'native-owner'},editor={userId:'native-editor'};
    const binding=artifacts.capabilityPackageLegacyStorageBinding('skill','native-source',scope);
    const adopted=await resources.adoptCapabilityResource(owner,binding,{expectedMetadataRevision:0,expectedGrantsRevision:0,accessMode:'restricted',grants:[{targetType:'user',targetId:editor.userId,canUse:false,canEdit:true,canManage:false}]});
    const ref=adopted.metadata.resourceRef,ownership=adopted.metadata.ownership;
    let sourceRoot=path.join(paths.resolveScopedSkillsDataDir(scope),binding.name);await fs.mkdir(path.join(sourceRoot,'scripts'),{recursive:true});await fs.mkdir(path.join(sourceRoot,'assets'));
    await fs.writeFile(path.join(sourceRoot,'SKILL.md'),'---\nname: native-source\ndescription: Native package concurrency fixture\nmetadata:\n  version: "1.0.0"\n---\nRun scripts/main.js.\n');await fs.writeFile(path.join(sourceRoot,'scripts/main.js'),'process.stdout.write("initial");\n');await fs.writeFile(path.join(sourceRoot,'assets/icon.bin'),Buffer.from([0,255,128]));
    const initial=await io.readExactPackageInventory(sourceRoot);const registry=await skills.readCanvasSkillRegistry(scope);
    registry.skills[binding.name]={resourceId:binding.resourceId,scopeType:'organization',organizationId:scope.organizationId,ownerUserId:null,name:binding.name,version:'1.0.0',description:'Native package concurrency fixture',revision:1,sourceType:'local',sourcePath:sourceRoot,installedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),checksum:initial.checksum,installDir:sourceRoot,skillPath:path.join(sourceRoot,'SKILL.md')};
    await skills.writeCanvasSkillRegistry(registry,scope);
    let currentState:CapabilityPackageState|null=null;
    const source=async(actor=editor):Promise<AuthorizedCapabilityPackageSource>=>({authorization:await resources.authorizeCapabilityPackageResource(actor,binding,'read'),storage:binding,readOnly:false,
      location:{rootPath:sourceRoot,resourceRef:ref,kind:'skill',name:binding.name,owner:ownership},sourceStamp:currentState?.currentSourceStamp??{resourceId:binding.resourceId,kind:'skill',name:binding.name,version:'1.0.0',artifactRevision:1,registryChecksum:initial.checksum,checksum:initial.checksum,sourcePluginId:null}});
    const location=(draft:CapabilityPackageDraft)=>io.resolveCapabilityPackageDraftLocation({...draft,owner:ownership});
    const captured=await source();const draft=await store.beginCapabilityPackageDraft(editor,{operation:'edit',resourceRef:ref,expectedMetadataRevision:1,expectedGrantsRevision:1,expectedPackageRevision:0,expectedPublishedRevisionRef:null},{source:captured},async current=>{await io.createCapabilityPackageDraft(captured.location,location(current));});
    const racers=await Promise.allSettled(['writer-one','writer-two'].map(value=>store.mutateCapabilityPackageDraft(editor,draft.draftRef,1,async current=>io.writeCapabilityPackageDraftFile(location(current),{path:'scripts/main.js',encoding:'base64',content:Buffer.from(value).toString('base64')}))));
    assert.equal(racers.filter(result=>result.status==='fulfilled').length,1);const failed=racers.find(result=>result.status==='rejected');assert(failed?.status==='rejected');assert.equal(failed.reason.code,'PACKAGE_DRAFT_CONFLICT');
    const saved=await store.getCapabilityPackageDraft(editor,draft.draftRef);assert.equal(saved.draftRevision,2);const winner=await fs.readFile(path.join(location(saved).rootPath,'scripts/main.js'),'utf8');assert(['writer-one','writer-two'].includes(winner));assert.equal(await fs.readFile(path.join(location(draft).rootPath,'scripts/main.js'),'utf8'),'process.stdout.write("initial");\n');
    await assert.rejects(()=>store.mutateCapabilityPackageDraft(editor,draft.draftRef,2,async current=>{await io.writeCapabilityPackageDraftFile(location(current),{path:'scripts/main.js',encoding:'base64',content:Buffer.from('rollback-candidate').toString('base64')});throw new Error('fixture-private-write-rollback');}),/fixture-private-write-rollback/u);
    assert.equal((await store.getCapabilityPackageDraft(editor,draft.draftRef)).draftRevision,2);assert.equal(await fs.readFile(path.join(location(saved).rootPath,'scripts/main.js'),'utf8'),winner);
    const publishInput:CapabilityPackagePublishRequest={draftRef:saved.draftRef,expectedDraftRevision:2,expectedPackageRevision:0,expectedPublishedRevisionRef:null,expectedMetadataRevision:1,expectedGrantsRevision:1};let stageCalls=0;
    locker=await database.openDb();await locker.run('BEGIN');await locker.get('SELECT resource_ref FROM capability_resources WHERE resource_ref=$1 FOR UPDATE',[ref]);
    const queued=store.publishCapabilityPackageDraft(editor,publishInput,async()=>{stageCalls++;throw new Error('revoked-publication-must-not-stage');});
    const deadline=Date.now()+5000;let blocked=false;while(Date.now()<deadline){const activity=await raw.get("SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%capability_resources%' AND state='active'") as {count:number};if(activity.count){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}assert(blocked,'Observe actual resource-lock wait before revoking the queued publisher.');
    await locker.run('DELETE FROM capability_resource_grants WHERE resource_ref=$1',[ref]);await locker.run('UPDATE capability_resources SET grants_revision=2 WHERE resource_ref=$1',[ref]);await locker.run('COMMIT');await locker.close();locker=undefined;
    await assert.rejects(()=>queued,{code:'PACKAGE_ACCESS_DENIED'});assert.equal(stageCalls,0);assert.equal(await store.getCapabilityPackageState(ref),null);
    await resources.mutateCapabilityResource(owner,ref,{expectedMetadataRevision:1,expectedGrantsRevision:2,grants:[{targetType:'user',targetId:editor.userId,canUse:false,canEdit:true,canManage:false}]});
    const publish=async(failure=false)=>artifacts.withCapabilityPackageRegistryPublication(binding,async()=>{
      let staged:Awaited<ReturnType<typeof artifacts.stageCapabilityPackageRegistryPointer>>|undefined;
      try{return await store.publishCapabilityPackageDraft(editor,{...publishInput,expectedGrantsRevision:3},async(context,db)=>{
        const validation=await artifacts.validateCapabilityPackage('skill',location(context.draft).rootPath,{name:binding.name});assert(validation.valid);
        const snapshot=await io.preparePublishedSnapshot(location(context.draft),{resourceRef:ref,revisionRef:context.revisionRef,kind:'skill',name:binding.name,version:validation.version!,checksum:validation.checksum!,owner:ownership},validation);
        staged=await store.withCapabilityPackagePublication(context.authorization,{revisionRef:context.revisionRef,version:validation.version!,checksum:validation.checksum!,rootPath:snapshot.location.rootPath},db,()=>artifacts.stageCapabilityPackageRegistryPointer(context.authorization,snapshot));
        if(failure)throw new Error('fixture-registry-stage-rollback');sourceRoot=snapshot.location.rootPath;
        return{snapshot,sourceStamp:{...saved.baseSourceStamp,checksum:validation.checksum!,registryChecksum:validation.checksum!,artifactRevision:staged.record.revision??null}};
      });}catch(error){if(staged)await staged.rollback();throw error;}
    });
    const beforeRegistry=await fs.readFile(paths.resolveScopedSkillRegistryPath(scope),'utf8');await assert.rejects(()=>publish(true),/fixture-registry-stage-rollback/u);assert.equal(await fs.readFile(paths.resolveScopedSkillRegistryPath(scope),'utf8'),beforeRegistry);assert.equal(await store.getCapabilityPackageState(ref),null);assert.equal((await store.getCapabilityPackageDraft(editor,draft.draftRef)).draftRevision,2);
    const published=await publish();currentState=published.state;
    const targetBinding:CapabilityResourceStorageBinding={...binding,name:'native-fork',resourceId:artifacts.capabilityPackageLegacyStorageBinding('skill','native-fork',scope).resourceId};const targetOwner={type:'organization' as const,organizationId:scope.organizationId};
    const target=await resources.authorizeCapabilityPackageTarget(owner,targetBinding,targetOwner);const forkSource=await source(owner);
    const makeFork=()=>store.beginCapabilityPackageDraft(owner,{operation:'fork',resourceRef:ref,targetName:targetBinding.name,ownership:{type:'organization'},expectedSourceMetadataRevision:1,expectedSourceGrantsRevision:3,expectedSourcePackageRevision:1,expectedSourcePublishedRevisionRef:published.published.revisionRef},{source:forkSource,target},async current=>{await io.createCapabilityPackageDraft(forkSource.location,location(current));});
    const privateForks=await Promise.all([makeFork(),makeFork()]);const readyForks:CapabilityPackageDraft[]=[];
    for(const current of privateForks){const content=await fs.readFile(path.join(location(current).rootPath,'SKILL.md'),'utf8');readyForks.push((await store.mutateCapabilityPackageDraft(owner,current.draftRef,1,async current=>io.writeCapabilityPackageDraftFile(location(current),{path:'SKILL.md',encoding:'base64',content:Buffer.from(content.replace('name: native-source','name: native-fork')).toString('base64')}))).draft);}
    const concurrent=await Promise.allSettled(readyForks.map(current=>artifacts.withCapabilityPackageRegistryPublication(targetBinding,()=>store.publishCapabilityPackageDraft(owner,{draftRef:current.draftRef,expectedDraftRevision:2,expectedPackageRevision:0,expectedPublishedRevisionRef:null,expectedMetadataRevision:0,expectedGrantsRevision:0},async(context,db)=>{
      const validation=await artifacts.validateCapabilityPackage('skill',location(context.draft).rootPath,{name:targetBinding.name});assert(validation.valid);
      const snapshot=await io.preparePublishedSnapshot(location(context.draft),{resourceRef:context.draft.resourceRef,revisionRef:context.revisionRef,kind:'skill',name:targetBinding.name,version:validation.version!,checksum:validation.checksum!,owner:targetOwner},validation);
      const staged=await store.withCapabilityPackagePublication(context.authorization,{revisionRef:context.revisionRef,version:validation.version!,checksum:validation.checksum!,rootPath:snapshot.location.rootPath},db,()=>artifacts.stageCapabilityPackageRegistryPointer(context.authorization,snapshot,{enabled:false,newResource:true}));
      return{snapshot,sourceStamp:{resourceId:targetBinding.resourceId,kind:'skill',name:targetBinding.name,version:validation.version!,artifactRevision:staged.record.revision??null,checksum:validation.checksum!,registryChecksum:validation.checksum!,sourcePluginId:null}};
    }))));
    assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);assert.equal(concurrent.filter(result=>result.status==='rejected').length,1);
    const duplicate=concurrent.find(result=>result.status==='rejected');assert(duplicate?.status==='rejected');assert.equal(duplicate.reason.code,'PACKAGE_NAMESPACE_CONFLICT');
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_resources WHERE artifact_name=$1',[targetBinding.name]) as {count:number}).count,1);assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_versions') as {count:number}).count,2);
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_drafts') as {count:number}).count,1,'Only the rejected private draft remains, without a second public resource or SQL orphan.');
    console.log('PASS native 8-client PostgreSQL: draft COW/CAS, queued publisher revocation before staging, registry→SQL rollback, immutable current head and concurrent target namespace uniqueness.');
  }finally{if(locker){try{await locker.run('ROLLBACK');}catch{/* Preserve primary failure. */}await locker.close();}loader._load=original;await raw.close();await database.close();for(const key of envKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    const unlock=async(directory:string):Promise<void>=>{const stat=await fs.lstat(directory);if(stat.isDirectory()&&!stat.isSymbolicLink()){await fs.chmod(directory,0o700);for(const child of await fs.readdir(directory))await unlock(path.join(directory,child));}};await unlock(root);await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error('Native package gate failed.',{type:error instanceof Error?error.name:'Unknown',code:error&&typeof error==='object'?Reflect.get(error,'code'):undefined});process.exitCode=1;});
