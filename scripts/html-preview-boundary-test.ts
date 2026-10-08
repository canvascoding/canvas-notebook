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
    const sameOriginMcp=await send(base+'/__preview/'+token+'/mcp-app/frame',{headers:{host:'app.example.test',cookie:'fixture'}});
    assert.equal(sameOriginMcp.status,200);
    assert.deepEqual(await sameOriginMcp.json(),{cookie:'fixture',authorization:null,internal:null});
    const sameOriginMcpPost=await send(base+'/__preview/'+token+'/mcp-app/frame',{method:'POST',headers:{host:'app.example.test'}});
    assert.equal(sameOriginMcpPost.status,404);await sameOriginMcpPost.arrayBuffer();
    const sameOriginGeneric=await send(base+'/__preview/'+token+'/index.html',{headers:{host:'app.example.test'}});
    assert.equal(sameOriginGeneric.status,404);await sameOriginGeneric.arrayBuffer();
    const sameOriginDocument=await send(base+'/__document-preview/'+token+'/index.html',{headers:{host:'app.example.test',cookie:'fixture','authorization':'Bearer fixture','x-canvas-internal-token':'fixture'}});
    assert.equal(sameOriginDocument.status,200);
    assert.deepEqual(await sameOriginDocument.json(),{cookie:null,authorization:null,internal:null});
    const sameOriginDocumentPost=await send(base+'/__document-preview/'+token+'/index.html',{method:'POST',headers:{host:'app.example.test'}});
    assert.equal(sameOriginDocumentPost.status,404);await sameOriginDocumentPost.arrayBuffer();
    const externalDocument=await send(base+'/__document-preview/'+token+'/index.html',{headers:{host:previewHost}});
    assert.equal(externalDocument.status,404);await externalDocument.arrayBuffer();
    for(const headers of [{origin:'https://'+previewHost},{origin:'null'},{cookie:'fixture','sec-fetch-site':'same-site'},{cookie:'fixture','sec-fetch-site':'cross-site'}]) {
      const response=await send(base+'/api/files/write',{method:'POST',headers:{host:'app.example.test',...headers}});
      assert.equal(response.status,403);await response.arrayBuffer();
    }
    // OAuth redirects carry the app's SameSite=Lax cookie even though the
    // navigation started at the provider (or the managed Control Plane).
    const callback='/api/composio/callback?flow='+'a'.repeat(43);
    const callbackHeaders={host:'app.example.test',cookie:'fixture'};
    for(const site of ['cross-site','same-site']) {
      for(const metadata of [{},{'sec-fetch-mode':'navigate','sec-fetch-dest':'document'}]) {
        const response=await send(base+callback,{headers:{...callbackHeaders,'sec-fetch-site':site,...metadata}});
        assert.equal(response.status,200,'OAuth navigation must reach the flow-state validator');
        await response.arrayBuffer();
      }
    }
    const desktopFlow='A'.repeat(43);
    const desktopCallback='/api/composio/shared/desktop/callback?'+new URLSearchParams({flow:desktopFlow,status:'success',connected_account_id:'ca_own_callback'});
    for(const site of ['cross-site','same-site']) {
      for(const metadata of [{},{'sec-fetch-mode':'navigate','sec-fetch-dest':'document'}]) {
        const response=await send(base+desktopCallback,{headers:{...callbackHeaders,'sec-fetch-site':site,...metadata}});
        assert.equal(response.status,200,'The genuine shared desktop document return with an app cookie must reach its collector');
        assert.deepEqual(await response.json(),{cookie:'fixture',authorization:null,internal:null});
      }
    }
    for(const query of [`flow=${desktopFlow}`,`flow=${desktopFlow}&status=failed`,`flow=${desktopFlow}&error=access_denied`,
      `flow=${desktopFlow}&status=failed&error=access_denied&connected_account_id=ca_own_callback`]) {
      const response=await send(base+'/api/composio/shared/desktop/callback?'+query,{headers:{...callbackHeaders,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
      assert.equal(response.status,200,'Legacy and failed shared desktop returns retain exact navigation access');await response.arrayBuffer();
    }
    for(const scenario of [
      {method:'POST',path:desktopCallback,headers:{}},{method:'HEAD',path:desktopCallback,headers:{}},
      {path:desktopCallback,headers:{'sec-fetch-mode':'cors','sec-fetch-dest':'empty'}},
      {path:desktopCallback,headers:{'sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'}},
      {path:desktopCallback,headers:{origin:'https://'+previewHost}},{path:desktopCallback,headers:{origin:'null'}},
      {path:'/api/composio/shared/desktop/callback/extra?flow='+desktopFlow,headers:{}},
      {path:'/api/composio/shared/desktop/callback?flow='+desktopFlow+'&flow='+desktopFlow,headers:{}},
      {path:'/api/composio/shared/desktop/callback?flow='+'B'.repeat(43),headers:{}},
      {path:'/api/composio/shared/desktop/callback?flow='+desktopFlow+'&status=success',headers:{}},
      {path:'/api/composio/shared/desktop/callback?flow='+desktopFlow+'&status=unknown',headers:{}},
      {path:'/api/composio/shared/desktop/callback?flow='+desktopFlow+'&connected_account_id=ca_own_callback',headers:{}},
      {path:desktopCallback+'&connected_account_id=other',headers:{}},{path:desktopCallback+'&error=access_denied',headers:{}},
      {path:desktopCallback+'&actor=fixture',headers:{}},
      {path:'/api/composio/shared/desktop/callback?'+new URLSearchParams({flow:desktopFlow,status:'success',connected_account_id:'ca own'}),headers:{}},
      {path:'/api/composio/shared/desktop/callback?'+new URLSearchParams({flow:desktopFlow,status:'success',connected_account_id:'a'.repeat(257)}),headers:{}},
    ]) {
      const response=await send(base+scenario.path,{method:scenario.method,headers:{...callbackHeaders,'sec-fetch-site':'cross-site',...scenario.headers}});
      assert.equal(response.status,403,'The shared desktop exception must not widen the cross-origin cookie boundary');await response.arrayBuffer();
    }
    const previewDesktop=await send(base+desktopCallback,{headers:{...callbackHeaders,host:previewHost,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
    assert.equal(previewDesktop.status,404);await previewDesktop.arrayBuffer();
    for(const scenario of [
      {method:'POST',path:callback,headers:{}},
      {method:'HEAD',path:callback,headers:{}},
      {path:callback,headers:{'sec-fetch-mode':'cors','sec-fetch-dest':'empty'}},
      {path:callback,headers:{'sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'}},
      {path:callback,headers:{origin:'https://'+previewHost}},
      {path:callback,headers:{origin:'null'}},
      {path:'/api/composio/callback/extra?flow='+'a'.repeat(43),headers:{}},
      {path:'/api/composio/connections',headers:{}},
      {path:'/api/files/list',headers:{}},
      {path:'/media/file',headers:{}},
    ]) {
      const response=await send(base+scenario.path,{method:scenario.method,headers:{...callbackHeaders,'sec-fetch-site':'cross-site',...scenario.headers}});
      assert.equal(response.status,403,'only the OAuth document navigation may bypass the cookie boundary');
      await response.arrayBuffer();
    }
    const previewCallback=await send(base+callback,{headers:{...callbackHeaders,host:previewHost,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}});
    assert.equal(previewCallback.status,404);await previewCallback.arrayBuffer();
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
