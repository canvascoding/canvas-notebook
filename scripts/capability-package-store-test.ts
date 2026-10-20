import assert from 'node:assert/strict';
import Module from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, chmod, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '../app/lib/capabilities/resources/contracts';
import type { AuthorizedCapabilityPackageSource, CapabilityPackageDraft, CapabilityPackageSourceDraftCreation, CapabilityPackageValidation } from '../app/lib/capabilities/packages/contracts';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(),'canvas-package-store-'));
  const previousData = process.env.DATA; process.env.DATA = root; process.env.BASE_URL ??= 'http://localhost:3001';
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & {_load:(name:string,parent:NodeModule|null,main:boolean)=>unknown};
  const original = loader._load;
  loader._load = (name,parent,isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    return original(name,parent,isMain);
  };
  try {
    for (const id of ['owner','editor','manager','reader','stranger']) {
      await raw.run('INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'user\',1,1,1)',[id,`${id}@fixture.example.test`]);
    }
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org','owner','team',1,1,1)");
    for (const id of ['owner','editor','manager','reader','stranger']) await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org',$1,$2,'active',$3,1,1)",[id,id==='owner'?'owner':'member',Number(id==='owner')]);
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team','org','team','team','Team','active',1,1)");
    await raw.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ('org','team','manager','member','active',1,1,1,1)");
    const resources = await import('../app/lib/capabilities/resources/store');
    const store = await import('../app/lib/capabilities/packages/store');
    const io = await import('../app/lib/capabilities/packages/io');
    const actor:CapabilityResourceActor = {userId:'owner'};
    const editor:CapabilityResourceActor = {userId:'editor'};
    const binding:CapabilityResourceStorageBinding = {resourceType:'skill',resourceId:'fixture:org:skill:source',scopeType:'organization',name:'package-source',sourceType:'standalone',organizationId:'org',ownerUserId:null,sourcePluginId:null};
    const adopted = await resources.adoptCapabilityResource(actor,binding,{expectedMetadataRevision:0,expectedGrantsRevision:0,accessMode:'restricted',grants:[
      {targetType:'user',targetId:'editor',canUse:false,canEdit:true,canManage:false},
      {targetType:'user',targetId:'reader',canUse:true,canEdit:false,canManage:false},
    ]});
    const ref = adopted.metadata.resourceRef;
    let packageRoot = path.join(root,'source',binding.name); await mkdir(path.join(packageRoot,'scripts'),{recursive:true}); await mkdir(path.join(packageRoot,'assets'));
    await writeFile(path.join(packageRoot,'SKILL.md'),'---\nname: package-source\ndescription: Complete package fixture\nmetadata:\n  version: 1.0.0\n---\nRun scripts/main.js and use assets/icon.bin.\n');
    await writeFile(path.join(packageRoot,'scripts/main.js'),'process.stdout.write("first");\n');
    await writeFile(path.join(packageRoot,'assets/icon.bin'),Buffer.from([0,1,255,128]));
    const owner = adopted.metadata.ownership;
    const source = async (who:CapabilityResourceActor):Promise<AuthorizedCapabilityPackageSource> => {
      const authorization = await resources.authorizeCapabilityPackageResource(who,binding,'read');
      const inventory = await io.readExactPackageInventory(packageRoot);
      return {authorization,storage:binding,sourceStamp:{resourceId:binding.resourceId,kind:'skill',name:binding.name,version:'1.0.0',artifactRevision:1,registryChecksum:'legacy-registry',checksum:inventory.checksum,sourcePluginId:null},
        location:{rootPath:packageRoot,resourceRef:ref,owner,kind:'skill',name:binding.name},readOnly:false};
    };
    const edit = (resourceRef=ref):Extract<CapabilityPackageSourceDraftCreation,{operation:'edit'}> => ({operation:'edit',resourceRef,expectedMetadataRevision:1,expectedGrantsRevision:1,expectedPackageRevision:0,expectedPublishedRevisionRef:null});
    const location = (draft:CapabilityPackageDraft) => io.resolveCapabilityPackageDraftLocation({draftRef:draft.draftRef,resourceRef:draft.resourceRef,
      kind:draft.kind,name:draft.name,actorUserId:draft.actorUserId,draftRevision:draft.draftRevision,owner});
    const capturedSource=await source(editor);
    const draft = await store.beginCapabilityPackageDraft(editor,edit(),{source:capturedSource},async draft => {
      const inventory = await io.createCapabilityPackageDraft(capturedSource.location,location(draft));
      assert.equal(inventory.files.length,3,'Full package clone retains executable code and binary assets.');
    });
    assert.equal((await resources.getCapabilityResourceAccess(editor,binding)).access.canUse,false,'Editing never grants execution.');
    await assert.rejects(()=>store.getCapabilityPackageDraft({userId:'stranger'},draft.draftRef),{code:'PACKAGE_NOT_FOUND'});
    assert(!resources.isAuthorizedCapabilityPackageResource(structuredClone((await source(editor)).authorization)),'Serialized receipts cannot issue filesystem authority.');
    const update = await store.mutateCapabilityPackageDraft(editor,draft.draftRef,1,async current => io.writeCapabilityPackageDraftFile(location(current),{path:'scripts/main.js',encoding:'base64',content:Buffer.from('process.stdout.write("second");\n').toString('base64')}));
    assert.equal(update.draft.draftRevision,2);
    assert.match(await readFile(path.join(location(draft).rootPath,'scripts/main.js'),'utf8'),/first/u,'Previous draft revision remains immutable.');
    assert.match(await readFile(path.join(location(update.draft).rootPath,'scripts/main.js'),'utf8'),/second/u);
    await assert.rejects(()=>store.mutateCapabilityPackageDraft(editor,draft.draftRef,1,async()=>undefined),{code:'PACKAGE_DRAFT_CONFLICT'});
    await assert.rejects(()=>store.mutateCapabilityPackageDraft(editor,draft.draftRef,2,async()=>{throw new Error('fixture-write-failure');}),/fixture-write-failure/u);
    assert.equal((await store.getCapabilityPackageDraft(editor,draft.draftRef)).draftRevision,2,'A failed file callback does not advance SQL revision.');
    const request = {draftRef:draft.draftRef,expectedDraftRevision:2,expectedMetadataRevision:1,expectedGrantsRevision:1,expectedPackageRevision:0,expectedPublishedRevisionRef:null};
    let successfulSnapshotPath='';
    const publish = (failure=false) => store.publishCapabilityPackageDraft(editor,request,async(context,db) => {
      const inventory = await io.readExactPackageInventory(location(context.draft).rootPath);
      const validation:CapabilityPackageValidation = {valid:true,kind:'skill',name:binding.name,version:'1.0.0',checksum:inventory.checksum,
        files:inventory.files.map(({path,size,checksum})=>({path,size,checksum})),totalBytes:inventory.totalBytes,errors:[],warnings:[]};
      const snapshot = await io.preparePublishedSnapshot(location(context.draft),{resourceRef:ref,revisionRef:context.revisionRef,kind:'skill',name:binding.name,version:validation.version!,checksum:validation.checksum!,owner},validation);
      await store.withCapabilityPackagePublication(context.authorization,{revisionRef:context.revisionRef,version:validation.version!,checksum:validation.checksum!,rootPath:snapshot.location.rootPath},db,async()=>{
        assert(store.isCapabilityPackagePublicationAllowed(binding,{version:validation.version!,checksum:validation.checksum!,installDir:snapshot.location.rootPath}));
        assert(!store.isCapabilityPackagePublicationAllowed({...binding,name:'foreign'}));
        if(failure) throw new Error('fixture-registry-failure');
      });
      successfulSnapshotPath=snapshot.location.rootPath;
      assert(draft.baseSourceStamp, 'An edit retains its captured source observation.');
      return {snapshot,sourceStamp:{...draft.baseSourceStamp,version:validation.version!,artifactRevision:2,registryChecksum:inventory.checksum,checksum:inventory.checksum}};
    });
    await assert.rejects(()=>publish(true),/fixture-registry-failure/u);
    assert.equal(await store.getCapabilityPackageState(ref),null,'SQL head is absent after staged filesystem failure.');
    assert.equal((await store.getCapabilityPackageDraft(editor,draft.draftRef)).draftRevision,2);
    const result = await publish(); assert.equal(result.state.packageRevision,1);
    packageRoot=successfulSnapshotPath;
    assert.equal(result.published.files.length,3); await assert.rejects(()=>store.getCapabilityPackageDraft(editor,draft.draftRef),{code:'PACKAGE_NOT_FOUND'});
    await store.assertCapabilityPackageCommittedReference({resourceRef:ref,revisionRef:result.published.revisionRef,version:'1.0.0',checksum:result.published.checksum});
    await assert.rejects(()=>store.assertCapabilityPackageCommittedReference({resourceRef:ref,revisionRef:'canvas-package-revision:00000000-0000-0000-0000-000000000000',version:'1.0.0',checksum:result.published.checksum}),{code:'PACKAGE_SNAPSHOT_UNAVAILABLE'});
    await assert.rejects(()=>store.assertCapabilityPackageLegacyMutationAllowed(binding),{code:'PACKAGE_REVISION_CONFLICT'});
    const postPublishedSource = {...await source(editor),sourceStamp:result.state.currentSourceStamp};
    await assert.rejects(()=>store.beginCapabilityPackageDraft(editor,edit(),{source:postPublishedSource},async()=>undefined),{code:'PACKAGE_REVISION_CONFLICT'});
    const currentCreation = {...edit(),expectedPackageRevision:1,expectedPublishedRevisionRef:result.published.revisionRef};
    const nextDraft = await store.beginCapabilityPackageDraft(editor,currentCreation,{source:postPublishedSource},async()=>undefined);
    await resources.mutateCapabilityResource(actor,ref,{expectedMetadataRevision:1,expectedGrantsRevision:1,grants:[]});
    await assert.rejects(()=>store.mutateCapabilityPackageDraft(editor,nextDraft.draftRef,1,async()=>undefined),{code:'PACKAGE_ACCESS_DENIED'});
    await assert.rejects(()=>store.publishCapabilityPackageDraft(editor,{...request,draftRef:nextDraft.draftRef,expectedDraftRevision:1,expectedPackageRevision:1,expectedPublishedRevisionRef:result.published.revisionRef},async()=>{throw new Error('callback-must-not-run');}),{code:'PACKAGE_ACCESS_DENIED'});
    const status=await store.getCapabilityPackageOwnedDraftStatus(editor,nextDraft.draftRef);assert.equal(status.draftRevision,1);
    assert(!JSON.stringify(status).includes('rootPath')&&!JSON.stringify(status).includes('sourceStamp'),'Recovery exposes only stored own metadata.');
    await assert.rejects(()=>store.getCapabilityPackageOwnedDraftStatus(actor,nextDraft.draftRef),{code:'PACKAGE_NOT_FOUND'});
    await store.discardCapabilityPackageDraft(editor,nextDraft.draftRef,1,async()=>undefined);
    await raw.run('DELETE FROM organization_user_permissions WHERE user_id=\'editor\'');
    await raw.run('DELETE FROM "user" WHERE id=\'editor\'');
    assert.equal((await store.getCapabilityPackagePublishedRevision(ref,result.published.revisionRef))!.publishedByUserId,null,'Deleting the editor preserves an organization-owned publication.');
    const manager={userId:'manager',workspaceId:'team'};
    const targetBinding={...binding,resourceId:'fixture:org:skill:fork',name:'package-fork'};
    const targetOwnership={type:'team' as const,organizationId:'org',workspaceId:'team'};
    const target=await resources.authorizeCapabilityPackageTarget(manager,targetBinding,targetOwnership);
    assert.equal(await resources.findCapabilityResourceRecord(targetBinding.resourceId),null,'A target receipt never exposes an uninstalled resource.');
    const ownerSource=await source(actor); ownerSource.sourceStamp=result.state.currentSourceStamp;
    const forkCreation:CapabilityPackageSourceDraftCreation={operation:'fork',resourceRef:ref,targetName:targetBinding.name,ownership:{type:'team',workspaceId:'team'},expectedSourceMetadataRevision:1,expectedSourceGrantsRevision:2,expectedSourcePackageRevision:1,expectedSourcePublishedRevisionRef:result.published.revisionRef};
    // Manager needs source read separately; target management never grants foreign source access.
    await assert.rejects(()=>store.beginCapabilityPackageDraft(manager,forkCreation,{source:ownerSource,target},async()=>undefined),{code:'PACKAGE_ACCESS_DENIED'});
    await resources.mutateCapabilityResource(actor,ref,{expectedMetadataRevision:1,expectedGrantsRevision:2,grants:[{targetType:'user',targetId:'manager',canUse:true,canEdit:false,canManage:false}]});
    const managerSource=await source(manager); managerSource.sourceStamp=result.state.currentSourceStamp;
    await raw.run("UPDATE canvas_workspace_members SET can_manage=0 WHERE workspace_id='team' AND user_id='manager'");
    await assert.rejects(()=>store.beginCapabilityPackageDraft(manager,{...forkCreation,expectedSourceGrantsRevision:3},{source:managerSource,target},async()=>{throw new Error('stale-manager-copy-must-not-run');}),{code:'PACKAGE_ACCESS_DENIED'});
    await raw.run("UPDATE canvas_workspace_members SET can_manage=1 WHERE workspace_id='team' AND user_id='manager'");
    const fork=await store.beginCapabilityPackageDraft(manager,{...forkCreation,expectedSourceGrantsRevision:3},{source:managerSource,target},async()=>undefined);
    assert.equal(await resources.findCapabilityResourceRecord(targetBinding.resourceId),null);
    await store.discardCapabilityPackageDraft(manager,fork.draftRef,1,async()=>undefined);
    assert.equal(await resources.findCapabilityResourceRecord(targetBinding.resourceId),null,'Discard leaves no namespace reservation or grants.');
    const readySource=await source(manager);readySource.sourceStamp=result.state.currentSourceStamp;
    const initialReadyFork=await store.beginCapabilityPackageDraft(manager,{...forkCreation,expectedSourceGrantsRevision:3},{source:readySource,target},async draft=>{
      const targetLocation=io.resolveCapabilityPackageDraftLocation({...draft,owner:targetOwnership});
      await io.createCapabilityPackageDraft(readySource.location,targetLocation);
    });
    const forkSkill=await readFile(path.join(io.resolveCapabilityPackageDraftLocation({...initialReadyFork,owner:targetOwnership}).rootPath,'SKILL.md'),'utf8');
    const {draft:readyFork}=await store.mutateCapabilityPackageDraft(manager,initialReadyFork.draftRef,1,async current=>io.writeCapabilityPackageDraftFile(
      io.resolveCapabilityPackageDraftLocation({...current,owner:targetOwnership}),{path:'SKILL.md',encoding:'base64',content:Buffer.from(forkSkill.replace('name: package-source','name: package-fork')).toString('base64')}));
    assert.equal(readyFork.sourcePublishedRevisionRef,result.published.revisionRef,'Fork provenance records exact source head independently of empty target head.');
    const forkPublished=await store.publishCapabilityPackageDraft(manager,{draftRef:readyFork.draftRef,expectedDraftRevision:2,expectedPackageRevision:0,expectedPublishedRevisionRef:null,expectedMetadataRevision:0,expectedGrantsRevision:0},async(context,db)=>{
      const draftLocation=io.resolveCapabilityPackageDraftLocation({...context.draft,owner:targetOwnership});
      const inventory=await io.readExactPackageInventory(draftLocation.rootPath);
      const {parseSkillFile}=await import('../app/lib/skills/canvas-skill-manifest');
      const parsed=await parseSkillFile(path.join(draftLocation.rootPath,'SKILL.md'));
      assert.equal(parsed?.name,targetBinding.name);assert.equal(parsed?.version,'1.0.0');
      const validation:CapabilityPackageValidation={valid:true,kind:'skill',name:targetBinding.name,version:'1.0.0',checksum:inventory.checksum,files:inventory.files.map(({path,size,checksum})=>({path,size,checksum})),totalBytes:inventory.totalBytes,errors:[],warnings:[]};
      const snapshot=await io.preparePublishedSnapshot(draftLocation,{resourceRef:context.draft.resourceRef,revisionRef:context.revisionRef,kind:'skill',name:targetBinding.name,version:'1.0.0',checksum:inventory.checksum,owner:targetOwnership},validation);
      await store.withCapabilityPackagePublication(context.authorization,{revisionRef:context.revisionRef,version:'1.0.0',checksum:inventory.checksum,rootPath:snapshot.location.rootPath},db,async()=>undefined);
      return {snapshot,sourceStamp:{resourceId:targetBinding.resourceId,kind:'skill',name:targetBinding.name,version:'1.0.0',artifactRevision:1,registryChecksum:inventory.checksum,checksum:inventory.checksum,sourcePluginId:null}};
    });
    const targetRecord=(await resources.findCapabilityResourceRecord(targetBinding.resourceId))!;
    assert.equal(targetRecord.metadata.resourceRef,forkPublished.state.resourceRef);assert.equal(targetRecord.metadata.accessMode,'restricted');
    assert.equal((await resources.getCapabilityResourceAccess({userId:'reader'},targetBinding)).access.canRead,false,'Source grants are never copied to a new target.');
    assert.deepEqual((await resources.getCapabilityResourceAccess(manager,targetBinding)).access,{canRead:true,canUse:false,canEdit:true,canManage:true},'Team management does not grant execution of a newly restricted fork.');
    assert.equal(forkPublished.published.sourceRevisionRef,result.published.revisionRef);
    assert.equal((await raw.get('SELECT COUNT(*)::integer AS count FROM capability_package_versions') as {count:number}).count,2);
    assert.equal(createHash('sha256').update(Buffer.from([0,1,255,128])).digest('hex'),result.published.files.find(file=>file.path==='assets/icon.bin')!.checksum);
    console.log('PASS capability package SQL authority, actor-private complete drafts, immutable snapshots, head/draft CAS, failure rollback, revocation and deferred forks.');
  } finally { loader._load=original; await raw.close(); await database.close(); if(previousData===undefined) delete process.env.DATA; else process.env.DATA=previousData;
    const unlock=async(directory:string):Promise<void>=>{const entry=await lstat(directory);if(entry.isDirectory()&&!entry.isSymbolicLink()){await chmod(directory,0o700);for(const name of await readdir(directory))await unlock(path.join(directory,name));}};
    await unlock(root);await rm(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
