import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OwnedCapabilityPackageSourceDirectoryProof } from '../tests/helpers/capability-package-test-cleanup';
import { assertOwnedCapabilityPackageSourceDirectory,assertReceiptedCapabilityPackageVersionDirectories,
  runConfirmedCapabilityPackageCleanup } from '../tests/helpers/capability-package-cleanup-guards';

/** Real private filesystem only. No server, application database, host environment or managed DATA. */
async function main(){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-package-receipt-guard-'));
  await fs.chmod(temporary,0o700);
  const root=await fs.realpath(temporary),intake=path.join(root,'intake'),source=path.join(intake,'own-nonce-source');
  const container=path.join(root,'versions'),resourceRef='canvas-resource:11111111-1111-4111-8111-111111111111';
  const revision='22222222-2222-4222-8222-222222222222',orphan='33333333-3333-4333-8333-333333333333';
  const bytes=Buffer.from('OWNED_INITIAL_SOURCE'),checksum=createHash('sha256').update(bytes).digest('hex');
  const publication={resourceRef,revisionRef:`canvas-package-revision:${revision}`,checksum,version:'1.0.0'};
  let finalizers=0,lockHeld=false;
  const withLock=async<T,>(operation:()=>Promise<T>)=>{assert.equal(lockHeld,false);lockHeld=true;try{return await operation();}finally{lockHeld=false;}};
  const preserve=async(check:()=>Promise<unknown>)=>{
    const before=finalizers;
    await assert.rejects(()=>runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>{assert(lockHeld);await check();},
      finalize:async()=>{assert(lockHeld);finalizers++;}}));
    assert.equal(finalizers,before,'Rejected receipt checks cannot enter the destructive finalizer.');
  };
  try{
    await fs.mkdir(source,{recursive:true,mode:0o700});await fs.chmod(source,0o700);
    await fs.writeFile(path.join(source,'source.txt'),bytes);
    await fs.mkdir(path.join(container,revision),{recursive:true});
    const stat=await fs.lstat(source,{bigint:true});
    const proof:OwnedCapabilityPackageSourceDirectoryProof={resolvedPath:source,parentPath:intake,device:stat.dev.toString(),inode:stat.ino.toString(),mode:0o700,checksum};
    const sourceInput={sourceDirectory:source,initialChecksum:checksum,proof,configuredSourceRoot:intake};
    await assertOwnedCapabilityPackageSourceDirectory(sourceInput);
    assert.deepEqual(await assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication]),[revision]);

    await preserve(()=>assertOwnedCapabilityPackageSourceDirectory({...sourceInput,configuredSourceRoot:root}));
    await preserve(()=>assertOwnedCapabilityPackageSourceDirectory({...sourceInput,proof:{...proof,parentPath:root}}));
    await preserve(()=>assertOwnedCapabilityPackageSourceDirectory({...sourceInput,proof:{...proof,checksum:'a'.repeat(64)}}));
    await fs.chmod(source,0o755);await preserve(()=>assertOwnedCapabilityPackageSourceDirectory(sourceInput));await fs.chmod(source,0o700);

    const original=path.join(intake,'original');await fs.rename(source,original);
    await fs.mkdir(source,{mode:0o700});await fs.writeFile(path.join(source,'source.txt'),bytes);
    assert.deepEqual(await fs.readFile(path.join(source,'source.txt')),bytes,'Replacement deliberately keeps the same bytes.');
    await preserve(()=>assertOwnedCapabilityPackageSourceDirectory(sourceInput));
    await fs.rm(source,{recursive:true});await fs.symlink(original,source,'dir');
    await preserve(()=>assertOwnedCapabilityPackageSourceDirectory(sourceInput));
    assert.deepEqual(await fs.readFile(path.join(original,'source.txt')),bytes,'A symlink denial leaves the original source intact.');
    await fs.unlink(source);await fs.rename(original,source);
    await assertOwnedCapabilityPackageSourceDirectory(sourceInput);

    await fs.mkdir(path.join(container,orphan));
    await preserve(()=>assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication]));
    assert.deepEqual((await fs.readdir(container)).sort(),[revision,orphan].sort(),'Unreceipted orphan directory is preserved.');
    await fs.rmdir(path.join(container,orphan));await fs.rmdir(path.join(container,revision));
    await preserve(()=>assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication]));
    await preserve(()=>assertReceiptedCapabilityPackageVersionDirectories(path.join(root,'missing-container'),resourceRef,[publication]));
    await fs.mkdir(path.join(container,revision));
    await preserve(()=>assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication,publication]));
    await assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication,{...publication,resourceRef:'canvas-resource:44444444-4444-4444-8444-444444444444'}]);
    assert.deepEqual(await fs.readFile(path.join(source,'source.txt')),bytes);

    // A change after a confirmed non-destructive commit is rechecked before any deletion.
    let destructive=0;
    await assert.rejects(()=>runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>{await fs.mkdir(path.join(container,orphan));},
      finalize:async()=>{await assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication]);destructive++;}}));
    assert.equal(destructive,0);await fs.rmdir(path.join(container,orphan));
    await assert.rejects(()=>runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>{throw new Error('Unknown commit outcome');},finalize:async()=>{destructive++;}}));
    assert.equal(destructive,0);
    await runConfirmedCapabilityPackageCleanup({withLock,commit:async()=>{await assertOwnedCapabilityPackageSourceDirectory(sourceInput);
      await assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication]);},finalize:async()=>{
      assert(lockHeld);await assertOwnedCapabilityPackageSourceDirectory(sourceInput);
      await assertReceiptedCapabilityPackageVersionDirectories(container,resourceRef,[publication]);destructive++;
    }});
    assert.equal(destructive,1);assert.equal(finalizers,0);
    console.log('Cleanup receipt filesystem guards PASS: canonical private source/device/inode/mode, replaced/symlinked/wrong-parent preservation, exact per-resource revision sets, orphan/missing/duplicate denial and no finalizer after failed or unknown checks. No application DB or managed DATA used.');
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
