import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSkillScriptManifest,readSkillScriptManifest,validateSkillScriptArguments,isStrictSkillScriptMinimumVersion } from '../app/lib/skills/script-runtime/manifest';
import { SKILL_SCRIPT_LIMITS,SkillScriptError,isSkillScriptError } from '../app/lib/skills/script-runtime/contracts';

async function main(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-script-manifest-'));
  try{
    await fs.mkdir(path.join(root,'scripts'));await fs.mkdir(path.join(root,'.canvas-skill'));
    await fs.writeFile(path.join(root,'scripts/main.js'),'process.stdout.write("declared");\n');await fs.writeFile(path.join(root,'scripts/util.js'),'module.exports={};\n');
    const value={version:1,scripts:[{id:'render',runtime:{kind:'node',minimumVersion:'22.0.0'},path:'scripts/main.js',
      argumentsSchema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',additionalProperties:false,
        properties:{input:{$ref:'#/$defs/input'}},required:['input'],$defs:{input:{type:'object',properties:{width:{type:'integer',minimum:1}},required:['width'],additionalProperties:false}}},
      tools:[{alias:'mail.draft',kind:'native',toolName:'email_create_outbox_draft'},{alias:'design.export',kind:'integration',source:'composio',application:'canva',toolName:'CANVA_EXPORT_DESIGN'}],
      outputs:['images/result.png'],dependencies:[{kind:'bundled',path:'scripts/util.js'}]}]};
    const parsed=await parseSkillScriptManifest(value,root);assert(Object.isFrozen(parsed.scripts[0].argumentsSchema));assert.equal(parsed.scripts[0].tools.length,2);
    const args={input:{width:42}};await validateSkillScriptArguments(parsed.scripts[0],args);assert.deepEqual(args,{input:{width:42}});
    for(const wrong of[{input:{width:'42'}},{input:{width:0}},{input:{width:42,extra:true}},{input:{width:42},extra:true}])await assert.rejects(()=>validateSkillScriptArguments(parsed.scripts[0],wrong),{code:'SCRIPT_ARGUMENTS_INVALID'});
    const generic=await parseSkillScriptManifest({...value,scripts:[{...value.scripts[0],argumentsSchema:true}]},root);await validateSkillScriptArguments(generic.scripts[0],{anything:true});
    const never=await parseSkillScriptManifest({...value,scripts:[{...value.scripts[0],argumentsSchema:false}]},root);await assert.rejects(()=>validateSkillScriptArguments(never.scripts[0],{}),{code:'SCRIPT_ARGUMENTS_INVALID'});
    for(const change of[{egress:'all'},{install:'npm install'},{scripts:Array.from({length:17},(_,index)=>({...value.scripts[0],id:`run-${index}`}))}])await assert.rejects(()=>parseSkillScriptManifest({...value,...change},root),{code:'SCRIPT_MANIFEST_INVALID'});
    for(const change of[{path:'../escape'},{path:'/absolute'},{path:'scripts\\main.js'},{path:'scripts/missing.js'},
      {runtime:{kind:'sh'}},{runtime:{kind:'node',minimumVersion:'>=22.0.0'}},{runtime:{kind:'node',minimumVersion:'01.2.3'}},
      {tools:[{alias:'duplicate',kind:'native',toolName:'read'},{alias:'duplicate',kind:'native',toolName:'write'}]},
      {tools:Array.from({length:17},(_,index)=>({alias:`tool-${index}`,kind:'native',toolName:'read'}))},
      {dependencies:[{kind:'pip',path:'requirements.txt'}]},{dependencies:[{kind:'bundled',path:'scripts'}]},
      {outputs:['result.txt','result.txt']},{outputs:['../outside']},{argumentsSchema:{type:'object',unknownValidation:true}},
      {argumentsSchema:{$ref:'https://outside.example.test/schema.json'}},{argumentsSchema:{$schema:'https://outside.example.test/dialect'}}]){
      await assert.rejects(()=>parseSkillScriptManifest({...value,scripts:[{...value.scripts[0],...change}]},root),error=>isSkillScriptError(error));
    }
    await assert.rejects(()=>parseSkillScriptManifest({...value,scripts:[value.scripts[0],value.scripts[0]]},root),{code:'SCRIPT_MANIFEST_INVALID'});
    await fs.symlink(path.join(root,'scripts/main.js'),path.join(root,'scripts/link.js'));await assert.rejects(()=>parseSkillScriptManifest({...value,scripts:[{...value.scripts[0],path:'scripts/link.js'}]},root),{code:'SCRIPT_MANIFEST_INVALID'});await fs.unlink(path.join(root,'scripts/link.js'));
    await fs.link(path.join(root,'scripts/main.js'),path.join(root,'scripts/hard.js'));await assert.rejects(()=>parseSkillScriptManifest(value,root),{code:'SCRIPT_MANIFEST_INVALID'});await fs.unlink(path.join(root,'scripts/hard.js'));
    assert(isStrictSkillScriptMinimumVersion('3.11.9'));assert(isStrictSkillScriptMinimumVersion('22.0.0-rc.1+fixture'));assert(!isStrictSkillScriptMinimumVersion('22.0.0-01'));assert(!isStrictSkillScriptMinimumVersion('22'));
    assert.equal(await readSkillScriptManifest(root),null);
    const text=JSON.stringify(value);await fs.writeFile(path.join(root,'.canvas-skill/runtime.json'),text);
    assert.equal((await readSkillScriptManifest(root))!.checksum,createHash('sha256').update(text).digest('hex'));
    await fs.writeFile(path.join(root,'.canvas-skill/runtime.json'),'x'.repeat(SKILL_SCRIPT_LIMITS.manifestBytes+1));await assert.rejects(()=>readSkillScriptManifest(root),{code:'SCRIPT_LIMIT_EXCEEDED'});
    await fs.writeFile(path.join(root,'.canvas-skill/runtime.json'),'{invalid');await assert.rejects(()=>readSkillScriptManifest(root),{code:'SCRIPT_MANIFEST_INVALID'});
    const error=new SkillScriptError('SCRIPT_MANIFEST_INVALID','Static failure');assert(isSkillScriptError(error));assert(!isSkillScriptError(JSON.parse(JSON.stringify(error))));
    console.log('PASS strict skill script declarations: schemas/arguments, bounded manifests, no install/egress fields, exact entry/dependency files, unsafe paths/links, immutable metadata and raw-byte checksum.');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
