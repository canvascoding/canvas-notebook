import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export async function assertExactCleanupChildren(directory:string,expected:readonly string[]):Promise<void>{
  assert.deepEqual((await fs.readdir(directory)).sort(),[...expected].sort(),'Unreceipted directory content must be preserved.');
}

/** No finalizer runs after a rejected/unknown SQL outcome; its entire lifetime stays in the caller's registry lock. */
export async function runConfirmedCapabilityPackageCleanup<T>(input:{
  withLock:(operation:()=>Promise<T>)=>Promise<T>;commit:()=>Promise<T>;finalize:()=>Promise<void>;
}):Promise<T>{
  return input.withLock(async()=>{const result=await input.commit();await input.finalize();return result;});
}
