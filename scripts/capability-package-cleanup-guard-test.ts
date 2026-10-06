import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {withFileMutationLock} from '../app/lib/secrets/file-mutation-lock';
import {assertExactCleanupChildren,runConfirmedCapabilityPackageCleanup} from '../tests/helpers/capability-package-cleanup-guards';
import {withPrivateCapabilityPackageCleanupReceipt,type OwnedCapabilityPackageFixture} from '../tests/helpers/capability-package-test-cleanup';

async function main(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-package-cleanup-guard-'));await fs.chmod(root,0o700);
  const parent=path.join(root,'owned-package'),version=path.join(parent,'1.0.0'),pluginLock=path.join(root,'plugin.registry'),skillLock=path.join(root,'skill.registry');
  const create=async()=>{await fs.mkdir(version,{recursive:true});await fs.writeFile(path.join(version,'manifest.json'),'OWNED_INITIAL');};
  const remove=async()=>{await assertExactCleanupChildren(parent,['1.0.0']);assert.equal(await fs.readFile(path.join(version,'manifest.json'),'utf8'),'OWNED_INITIAL');await fs.rm(version,{recursive:true});};
  const withLock=<T>(operation:()=>Promise<T>)=>withFileMutationLock(pluginLock,()=>withFileMutationLock(skillLock,operation));
  try{
    const receipt:OwnedCapabilityPackageFixture={nonce:'0123456789',names:['package-editor-qa-0123456789'],actorIds:['temporary-owner'],adminId:'temporary-owner',organizationId:'temporary-org',dataRoot:root,sourceDirectory:root,sourceName:'package-editor-qa-0123456789',initialChecksum:'temporary-checksum',initialVersion:'1.0.0',publications:[],resourceRevisions:[]};
    let failedReceipt='';
    await assert.rejects(()=>withPrivateCapabilityPackageCleanupReceipt(receipt,async input=>{failedReceipt=input;throw new Error('SECRET_PRIVATE_CHILD_FAILURE');}),error=>error instanceof Error&&error.message===`Owned package cleanup failed; private recovery receipt preserved at ${failedReceipt}`);
    assert.equal((await fs.stat(path.dirname(failedReceipt))).mode&0o777,0o700);assert.equal((await fs.stat(failedReceipt)).mode&0o777,0o600);assert.deepEqual(JSON.parse(await fs.readFile(failedReceipt,'utf8')),receipt);await fs.rm(path.dirname(failedReceipt),{recursive:true});
    let successfulReceipt='';await withPrivateCapabilityPackageCleanupReceipt(receipt,async input=>{successfulReceipt=input;assert.deepEqual(JSON.parse(await fs.readFile(input,'utf8')),receipt);});await assert.rejects(()=>fs.stat(successfulReceipt),{code:'ENOENT'});
    await create();let finalizers=0;
    await assert.rejects(()=>runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>{throw new Error('unknown-commit-outcome');},finalize:async()=>{finalizers++;await remove();}}),/unknown-commit/u);
    assert.equal(finalizers,0);assert.equal(await fs.readFile(path.join(version,'manifest.json'),'utf8'),'OWNED_INITIAL');
    await fs.mkdir(path.join(parent,'2.0.0'));
    await assert.rejects(()=>runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>undefined,finalize:remove}),/Unreceipted/u);
    assert.deepEqual((await fs.readdir(parent)).sort(),['1.0.0','2.0.0']);await fs.rmdir(path.join(parent,'2.0.0'));
    await assert.rejects(()=>runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>{await fs.writeFile(path.join(version,'manifest.json'),'LATE_CHANGE');},finalize:remove}));
    assert.equal(await fs.readFile(path.join(version,'manifest.json'),'utf8'),'LATE_CHANGE');await create();
    let announceCommit!:()=>void,allowFinalize!:()=>void;const committed=new Promise<void>(resolve=>{announceCommit=resolve;}),gate=new Promise<void>(resolve=>{allowFinalize=resolve;});
    const events:string[]=[];
    const cleanup=runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>{await fs.writeFile(path.join(root,'skill-registry.json'),'CLEANUP_SNAPSHOT');events.push('commit-confirmed');announceCommit();},finalize:async()=>{await gate;await remove();events.push('files-removed');}});
    await committed;
    const writer=withFileMutationLock(pluginLock,async()=>{events.push('next-plugin-writer');await fs.mkdir(path.join(parent,'2.0.0'));await fs.writeFile(path.join(parent,'2.0.0/manifest.json'),'NEW_UNRECEIPTED_VERSION');});
    const skillWriter=withFileMutationLock(skillLock,async()=>{events.push('next-skill-writer');await fs.writeFile(path.join(root,'skill-registry.json'),'UNRELATED_NEW_SKILL');});
    const state=(globalThis as unknown as Record<symbol,{locks:Map<string,{waiters:Set<unknown>}>}>)[Symbol.for('canvas.workspace-mutation-lock.v1')];
    const deadline=Date.now()+3000;while((!state.locks.get(`${pluginLock}.lock`)?.waiters.size||!state.locks.get(`${skillLock}.lock`)?.waiters.size)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(state.locks.get(`${pluginLock}.lock`)?.waiters.size,1,'Observe the actual waiting plugin writer before releasing the filesystem finalizer.');
    assert.equal(state.locks.get(`${skillLock}.lock`)?.waiters.size,1,'Observe the actual waiting skill writer before releasing the filesystem finalizer.');
    assert.deepEqual(events,['commit-confirmed'],'The real kernel/local registry lock remains held after commit confirmation.');allowFinalize();
    await Promise.all([cleanup,writer,skillWriter]);assert.deepEqual(events.slice(0,2),['commit-confirmed','files-removed']);assert.deepEqual(events.slice(2).sort(),['next-plugin-writer','next-skill-writer']);assert.equal(await fs.readFile(path.join(parent,'2.0.0/manifest.json'),'utf8'),'NEW_UNRECEIPTED_VERSION');assert.equal(await fs.readFile(path.join(root,'skill-registry.json'),'utf8'),'UNRELATED_NEW_SKILL');
    console.log('PASS temporary cleanup guards: unknown commit preserves all bytes, unreceipted versions/changed bytes stop deletion, and both real registry locks span snapshot/confirmed commit through final removal.');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
