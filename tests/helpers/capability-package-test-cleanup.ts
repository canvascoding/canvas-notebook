import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type OwnedCapabilityPackageSourceDirectoryProof = {
  resolvedPath:string;parentPath:string;device:string;inode:string;mode:number;checksum:string;
};

export type OwnedCapabilityPackageFixture = {
  nonce:string;names:string[];actorIds:string[];adminId:string;organizationId:string;
  dataRoot:string;sourceDirectory:string;sourceName:string;initialChecksum:string;initialVersion:string;
  publications:Array<{resourceRef:string;revisionRef:string;checksum:string;version:string}>;
  resourceRevisions:Array<{resourceRef:string;metadataRevision:number;grantsRevision:number}>;
  sourceResourceRef?:string;
  initialManaged?:boolean;
  sourceDirectoryProof?:OwnedCapabilityPackageSourceDirectoryProof;
  preferences?:Array<{userId:string;resourceId:string;revision:number;enabled:boolean}>;
};

/** Failed cleanup keeps a private recovery receipt. Errors disclose its path only. */
export async function withPrivateCapabilityPackageCleanupReceipt(receipt:OwnedCapabilityPackageFixture,operation:(input:string)=>Promise<void>):Promise<void>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-package-cleanup-'));
  await fs.chmod(directory,0o700);
  const input=path.join(directory,'receipt.json');
  try{await fs.writeFile(input,JSON.stringify(receipt),{mode:0o600});await operation(input);}
  catch{throw new Error(`Owned package cleanup failed; private recovery receipt preserved at ${input}`);}
  await fs.rm(directory,{recursive:true,force:true});
}

/** The separate process loads server-only services; its input contains no credentials or arbitrary paths. */
export async function cleanupOwnedCapabilityPackageFixture(receipt:OwnedCapabilityPackageFixture):Promise<void> {
  await withPrivateCapabilityPackageCleanupReceipt(receipt,async input=>{
    await new Promise<void>((resolve,reject)=>{
      const process=spawn(processEnvNode(),['--conditions=react-server','--import','tsx','scripts/helpers/capability-package-cleanup.ts',input],{
        cwd:globalThis.process.cwd(),env:{...globalThis.process.env,NODE_ENV:'test'},stdio:['ignore','pipe','pipe'],
      });
      let output='';
      process.stdout?.on('data',chunk=>{output=(output+chunk.toString()).slice(-2048);});
      process.stderr?.on('data',()=>{});
      process.on('error',()=>reject(new Error('Owned package cleanup could not start.')));
      process.on('close',code=>code===0&&output.includes('OWNED_PACKAGE_CLEANUP_PASS')?resolve():reject(new Error('Owned package cleanup guard failed; fixture preserved.')));
    });
  });
}
function processEnvNode():string{return globalThis.process.execPath;}
