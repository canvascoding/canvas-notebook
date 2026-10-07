import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import type { OwnedCapabilityPackageFixture } from '../../tests/helpers/capability-package-test-cleanup';
import type { CapabilityResourceStorageBinding,CapabilityResourceOwnerScope } from '../../app/lib/capabilities/resources/contracts';
import {assertExactCleanupChildren,runConfirmedCapabilityPackageCleanup} from '../../tests/helpers/capability-package-cleanup-guards';

type Row=Record<string,unknown>;
async function main() {
  assert.equal(process.env.NODE_ENV,'test');
  dotenv.config({path:path.join(os.homedir(),'.local/state/canvas-local-team-seat/notebook-host-dev.env'),quiet:true,override:true});
  Object.assign(process.env,{NODE_ENV:'test'});
  const url=new URL(process.env.DATABASE_URL??'');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/canvas_notebook');assert.equal(url.search,'');
  const receipt=JSON.parse(await fs.readFile(process.argv[2],'utf8')) as OwnedCapabilityPackageFixture;
  assert.match(receipt.nonce,/^[a-f0-9]{10}$/u);assert(receipt.names.length>=1&&receipt.names.length<=5);
  for(const name of receipt.names) assert.match(name,new RegExp(`^package-editor-qa-(?:org-|team-)?${receipt.nonce}$`,'u'));
  assert(Array.isArray(receipt.resourceRevisions)&&receipt.resourceRevisions.length<=receipt.names.length);
  if(receipt.sourceResourceRef)assert.match(receipt.sourceResourceRef,/^canvas-resource:[a-f0-9-]{36}$/u);
  for(const revision of receipt.resourceRevisions){assert.match(revision.resourceRef,/^canvas-resource:[a-f0-9-]{36}$/u);assert.equal(revision.metadataRevision,1);assert([1,2,3,4,5].includes(revision.grantsRevision));if(revision.grantsRevision!==1)assert.equal(revision.resourceRef,receipt.sourceResourceRef,'Only the exact receipted source may contain the two grant/revoke rounds (revisions2–5).');}
  assert.equal(new Set(receipt.resourceRevisions.map(value=>value.resourceRef)).size,receipt.resourceRevisions.length);
  assert(receipt.names.includes(receipt.sourceName));assert(receipt.actorIds.includes(receipt.adminId));assert(receipt.actorIds.length<=2);
  const preferences=receipt.preferences??[];
  assert(Array.isArray(preferences)&&preferences.length<=2);
  assert.equal(new Set(preferences.map(value=>`${value.userId}:${value.resourceId}`)).size,preferences.length);
  for(const preference of preferences){assert(receipt.actorIds.includes(preference.userId));assert.equal(typeof preference.resourceId,'string');assert(preference.resourceId.length>0);assert.equal(typeof preference.enabled,'boolean');assert(Number.isSafeInteger(preference.revision)&&preference.revision>0);}
  const data=await fs.realpath(process.env.DATA??'');assert.equal(data,await fs.realpath(receipt.dataRoot));
  assert(data.startsWith(path.join(os.homedir(),'.local/state/canvas-local-team-seat/') ));assert.equal(path.basename(data),'notebook-data');
  assert(path.basename(receipt.sourceDirectory).startsWith(`${receipt.sourceName}-`));
  const manifest=JSON.parse(await fs.readFile(path.join(receipt.sourceDirectory,'.canvas-plugin/plugin.json'),'utf8')) as {name:string;version:string};
  assert.equal(manifest.name,receipt.sourceName);assert.equal(manifest.version,receipt.initialVersion);
  const {openDb}=await import('../../app/lib/db');
  const {withCapabilityPackageRegistryPublication,withCapabilityPackageRegistryLock}=await import('../../app/lib/capabilities/packages/artifacts');
  const {withAuthorizedCapabilityPackageResource}=await import('../../app/lib/capabilities/resources/store');
  const {readExactPackageInventory,resolveOwnerScopedPackageVersionPath,verifyCapabilityPackageSnapshot}=await import('../../app/lib/capabilities/packages/io');
  const {resolveScopedPluginRegistryPath,resolveScopedSkillRegistryPath,resolveScopedInstalledPluginsDir,resolveScopedSkillsDataDir,resolveUserDataRoot,resolveUserSettingsDir,createAtomicTempPath}=await import('../../app/lib/runtime-data-paths');
  const {withFileMutationLock}=await import('../../app/lib/secrets/file-mutation-lock');
  const scope={scopeType:'organization' as const,organizationId:receipt.organizationId};
  assert.equal((await readExactPackageInventory(receipt.sourceDirectory)).checksum,receipt.initialChecksum,'Fixture intake bytes changed; preserve it.');
  const pluginRegistryPath=resolveScopedPluginRegistryPath(scope),skillRegistryPath=resolveScopedSkillRegistryPath(scope);
  const first=await openDb();let frozen:Row[],drafts:Row[];
  try {
    frozen=await first.all('SELECT * FROM capability_resources WHERE artifact_name=ANY($1::text[])',[receipt.names]) as Row[];
    drafts=await first.all('SELECT * FROM capability_package_drafts WHERE name=ANY($1::text[])',[receipt.names]) as Row[];
  }finally{await first.close();}
  for(const row of frozen){assert.equal(row.resource_type,'plugin');assert.equal(row.source_type,'standalone');assert.equal(row.storage_scope_type,'organization');assert.equal(row.storage_organization_id,receipt.organizationId);assert.equal(String(row.created_by_user_id),receipt.adminId);
    const revision=receipt.resourceRevisions.find(value=>value.resourceRef===row.resource_ref);assert(revision);assert.equal(Number(row.metadata_revision),revision.metadataRevision);assert.equal(Number(row.grants_revision),revision.grantsRevision);if(revision.grantsRevision!==1)assert.equal(row.artifact_name,receipt.sourceName);assert.equal(row.status,'active');assert.equal(row.access_mode,'restricted');}
  assert.equal(frozen.length,receipt.resourceRevisions.length,'Every adopted fixture resource requires an exact own revision receipt.');
  for(const preference of preferences)assert(frozen.some(row=>row.legacy_resource_id===preference.resourceId),'Only an exact owned adopted resource preference may be removed.');
  for(const row of drafts){assert(receipt.actorIds.includes(String(row.actor_user_id)));assert(receipt.names.includes(String(row.name)));}
  const original=JSON.parse(await fs.readFile(pluginRegistryPath,'utf8')) as {plugins:Record<string,Row>};
  const anchor=original.plugins[receipt.sourceName];assert(anchor);assert.equal(anchor.name,receipt.sourceName);
  const binding:CapabilityResourceStorageBinding={resourceType:'plugin',resourceId:String(anchor.resourceId),name:receipt.sourceName,sourceType:'standalone',scopeType:'organization',organizationId:receipt.organizationId,ownerUserId:null,sourcePluginId:null};
  const removals=new Set<string>();const snapshots=new Map<string,string|null>();const endChecks:Array<()=>Promise<void>>=[];
  const safeDirectory=async(directory:string)=>{assert(directory.startsWith(`${data}${path.sep}`));assert.equal(await fs.realpath(directory),path.resolve(directory));assert((await fs.lstat(directory)).isDirectory());};
  const captureRegistry=async(file:string)=>{const raw=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});snapshots.set(file,raw);return raw?JSON.parse(raw) as {plugins?:Record<string,Row>;skills?:Record<string,Row>;revision?:number}:null;};
  const actor={userId:receipt.adminId};
  const preferenceFiles=[...new Set(preferences.map(value=>path.join(resolveUserSettingsDir(value.userId),'capabilities.json')))].sort();
  const preferenceSnapshots=new Map<string,string>();
  const withPreferenceLocks=async(index:number,operation:()=>Promise<void>):Promise<void>=>{
    const file=preferenceFiles[index];if(!file)return operation();
    await safeDirectory(path.dirname(file));
    return withFileMutationLock(file,async()=>{
      const stat=await fs.lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);assert.equal(await fs.realpath(file),file);
      const raw=await fs.readFile(file,'utf8');const document=JSON.parse(raw) as {version:number;preferences:Record<string,{enabled:boolean;revision:number}>};assert.equal(document.version,1);
      for(const expected of preferences.filter(value=>path.join(resolveUserSettingsDir(value.userId),'capabilities.json')===file)){const observed=document.preferences[expected.resourceId];assert(observed);assert.equal(observed.enabled,expected.enabled);assert.equal(observed.revision,expected.revision);}
      preferenceSnapshots.set(file,raw);
      endChecks.push(async()=>{assert.equal(await fs.readFile(file,'utf8'),raw,'Personal activation changed; preserve fixture.');});
      return withPreferenceLocks(index+1,operation);
    });
  };
  const registerVersionContainer=async(resourceRef:string,name:string,owner:CapabilityResourceOwnerScope)=>{
    assert.match(resourceRef,/^canvas-resource:[a-f0-9-]{36}$/u);
    const example=resolveOwnerScopedPackageVersionPath({resourceRef,revisionRef:'canvas-package-revision:00000000-0000-0000-0000-000000000000',kind:'plugin',name,owner});
    const container=path.dirname(path.dirname(example));const existing=await fs.lstat(container).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!existing)return;
    await safeDirectory(container);
    const children=await fs.readdir(container);const captured:Array<Parameters<typeof verifyCapabilityPackageSnapshot>[0]>=[];
    for(const child of children){assert.match(child,/^[a-f0-9-]{36}$/u);const rootPath=path.join(container,child,name);
      const marker=JSON.parse(await fs.readFile(path.join(container,child,'published.json'),'utf8')) as {resourceRef:string;revisionRef:string;checksum:string};
      assert.equal(marker.resourceRef,resourceRef);assert.equal(marker.revisionRef,`canvas-package-revision:${child}`);assert.match(marker.checksum,/^[a-f0-9]{64}$/u);
      const packageManifest=JSON.parse(await fs.readFile(path.join(rootPath,'.canvas-plugin/plugin.json'),'utf8')) as {name:string;version:string};assert.equal(packageManifest.name,name);
      const snapshot={resourceRef,revisionRef:marker.revisionRef,checksum:marker.checksum,version:packageManifest.version,kind:'plugin' as const,name,owner,rootPath};
      await verifyCapabilityPackageSnapshot(snapshot);captured.push(snapshot);
      assert.deepEqual((await fs.readdir(path.join(container,child))).sort(),[name,'published.json'].sort());
    }endChecks.push(async()=>{await safeDirectory(container);await assertExactCleanupChildren(container,children);for(const snapshot of captured){await verifyCapabilityPackageSnapshot(snapshot);await assertExactCleanupChildren(path.dirname(snapshot.rootPath),[name,'published.json']);}});removals.add(container);
  };
  await runConfirmedCapabilityPackageCleanup({withLock:operation=>withCapabilityPackageRegistryPublication(binding,()=>withCapabilityPackageRegistryLock('skill',scope,()=>withPreferenceLocks(0,operation))),commit:()=>withAuthorizedCapabilityPackageResource(actor,binding,'read',undefined,async(authorization,database)=>{
    assert(authorization.access.canManage,'Only the actual fixture manager may clean up owned resources.');
    const current=await database.all('SELECT * FROM capability_resources WHERE artifact_name=ANY($1::text[]) ORDER BY resource_ref FOR UPDATE',[receipt.names]) as Row[];
    assert.equal(JSON.stringify([...current].sort((a,b)=>String(a.resource_ref).localeCompare(String(b.resource_ref)))),JSON.stringify([...frozen].sort((a,b)=>String(a.resource_ref).localeCompare(String(b.resource_ref)))),'Resource rows changed; preserve fixture.');
    const lockedDrafts=await database.all('SELECT * FROM capability_package_drafts WHERE name=ANY($1::text[]) ORDER BY draft_ref FOR UPDATE',[receipt.names]) as Row[];
    assert.equal(JSON.stringify([...lockedDrafts].sort((a,b)=>String(a.draft_ref).localeCompare(String(b.draft_ref)))),JSON.stringify([...drafts].sort((a,b)=>String(a.draft_ref).localeCompare(String(b.draft_ref)))),'Draft rows changed; preserve fixture.');
    const plugins=await captureRegistry(pluginRegistryPath);const skills=await captureRegistry(skillRegistryPath);
    assert(plugins?.plugins);
    const versions=await database.all('SELECT v.* FROM capability_package_versions v JOIN capability_resources r ON r.resource_ref=v.resource_ref WHERE r.artifact_name=ANY($1::text[])',[receipt.names]) as Row[];
    for(const version of versions){assert(receipt.actorIds.includes(String(version.published_by_user_id)));assert(receipt.names.includes(String(version.name)));}
    const observed=versions.map(version=>({resourceRef:String(version.resource_ref),revisionRef:String(version.revision_ref),checksum:String(version.checksum),version:String(version.version)})).sort((a,b)=>a.revisionRef.localeCompare(b.revisionRef));
    assert.equal(JSON.stringify(observed),JSON.stringify([...receipt.publications].sort((a,b)=>a.revisionRef.localeCompare(b.revisionRef))),'Publication history changed; preserve fixture.');
    const refs=new Set(current.map(row=>String(row.resource_ref)));
    for(const version of versions){assert(refs.has(String(version.source_resource_ref)));if(version.source_revision_ref){const source=versions.find(value=>value.revision_ref===version.source_revision_ref);assert(source);assert.equal(source.checksum,version.source_checksum);}else assert.equal(version.source_checksum,receipt.initialChecksum);}
    for(const row of current){
      const name=String(row.artifact_name),pointer:Row|undefined=plugins.plugins[name];assert(pointer);assert.equal(pointer.resourceId,row.legacy_resource_id);
      const state=await database.get('SELECT * FROM capability_package_states WHERE resource_ref=$1',[row.resource_ref]) as Row|undefined;
      if(state){const version=versions.find(v=>v.revision_ref===state.current_published_revision_ref);assert(version);assert.equal(pointer.packageResourceRef,row.resource_ref);assert.equal(pointer.publishedRevisionRef,version.revision_ref);assert.equal(pointer.checksum,version.checksum);assert.equal(pointer.version,version.version);}
      else{assert.equal(name,receipt.sourceName);assert(!pointer.packageManaged);assert.equal(pointer.checksum,receipt.initialChecksum);}
      const owner:CapabilityResourceOwnerScope=row.ownership_type==='team'?{type:'team',organizationId:receipt.organizationId,workspaceId:String(row.team_workspace_id)}:{type:'organization',organizationId:receipt.organizationId};
      await registerVersionContainer(String(row.resource_ref),name,owner);
      delete plugins.plugins[name];
    }
    const legacyRoot=path.join(resolveScopedInstalledPluginsDir(scope),receipt.sourceName,receipt.initialVersion);
    await safeDirectory(legacyRoot);assert.equal((await readExactPackageInventory(legacyRoot)).checksum,receipt.initialChecksum);
    await safeDirectory(path.dirname(legacyRoot));await assertExactCleanupChildren(path.dirname(legacyRoot),[receipt.initialVersion]);removals.add(legacyRoot);
    endChecks.push(async()=>{await safeDirectory(legacyRoot);await assertExactCleanupChildren(path.dirname(legacyRoot),[receipt.initialVersion]);assert.equal((await readExactPackageInventory(legacyRoot)).checksum,receipt.initialChecksum);});
    if(!current.some(row=>row.artifact_name===receipt.sourceName)){const pointer=plugins.plugins[receipt.sourceName];assert(pointer&&!pointer.packageManaged);assert.equal(pointer.checksum,receipt.initialChecksum);delete plugins.plugins[receipt.sourceName];}
    for(const [name,record]of Object.entries(skills?.skills??{})){
      if(record.sourceType!=='plugin'||!receipt.names.includes(String(record.sourcePluginName)))continue;
      const candidate=path.join(resolveScopedSkillsDataDir(scope),name);await safeDirectory(candidate);
      const initialChild=path.join(receipt.sourceDirectory,'skills',name);const checksum=(await readExactPackageInventory(initialChild)).checksum;assert.equal((await readExactPackageInventory(candidate)).checksum,checksum);
      endChecks.push(async()=>{await safeDirectory(candidate);assert.equal((await readExactPackageInventory(candidate)).checksum,checksum);});
      removals.add(candidate);delete skills!.skills![name];
    }
    for(const draft of lockedDrafts){const target=JSON.parse(String(draft.target_storage)) as CapabilityResourceStorageBinding;assert(receipt.names.includes(target.name));assert.equal(target.organizationId,receipt.organizationId);assert.equal(target.scopeType,'organization');
      const draftUuid=String(draft.draft_ref).replace(/^canvas-package-draft:/u,'');assert.match(draftUuid,/^[a-f0-9-]{36}$/u);
      const draftRoot=path.join(resolveUserDataRoot(String(draft.actor_user_id)),'capability-packages','drafts',draftUuid);await safeDirectory(draftRoot);const checksum=(await readExactPackageInventory(draftRoot)).checksum;
      endChecks.push(async()=>{await safeDirectory(draftRoot);assert.equal((await readExactPackageInventory(draftRoot)).checksum,checksum);});removals.add(draftRoot);
      const owner=JSON.parse(String(draft.target_ownership)) as CapabilityResourceOwnerScope;assert(owner.type==='organization'||owner.type==='team');assert.equal(owner.organizationId,receipt.organizationId);
      await registerVersionContainer(String(draft.resource_ref),String(draft.name),owner);
    }
    const writeRaw=async(file:string,document:unknown)=>{const temporary=createAtomicTempPath(file);try{await fs.writeFile(temporary,`${JSON.stringify(document,null,2)}\n`);await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}};
    try{await writeRaw(pluginRegistryPath,plugins);if(skills)await writeRaw(skillRegistryPath,skills);
      await database.run('DELETE FROM capability_package_drafts WHERE draft_ref=ANY($1::text[])',[lockedDrafts.map(row=>String(row.draft_ref))]);
      await database.run('DELETE FROM capability_resources WHERE resource_ref=ANY($1::text[])',[current.map(row=>String(row.resource_ref))]);
    }catch(error){for(const[file,raw]of snapshots){if(raw!==null){const temp=createAtomicTempPath(file);await fs.writeFile(temp,raw);await fs.rename(temp,file);}}throw error;}
  }),finalize:async()=>{
  // Every end-check completes before the first destructive filesystem operation.
  for(const check of endChecks)await check();
  assert.equal((await readExactPackageInventory(receipt.sourceDirectory)).checksum,receipt.initialChecksum);
  for(const[file,raw]of preferenceSnapshots){
    const document=JSON.parse(raw) as {updatedAt:string;preferences:Record<string,unknown>};
    for(const expected of preferences.filter(value=>path.join(resolveUserSettingsDir(value.userId),'capabilities.json')===file))delete document.preferences[expected.resourceId];
    document.updatedAt=new Date().toISOString();const temporary=createAtomicTempPath(file);
    try{await fs.writeFile(temporary,`${JSON.stringify(document,null,2)}\n`);await fs.rename(temporary,file);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),document,'Owned preference removal must preserve every unrelated entry.');}finally{await fs.rm(temporary,{force:true});}
  }
  const unlock=async(directory:string):Promise<void>=>{const stat=await fs.lstat(directory);assert(!stat.isSymbolicLink());if(stat.isDirectory()){await fs.chmod(directory,0o700);for(const name of await fs.readdir(directory))await unlock(path.join(directory,name));}};
  for(const directory of removals){await safeDirectory(directory);await unlock(directory);await fs.rm(directory,{recursive:true});}
  const legacyParent=path.join(resolveScopedInstalledPluginsDir(scope),receipt.sourceName);
  await safeDirectory(legacyParent);if((await fs.readdir(legacyParent)).length===0)await fs.rmdir(legacyParent);
  assert.equal((await readExactPackageInventory(receipt.sourceDirectory)).checksum,receipt.initialChecksum);await fs.rm(receipt.sourceDirectory,{recursive:true});
  }});
  const final=await openDb();try{assert.equal((await final.get('SELECT COUNT(*)::integer AS count FROM capability_resources WHERE artifact_name=ANY($1::text[])',[receipt.names]) as {count:number}).count,0);assert.equal((await final.get('SELECT COUNT(*)::integer AS count FROM capability_package_drafts WHERE name=ANY($1::text[])',[receipt.names]) as {count:number}).count,0);}finally{await final.close();}
  console.log('OWNED_PACKAGE_CLEANUP_PASS');
}
main().catch(()=>{console.error('Owned package cleanup stopped at a guard; preserve remaining fixture.');process.exitCode=1;});
