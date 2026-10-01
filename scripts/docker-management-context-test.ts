import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { createDefaultConfig, writeConfig } from '../cli/src/core/config';
import { createRuntimeContext } from '../cli/src/core/platform';
import { startManagedProcess } from '../cli/src/core/processLifecycle';

async function main() {
  if (process.platform === 'win32') return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-'));
  const socketPath = path.join(root, 'api.sock');
  const selector = path.join(root, 'selected');
  const context = createRuntimeContext({ NODE_ENV:'test', CANVAS_INSTALL_DIR:root });
  await writeConfig(createDefaultConfig(context.paths, context.platform));
  const sockets = new Set<Socket>();
  const starts: number[] = [0,0];
  const inputs: string[] = ['', ''];
  const servers: http.Server[] = [];
  for (let index = 0; index < 2; index += 1) {
    const server = http.createServer((req,res)=>{
      res.setHeader('content-type','application/json');
      if (req.url === '/version') res.end(JSON.stringify({ApiVersion:'1.54',MinAPIVersion:'1.40'}));
      else if (req.url?.endsWith('/exec')) { req.resume();res.writeHead(201);res.end(JSON.stringify({Id:'exec'})); }
      else res.end(JSON.stringify({Running:false,ExitCode:0}));
    });
    server.on('connection', socket=>{sockets.add(socket);socket.on('error',()=>undefined);socket.on('close',()=>sockets.delete(socket));});
    server.on('upgrade',(req,socket,head)=>{
      starts[index] += 1;
      let length = head.length;
      const size = Number(req.headers['content-length']);
      const ready = () => {
        socket.removeListener('data',read);req.removeListener('data',read);
        socket.on('data',chunk=>{inputs[index] += String(chunk);});
        socket.on('end',()=>socket.end());
        socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      };
      const read = (chunk:Buffer)=>{length += chunk.length;if(length >= size) ready();};
      if(length >= size) ready();else{socket.on('data',read);socket.resume();req.on('data',read);req.resume();}
    });
    await new Promise<void>(resolve=>server.listen(path.join(root,`docker${index}.sock`),resolve));
    servers.push(server);
  }
  const bin = path.join(root,'bin');await fs.mkdir(bin);
  await fs.writeFile(path.join(bin,'docker'), '#!/bin/sh\nif [ "$1" = context ]; then cat "$CANVAS_CONTEXT_SELECTOR"; elif [ "$1" = compose ]; then echo container; else exit 1; fi\n',{mode:0o700});
  const managed = startManagedProcess(process.execPath,[path.resolve('dist-cli/main.js'),'management-service','--no-banner'],{
    env:{...process.env,NODE_ENV:'test',PATH:`${bin}${path.delimiter}${process.env.PATH}`,CANVAS_INSTALL_DIR:root,CANVAS_NOTEBOOK_MANAGEMENT_SOCKET:socketPath,CANVAS_CONTEXT_SELECTOR:selector,DOCKER_HOST:'',DOCKER_CONTEXT:'',DOCKER_API_VERSION:'',CANVAS_DOCKER_ENGINE_API:''},
    stdio:['ignore','ignore','pipe'],timeoutMs:10_000,
  });
  let stderr = '';managed.child.stderr?.on('data',chunk=>{stderr += String(chunk);});
  const call = (route:string,body?:unknown) => new Promise<number>((resolve,reject)=>{
    const request = http.request({socketPath,path:route,method:body ? 'POST' : 'GET',headers:{'content-type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});
    request.on('error',reject);request.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    let ready = false;
    for (let attempt=0;attempt<30;attempt+=1){try{ready=await call('/v1/capabilities')===200;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));}
    assert(ready,stderr);
    for(let index=0;index<2;index+=1){
      await fs.writeFile(selector,JSON.stringify({Host:`unix://${path.join(root,`docker${index}.sock`)}`}));
      assert.equal(await call('/v1/admin/reset-password',{email:'admin@example.test',name:'Admin',password:'context-test-password'}),200);
    }
    assert.deepEqual(starts,[1,1]);assert.deepEqual(inputs,['context-test-password\n','context-test-password\n']);
    console.log('Management service: successive admin requests follow the selected Docker context without reusing the previous daemon');
  } finally {
    managed.stop();await managed.completion;
    for(const socket of sockets)socket.destroy();
    await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
    await fs.rm(root,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
