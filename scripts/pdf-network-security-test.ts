import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createPdfNetworkProxy } from '../app/lib/pdf/network-proxy';
import { resolvePublicNetworkAddress } from '../app/lib/security/safe-external-fetch';

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pdf-network-'));
  process.env.DATA = temporary;
  process.env.XDG_CACHE_HOME = temporary;
  process.env.CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB = '0';
  process.env.CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU = '0';
  let privateRequests = 0;
  const privateServer = http.createServer((_req, res) => { privateRequests++;res.end('PRIVATE'); });
  await new Promise<void>(resolve => privateServer.listen(0, '127.0.0.1', resolve));
  const privatePort = (privateServer.address() as net.AddressInfo).port;
  const forbidden = [
    `http://127.0.0.1:${privatePort}/`, 'http://127.0.0.1/', 'http://2130706433/',
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/',
    'http://localhost/', 'http://sub.localhost/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/', 'http://[2001::1]/',
    'http://[2001:db8::1]/', 'http://[3fff::1]/',
  ];
  let network: Awaited<ReturnType<typeof createPdfNetworkProxy>> | undefined;
  let renderer: typeof import('../app/lib/pdf/browser') | undefined;
  const puppeteer = createRequire(import.meta.url)('puppeteer-core').default as typeof import('puppeteer-core').default;
  const originalLaunch = puppeteer.launch;
  try {
    for (const url of forbidden) await assert.rejects(resolvePublicNetworkAddress(new URL(url)), url);
    network = await createPdfNetworkProxy();
    const proxy = new URL(network.contextOptions.proxyServer);
    for (const url of forbidden) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.get({ hostname: proxy.hostname, port: proxy.port, path: url }, response => { response.resume(); resolve(response.statusCode!); });
        request.on('error', reject);
      });
      assert.equal(status, 403, url);
    }
    for (const authority of ['127.0.0.1:443','169.254.169.254:443','[::1]:443','[64:ff9b::7f00:1]:443']) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request({ hostname: proxy.hostname, port: proxy.port, method:'CONNECT',path:authority });
        request.on('connect',(response,socket)=>{socket.destroy();resolve(response.statusCode!);});request.on('error',reject);request.end();
      });
      assert.equal(status,403,authority);
    }
    // DNS rebinding: the second lookup would return loopback. The HTTP proxy
    // must dial the first validated numeric address without looking up again.
    const lookup = dns.lookup;
    let calls = 0;
    const publicAddress = await lookup('www.w3.org', { family: 4 });
    dns.lookup = (async (...args: Parameters<typeof lookup>) => {
      if (args[0] === 'pdf-rebind.invalid') { calls++;return [{address:calls === 1 ? publicAddress.address : '127.0.0.1',family:4}]; }
      if (args[0] === 'pdf-mixed.invalid') return [{address:publicAddress.address,family:4},{address:'127.0.0.1',family:4}];
      return lookup(...args);
    }) as typeof lookup;
    try {
      await assert.rejects(resolvePublicNetworkAddress(new URL('https://pdf-mixed.invalid/')), /private or local/);
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ hostname: proxy.hostname, port: proxy.port, path:'http://pdf-rebind.invalid/' }, response => {
          response.resume();
          if (response.statusCode === 502) reject(new Error('The pinned public connection did not succeed'));
          else resolve();
        });
        request.on('error',reject);
      });
      assert.equal(calls,1,'proxy must not resolve again when opening the validated connection');
    } finally { dns.lookup = lookup; }

    // Disable only the independent browser LNA prompt so loopback attempts
    // actually reach our proxy. Its production policy and launch flags remain.
    const launch = originalLaunch.bind(puppeteer);
    puppeteer.launch = options => launch({...options,args:[...(options?.args||[]),'--disable-features=LocalNetworkAccessChecks']});
    renderer = await import('../app/lib/pdf/browser');
    const browser = await renderer.getBrowser();
    const context = await browser.createBrowserContext(network.contextOptions);
    const page = await context.newPage();
    await page.setContent(`<h1>Network boundary</h1><img id="public" src="https://www.w3.org/Icons/w3c_home.png"><img src="http://127.0.0.1:${privatePort}/image"><iframe src="http://127.0.0.1:${privatePort}/frame"></iframe>`);
    await page.waitForFunction(()=>{const i=document.getElementById('public') as HTMLImageElement;return i.complete && i.naturalWidth>0;},{timeout:20000});
    const result = await page.evaluate(async (target) => {
      const blocked = await fetch(target+'/fetch').then(()=>false,()=>true);
      const workerBlocked = await new Promise<boolean>((resolve,reject)=>{
        const worker=new Worker(URL.createObjectURL(new Blob([`fetch(${JSON.stringify(target+'/worker')}).then(()=>postMessage(false),()=>postMessage(true))`],{type:'text/javascript'})));
        worker.onmessage=e=>{resolve(e.data);worker.terminate();};worker.onerror=reject;
      });
      const websocketBlocked = await new Promise<boolean>(resolve=>{const s=new WebSocket(target.replace('http:','ws:')+'/socket');s.onerror=()=>resolve(true);s.onopen=()=>{s.close();resolve(false);};});
      return {blocked,workerBlocked,websocketBlocked};
    }, `http://127.0.0.1:${privatePort}`);
    assert.deepEqual(result,{blocked:true,workerBlocked:true,websocketBlocked:true});
    // A browser-followed redirect gets the same policy as an initial request.
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url() === 'https://pdf-redirect-fixture.invalid/') {
        void request.respond({status:302,headers:{location:`http://127.0.0.1:${privatePort}/redirect`}});
      } else void request.continue();
    });
    await page.goto('https://pdf-redirect-fixture.invalid/').catch(()=>undefined);
    assert.equal(privateRequests,0,'a redirect cannot open a private destination');
    await context.close();
    assert.equal(privateRequests,0,'no page, frame, worker or WebSocket request may reach private server');
    const pdf = await renderer.generatePdfFromHtml('<h1>Public image remains available</h1><img src="https://www.w3.org/Icons/w3c_home.png">');
    assert.equal(pdf.subarray(0,4).toString(),'%PDF');
    console.log(JSON.stringify({result:'ok',directCases:forbidden.length,connectCases:4,privateRequests,...result,publicImage:true,dnsPinned:true}));
  } finally {
    await renderer?.disposePdfBrowser('network security test complete');
    puppeteer.launch=originalLaunch;
    await network?.close();
    privateServer.closeAllConnections();
    await new Promise<void>(resolve=>privateServer.close(()=>resolve()));
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
