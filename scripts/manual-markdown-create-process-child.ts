import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import { NextRequest } from 'next/server';

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.CANVAS_TEST_NATIVE_TEXT_SESSION,'1');
  const descriptor=process.env.CANVAS_MANUAL_CREATE_CHILD;assert(descriptor);assert.equal((await fs.stat(descriptor)).mode&0o077,0);
  const input=JSON.parse(await fs.readFile(descriptor,'utf8')) as {url:string;headers:Record<string,string>;body:string};
  globalThis.fetch=async()=>{throw new Error('No network is permitted in the owned Create child.');};
  // TSX loads the actual app as CJS here. Hand its require calls the real
  // installed namespaces for packages whose exports allow import only.
  const installedModules=new Map<string,unknown>();
  for(const name of ['@earendil-works/pi-agent-core','@earendil-works/pi-ai','@earendil-works/pi-ai/compat','@earendil-works/pi-ai/oauth']){
    installedModules.set(name,await import(name));
  }
  const loader=Module as typeof Module & {_load:(name:string,parent:NodeModule|null,isMain:boolean)=>unknown};
  const previousLoad=loader._load;
  loader._load=(name,parent,isMain)=>installedModules.has(name)?installedModules.get(name):previousLoad(name,parent,isMain);
  try{
  const runtime=await import('../app/lib/db');const pool=runtime.getPostgresRuntimeQueryable();assert(pool);const backends=new Set<number>();
  pool.on('acquire',client=>backends.add(Number(Reflect.get(client,'processID'))));
  let status:number|undefined,body:Record<string,unknown>|undefined;
  try{const {POST}=await import('../app/api/files/create/route');
    assert(process.connected);process.send!('manual_create_ready');
    await new Promise<void>(resolve=>process.once('message',message=>{assert.equal(message,'manual_create_go');resolve();}));
    const response=await POST(new NextRequest(input.url,{method:'POST',headers:input.headers,body:input.body}));
    status=response.status;const value=await response.json();assert([200,409].includes(status));
    body={success:value.success};
    if(value.completion){const completion=value.completion;assert.deepEqual(Object.keys(completion).sort(),(completion.status==='completed'?['status','requestId','workspaceId','targetPath']:['status','requestId','workspaceId','targetPath','code']).sort());body.completion=completion;}
    if(value.code!==undefined){assert(['PATH_EXISTS','MARKDOWN_CREATE_PROJECTION_PENDING','MARKDOWN_CREATE_RECOVERY_REQUIRED','MARKDOWN_CREATE_NATIVE_UNAVAILABLE'].includes(value.code));body.code=value.code;}
  }finally{await pool.end();}
  console.log('MANUAL_CHILD_RESULT '+JSON.stringify({status,body,backends:[...backends]}));
  if(process.connected)process.disconnect!();
  }finally{loader._load=previousLoad;}
}
main().catch(error=>{console.error('Own manual child failed',{name:error instanceof Error?error.name:typeof error,code:error&&typeof error==='object'?Reflect.get(error,'code'):undefined});if(process.connected)process.disconnect!();process.exitCode=1;});
