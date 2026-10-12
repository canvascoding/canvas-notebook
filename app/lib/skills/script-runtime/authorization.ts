import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  getAuthorizedCapabilityPackageRuntimeBindings, isHeldCapabilityPackageRuntimeBinding,
  type HeldCapabilityPackageRuntimeBinding,
} from '@/app/lib/capabilities/packages/runtime-bindings';
import { SkillScriptError, type AuthorizedSkillScript } from './contracts';
import { readSkillScriptManifest } from './manifest';

function scriptReference(binding:HeldCapabilityPackageRuntimeBinding,id:string):string{
  return `skill-script:v1:${createHash('sha256').update(JSON.stringify([binding.resourceId,binding.publishedRevisionRef,binding.childRelativeRoot,id])).digest('base64url')}`;
}

export async function listAuthorizedSkillScripts(context:AgentExecutionContext):Promise<AuthorizedSkillScript[]>{
  const captured={...context,skillPackageBindings:[...(context.skillPackageBindings??[])]};
  const bindings=await getAuthorizedCapabilityPackageRuntimeBindings(captured),scripts:AuthorizedSkillScript[]=[];
  for(const binding of bindings){
    if(!isHeldCapabilityPackageRuntimeBinding(binding,captured))continue;
    const packageRoot=await fs.realpath(path.dirname(binding.runtimePath)),loaded=await readSkillScriptManifest(packageRoot);
    if(!loaded)continue;
    for(const declaration of loaded.manifest.scripts)scripts.push(Object.freeze({scriptRef:scriptReference(binding,declaration.id),binding,
      declaration,packageRoot,entryPath:path.join(packageRoot,...declaration.path.split('/')),manifestChecksum:loaded.checksum}));
  }
  // Manifest parsing can await a schema worker. Recheck ACLs, agent selection
  // and full package bytes after that boundary before returning execution data.
  const current=new Set(await getAuthorizedCapabilityPackageRuntimeBindings(captured));
  return scripts.filter(script=>current.has(script.binding));
}

export async function authorizeSkillScript(context:AgentExecutionContext,scriptRef:string):Promise<AuthorizedSkillScript>{
  if(typeof scriptRef!=='string'||!/^skill-script:v1:[A-Za-z0-9_-]{43}$/u.test(scriptRef))throw new SkillScriptError('SCRIPT_NOT_FOUND','The selected skill script is unavailable.',404);
  const scripts=await listAuthorizedSkillScripts(context),matches=scripts.filter(script=>script.scriptRef===scriptRef);
  if(matches.length!==1)throw new SkillScriptError('SCRIPT_NOT_FOUND','The selected skill script is unavailable.',404);
  return matches[0];
}
