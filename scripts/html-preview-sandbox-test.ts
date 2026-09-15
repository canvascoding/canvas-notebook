import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from '@playwright/test';
import { rewriteHtmlPreviewDocument, rewriteHtmlPreviewScript } from '../app/lib/html-preview-assets';
import { HTML_PREVIEW_CSP } from '../app/lib/html-preview';

const ticket='a'.repeat(43);
const ticketRoot=`/__document-preview/${ticket}`;
const assetRoot=`${ticketRoot}/report/`;
const documentPath='/api/media/preview/report/index.html';
const documentCsp=HTML_PREVIEW_CSP.replace("base-uri 'self'","base-uri 'self' https:")+'; sandbox allow-scripts';

async function main() {
  const apiRequests: Array<{origin:string|undefined;cookie:string|undefined}>=[];
  const server=http.createServer((request,response)=>{
    const pathname=new URL(request.url||'/', 'http://localhost').pathname;
    if (pathname==='/') {
      response.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'session=fixture; Path=/; HttpOnly'});
      response.end(`<iframe sandbox="allow-scripts" src="${documentPath}"></iframe>`);
      return;
    }
    if (pathname.startsWith('/api/') && pathname!==documentPath) {
      apiRequests.push({origin:typeof request.headers.origin==='string' ? request.headers.origin : undefined,cookie:request.headers.cookie});
      response.writeHead(403,{'Content-Type':'application/json'});response.end('{"error":"blocked"}');return;
    }
    if (pathname===documentPath) {
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':documentCsp,'Referrer-Policy':'no-referrer'});
      response.end(rewriteHtmlPreviewDocument(
        '<!doctype html><link rel="stylesheet" href="style.css"><body data-ready="pending"><script type="module" src="main.mjs"></script></body>',
        'report/index.html',
        ticketRoot,
        {opaqueOrigin:true},
      ));
      return;
    }
    if (!pathname.startsWith(assetRoot)) { response.writeHead(404).end();return; }
    const asset=pathname.slice(assetRoot.length);
    const headers={'Access-Control-Allow-Origin':'null','Vary':'Origin'};
    if (asset==='style.css') { response.writeHead(200,{'Content-Type':'text/css',...headers});response.end('body{color:rgb(1, 2, 3)}');return; }
    if (asset==='data.json') { response.writeHead(200,{'Content-Type':'application/json',...headers});response.end('{"ok":true}');return; }
    if (asset==='module.mjs') { response.writeHead(200,{'Content-Type':'text/javascript',...headers});response.end('export const loaded=true;');return; }
    if (asset==='worker.mjs') { response.writeHead(200,{'Content-Type':'text/javascript',...headers});response.end(rewriteHtmlPreviewScript("importScripts('./worker-helper.js');fetch('./worker-data.json').then(response=>response.json()).then(data=>postMessage(data.ready?workerReady:'worker-failed'));",ticketRoot,'report/worker.mjs'));return; }
    if (asset==='worker-helper.js') { response.writeHead(200,{'Content-Type':'text/javascript',...headers});response.end('self.workerReady="worker-ready";');return; }
    if (asset==='worker-data.json') { response.writeHead(200,{'Content-Type':'application/json',...headers});response.end('{"ready":true}');return; }
    if (asset==='main.mjs') {
      response.writeHead(200,{'Content-Type':'text/javascript',...headers});
      response.end(`import {loaded} from './module.mjs';
const data=await fetch('./data.json').then(response=>response.json());
const worker=new Worker('./worker.mjs');
const workerReady=await new Promise(resolve=>{worker.addEventListener('message',event=>resolve(event.data),{once:true});worker.addEventListener('error',event=>resolve('worker-error:'+event.message),{once:true});setTimeout(()=>resolve('worker-timeout'),1000)});
let parent='open';try{window.parent.document.body}catch{parent='blocked'}
let storage='open';try{localStorage.getItem('session')}catch{storage='blocked'}
let cookie='open';try{cookie=document.cookie||'empty'}catch{cookie='blocked'}
let api='open';try{await fetch('/api/forbidden',{credentials:'include'})}catch{api='blocked'}
document.body.dataset.ready='true';document.body.dataset.worker=String(workerReady);
document.body.dataset.parent=parent;document.body.dataset.storage=storage;document.body.dataset.cookie=cookie;document.body.dataset.api=api;`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    const browserErrors: string[]=[];
    page.on('console',message=>{ if (message.type()==='error') browserErrors.push(message.text()); });
    page.on('pageerror',error=>browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    const frame=page.frames().find(candidate=>candidate.url().endsWith(documentPath));
    assert.ok(frame,'preview frame must load from the current app origin');
    try {
    await frame.waitForFunction(()=>document.body.dataset.ready==='true',undefined,{timeout:15_000});
    assert.equal(await frame.locator('body').getAttribute('data-worker'),'worker-ready');
    } catch (error) {
      throw new Error(`Preview did not become ready at ${frame.url()}: ${await frame.content()}; ${browserErrors.join(' | ')}`, {cause:error});
    }
    assert.equal(await frame.locator('body').getAttribute('data-parent'),'blocked');
    assert.equal(await frame.locator('body').getAttribute('data-storage'),'blocked');
    assert.ok(['empty','blocked'].includes(await frame.locator('body').getAttribute('data-cookie')||''));
    assert.equal(await frame.locator('body').getAttribute('data-api'),'blocked');
    assert.deepEqual(apiRequests,[{origin:'null',cookie:undefined}]);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
  console.log('Same-origin HTML preview sandbox tests passed');
}

main().catch(error=>{console.error(error);process.exitCode=1;});
