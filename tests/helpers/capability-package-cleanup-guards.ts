import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { OwnedCapabilityPackageFixture,OwnedCapabilityPackageSourceDirectoryProof } from './capability-package-test-cleanup';

/** Test-only source provenance. A receipt cannot redirect cleanup to a copied or replaced intake root. */
export async function assertOwnedCapabilityPackageSourceDirectory(input:{
  sourceDirectory:string;initialChecksum:string;proof:OwnedCapabilityPackageSourceDirectoryProof;configuredSourceRoot:string|undefined;
}):Promise<void>{
  assert(input.configuredSourceRoot,'The configured fixture intake root is required.');
  const stat=await fs.lstat(input.sourceDirectory,{bigint:true});
  assert(stat.isDirectory()&&!stat.isSymbolicLink(),'The receipted source must remain a real directory.');
  const source=await fs.realpath(input.sourceDirectory),parent=await fs.realpath(input.configuredSourceRoot);
  assert.equal(source,input.sourceDirectory,'The receipted source path must be canonical.');
  assert.equal(source,input.proof.resolvedPath,'The source receipt cannot select another path.');
  assert.equal(path.dirname(source),parent,'The source must remain under the configured intake root.');
  assert.equal(parent,input.proof.parentPath,'The configured intake root must match the original receipt.');
  assert.equal(stat.dev.toString(),input.proof.device,'The source device changed; preserve it.');
  assert.equal(stat.ino.toString(),input.proof.inode,'The source inode changed; preserve it.');
  assert.equal(Number(stat.mode&BigInt(0o777)),0o700,'The private source directory mode changed; preserve it.');
  assert.equal(input.proof.mode,0o700,'The original source receipt must be private.');
  assert.match(input.initialChecksum,/^[a-f0-9]{64}$/u);
  assert.equal(input.proof.checksum,input.initialChecksum,'The source receipt must bind the complete initial checksum.');
}

/** A version container is removable only when every directory belongs to an exact publication receipt. */
export async function assertReceiptedCapabilityPackageVersionDirectories(directory:string,resourceRef:string,
  publications:readonly OwnedCapabilityPackageFixture['publications'][number][]):Promise<string[]>{
  assert.match(resourceRef,/^canvas-resource:[a-f0-9-]{36}$/u);
  const expected=publications.filter(publication=>publication.resourceRef===resourceRef).map(publication=>{
    assert.match(publication.revisionRef,/^canvas-package-revision:[a-f0-9-]{36}$/u);
    return publication.revisionRef.slice('canvas-package-revision:'.length);
  });
  assert.equal(new Set(expected).size,expected.length,'Duplicate publication receipts cannot authorize deletion.');
  const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat)assert(stat.isDirectory()&&!stat.isSymbolicLink(),'The version container must remain a real directory.');
  const children=stat?await fs.readdir(directory):[];
  assert.deepEqual([...children].sort(),[...expected].sort(),'Missing or unreceipted version directories must be preserved.');
  return children;
}

export async function assertExactCleanupChildren(directory:string,expected:readonly string[]):Promise<void>{
  assert.deepEqual((await fs.readdir(directory)).sort(),[...expected].sort(),'Unreceipted directory content must be preserved.');
}

/** No finalizer runs after a rejected/unknown SQL outcome; its entire lifetime stays in the caller's registry lock. */
export async function runConfirmedCapabilityPackageCleanup<T>(input:{
  withLock:(operation:()=>Promise<T>)=>Promise<T>;commit:()=>Promise<T>;finalize:()=>Promise<void>;
}):Promise<T>{
  return input.withLock(async()=>{const result=await input.commit();await input.finalize();return result;});
}
