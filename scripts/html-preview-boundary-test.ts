import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getCookies } from 'better-auth/cookies';
import { canvasAuthCookieOptions, getCanvasSessionCookie } from '../app/lib/auth-cookie';
import { handleHtmlPreviewBoundary } from '../server/html-preview-boundary';

async function main() {
  process.env.BETTER_AUTH_BASE_URL='https://app.example.test';
  const cookies=getCookies({baseURL:process.env.BETTER_AUTH_BASE_URL,advanced:{...canvasAuthCookieOptions(),defaultCookieAttributes:{secure:true,sameSite:'lax'}}});
  assert.equal(cookies.sessionToken.name,'__Host-better-auth.session_token');
  assert.equal(cookies.sessionToken.attributes.secure,true);
  assert.equal(cookies.sessionToken.attributes.httpOnly,true);
  assert.equal(cookies.sessionToken.attributes.path,'/');
  assert.equal(cookies.sessionToken.attributes.domain,undefined);
  assert.equal(getCanvasSessionCookie(new Headers({cookie:'__Secure-better-auth.session_token=legacy'})),null);
  assert.equal(getCanvasSessionCookie(new Headers({cookie:'__Host-better-auth.session_token=fixture'})),'fixture');
  const server=http.createServer((req,res)=>{
    if(handleHtmlPreviewBoundary(req,res)) return;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({cookie:req.headers.cookie||null,authorization:req.headers.authorization||null,internal:req.headers['x-canvas-internal-token']||null}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  // Node's fetch deliberately overwrites Host; use the HTTP client to exercise
  // the vhost boundary with the actual header a reverse proxy forwards.
  const send=(url:string,options:{method?:string;headers?:Record<string,string|undefined>}={})=>new Promise<{status:number;json():Promise<unknown>;arrayBuffer():Promise<Buffer>}>((resolve,reject)=>{
    const request=http.request(url,options,response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>{const body=Buffer.concat(chunks);resolve({status:response.statusCode!,json:async()=>JSON.parse(body.toString()),arrayBuffer:async()=>body});});
      response.on('error',reject);
    });
    request.on('error',reject);request.end();
  });
  try {
    const previewHost='preview.app.example.test';
    const token='a'.repeat(43);
    const allowed=await send(base+'/__preview/'+token+'/index.html',{headers:{host:previewHost,cookie:'fixture','authorization':'Bearer fixture','x-canvas-internal-token':'fixture'}});
    assert.equal(allowed.status,200);
    assert.deepEqual(await allowed.json(),{cookie:null,authorization:null,internal:null});
    for(const route of ['/api/auth/get-session','/api/files/list','/api/health','/de/notebook','/media/file','/']) {
      const response=await send(base+route,{headers:{host:previewHost}});assert.equal(response.status,404,route);await response.arrayBuffer();
    }
    const post=await send(base+'/__preview/'+token+'/index.html',{method:'POST',headers:{host:previewHost}});
    assert.equal(post.status,404);await post.arrayBuffer();
    for(const headers of [{origin:'https://'+previewHost},{origin:'null'},{cookie:'fixture','sec-fetch-site':'same-site'},{cookie:'fixture','sec-fetch-site':'cross-site'}]) {
      const response=await send(base+'/api/files/write',{method:'POST',headers:{host:'app.example.test',...headers}});
      assert.equal(response.status,403);await response.arrayBuffer();
    }
    const wrongHost=await send(base+'/__preview/'+token+'/index.html',{headers:{host:'app.example.test'}});
    assert.equal(wrongHost.status,404);await wrongHost.arrayBuffer();
    for(const configured of ['https://app.example.test','http://192.0.2.1']) {
      process.env.BETTER_AUTH_BASE_URL=configured;
      const response=await send(base+'/api/health',{headers:{host:'app.example.test'}});
      assert.equal(response.status,200,'ordinary anonymous API access must survive absent Origin and optional preview configuration');await response.arrayBuffer();
    }
    console.log('HTML preview HTTP and cookie boundary tests passed');
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
