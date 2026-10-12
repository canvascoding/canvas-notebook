import 'server-only';

import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { normalizeCapabilityPackageRelativePath } from '@/app/lib/capabilities/packages/io';
import { cloneIntegrationArguments, validateIntegrationArguments, validateIntegrationSchema } from '@/app/lib/integration-tools/schema';
import {
  SKILL_SCRIPT_LIMITS as limits, SKILL_SCRIPT_MANIFEST_PATH, SkillScriptError,
  type SkillScriptManifest, type SkillScriptDeclaration,
} from './contracts';

function invalid():never{throw new SkillScriptError('SCRIPT_MANIFEST_INVALID','The skill script manifest is invalid.');}
const identifier=z.string().min(1).max(limits.idLength).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const toolName=z.string().min(1).max(256).refine(value=>value===value.trim()&&!/[\u0000-\u0020\u007f]/u.test(value));
const relative=z.string().min(1).max(limits.pathLength).refine(value=>{try{return normalizeCapabilityPackageRelativePath(value)===value;}catch{return false;}});

export function isStrictSkillScriptMinimumVersion(value:string):boolean{
  if(typeof value!=='string'||value.length>128)return false;
  const match=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  return Boolean(match&&!match[4]?.split('.').some(part=>/^[0-9]+$/u.test(part)&&part.length>1&&part.startsWith('0')));
}

const requirement=z.discriminatedUnion('kind',[
  z.object({alias:identifier,kind:z.literal('native'),toolName}).strict(),
  z.object({alias:identifier,kind:z.literal('integration'),source:z.enum(['mcp','composio']),
    application:z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/u).optional(),toolName}).strict(),
]);
const declaration=z.object({
  id:identifier,displayName:z.string().min(1).max(limits.displayNameLength).optional(),
  description:z.string().min(1).max(limits.descriptionLength).optional(),
  runtime:z.object({kind:z.enum(['node','python']),minimumVersion:z.string().refine(isStrictSkillScriptMinimumVersion).optional()}).strict(),
  path:relative,argumentsSchema:z.union([z.boolean(),z.record(z.string(),z.unknown())]),
  tools:z.array(requirement).max(limits.toolAliases),outputs:z.array(relative).max(limits.outputs),
  dependencies:z.array(z.object({kind:z.literal('bundled'),path:relative}).strict()).max(limits.dependencies).optional(),
}).strict();
const manifestSchema=z.object({version:z.literal(1),scripts:z.array(declaration).min(1).max(limits.scripts)}).strict();

function freezeJson<T>(value:T):T{
  if(value&&typeof value==='object'){for(const item of Object.values(value))freezeJson(item);Object.freeze(value);}
  return value;
}

async function exactRegularFile(root:string,relativePath:string):Promise<string>{
  const segments=normalizeCapabilityPackageRelativePath(relativePath).split('/');
  const rootStat=await fs.lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())invalid();
  let current=await fs.realpath(root);
  for(const[index,segment]of segments.entries()){
    current=path.join(current,segment);const stat=await fs.lstat(current);
    if(stat.isSymbolicLink()||(index===segments.length-1?(!stat.isFile()||stat.nlink!==1):!stat.isDirectory()))invalid();
  }
  return current;
}

/** Optional declarations are strict: malformed declarations never become an executable default. */
export async function parseSkillScriptManifest(value:unknown,packageRoot:string):Promise<SkillScriptManifest>{
  let snapshot:unknown;
  try{snapshot=cloneIntegrationArguments(value as Record<string,unknown>);}catch{invalid();}
  if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>limits.manifestBytes)throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED','The skill script manifest exceeds its size limit.',413);
  const parsed=manifestSchema.safeParse(snapshot);if(!parsed.success)invalid();
  const manifest=parsed.data;
  if(new Set(manifest.scripts.map(entry=>entry.id)).size!==manifest.scripts.length)invalid();
  for(const entry of manifest.scripts){
    if(new Set(entry.tools.map(tool=>tool.alias)).size!==entry.tools.length||new Set(entry.outputs).size!==entry.outputs.length
      ||new Set(entry.dependencies?.map(dependency=>dependency.path)).size!==(entry.dependencies?.length??0))invalid();
    try{await exactRegularFile(packageRoot,entry.path);for(const dependency of entry.dependencies??[])await exactRegularFile(packageRoot,dependency.path);}catch{invalid();}
    try{await validateIntegrationSchema(entry.argumentsSchema);}catch{throw new SkillScriptError('SCRIPT_SCHEMA_UNSUPPORTED','The skill script argument schema is unsupported.');}
  }
  return freezeJson(manifest);
}

export async function readSkillScriptManifest(packageRoot:string):Promise<{manifest:SkillScriptManifest;checksum:string}|null>{
  let manifestPath:string;
  try{manifestPath=await exactRegularFile(packageRoot,SKILL_SCRIPT_MANIFEST_PATH);}catch(error){
    if(error&&typeof error==='object'&&Reflect.get(error,'code')==='ENOENT')return null;
    invalid();
  }
  const handle=await fs.open(manifestPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)invalid();
    if(stat.size>limits.manifestBytes)throw new SkillScriptError('SCRIPT_LIMIT_EXCEEDED','The skill script manifest exceeds its size limit.',413);
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)invalid();offset+=read.bytesRead;}
    if((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead)invalid();
    const after=await handle.stat();if(after.size!==stat.size||after.ino!==stat.ino||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)invalid();
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
    return{manifest:await parseSkillScriptManifest(value,packageRoot),checksum:createHash('sha256').update(bytes).digest('hex')};
  }finally{await handle.close();}
}

export async function validateSkillScriptArguments(script:SkillScriptDeclaration,argumentsValue:unknown):Promise<void>{
  try{await validateIntegrationArguments(script.argumentsSchema,argumentsValue);}catch{throw new SkillScriptError('SCRIPT_ARGUMENTS_INVALID','Skill script arguments do not match the declared schema.');}
}
