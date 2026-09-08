import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { PdfPreviewAccess } from '../app/lib/pdf/network-proxy';

const ROOT = '/api/media/preview/__workspace/pdf-fixture/fixture/';
const fixtureCookie = 'better-auth.session_token=pdf-fixture-only';
const artifactRoot = process.env.TEST_PDF_ARTIFACT_DIR;
const baseline = Boolean(process.env.TEST_PDF_BASELINE_PATH);
const requests: Array<{ url: string; cookie?: string; authorization?: string; workspace?: string; referer?: string }> = [];
const states: Array<{ prior: string | null; cookies: string }> = [];
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="90"><rect width="240" height="90" rx="14" fill="#246b9a"/><circle cx="55" cy="45" r="26" fill="#ffd67b"/></svg>';
let internalOrigin = '';
let externalOrigin = '';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
function end(response: ServerResponse, type: string, body: string | Buffer) { response.setHeader('Content-Type', type); response.end(body); }
function log(request: IncomingMessage) {
  requests.push({ url: `${request.headers.host}${request.url}`, cookie: request.headers.cookie, authorization: request.headers.authorization, workspace: request.headers['x-canvas-workspace-id'] as string | undefined, referer: request.headers.referer });
}
function document(who: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="${externalOrigin}/style.css"></head><body>
  <h1>Canvas PDF compatibility</h1><p>External font · relative assets · dynamic modules · emoji 🌍</p>
  <img width="240" height="90" src="${externalOrigin}/image.svg"><img width="240" height="90" src="local.svg">
  <img width="120" height="45" src="redirect.svg"><div class="background">CSS background</div><p id="dynamic">Loading module…</p>
  <script type="module" src="module.mjs"></script><script>
    const prior=localStorage.getItem('pdf-fixture');const cookies=document.cookie;
    localStorage.setItem('pdf-fixture',${JSON.stringify(who)});document.cookie='render-state='+${JSON.stringify(who)}+';path=/fixture-cookie-store';
    fetch('/api/private-probe').catch(()=>{});
    fetch(${JSON.stringify(externalOrigin + '/state')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prior,cookies})}).catch(()=>{});
  </script><section class="second"><h2>Second printed page</h2><p>Page breaks and print styles remain intact.</p></section></body></html>`;
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pdf-security-'));
  process.env.DATA = temporary;
  process.env.CANVAS_DATA_ROOT = temporary;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.BETTER_AUTH_SECRET ||= 'pdf-security-test-secret-000000000000000';
  process.env.CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB = '0';
  process.env.CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU = '0';
  const font = await fs.readFile(path.join(process.cwd(), 'public/excalidraw/fonts/Assistant/Assistant-Regular.woff2'));
  const external = createServer(async (req, res) => {
    log(req); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/font.woff2') return end(res, 'font/woff2', font);
    if (url.pathname === '/style.css') return end(res, 'text/css', `@font-face{font-family:Fixture;src:url('${externalOrigin}/font.woff2')}body{font:18px Fixture,sans-serif;color:#172e46}h1{color:#246b9a}.background{background:url('${externalOrigin}/background.svg') no-repeat;width:240px;height:90px;color:white;padding:16px}.second{break-before:page}@media print{h1{font-size:30px}}`);
    if (url.pathname === '/state') { let body='';for await(const chunk of req) body+=chunk;states.push(JSON.parse(body));res.end('ok');return; }
    if (url.pathname.endsWith('.svg')) return setTimeout(() => end(res, 'image/svg+xml', image), 60);
    res.writeHead(404);res.end();
  });
  const internal = createServer((req, res) => {
    log(req); const url = new URL(req.url || '/', 'http://localhost');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname === '/api/private-probe') { end(res,'application/json','{}');return; }
    if (!url.pathname.startsWith(ROOT) || req.headers.cookie !== fixtureCookie) {res.writeHead(401);res.end();return;}
    if (url.pathname.endsWith('redirect.svg')) {res.writeHead(302,{Location:externalOrigin+'/redirect-target.svg'});res.end();return;}
    if (url.pathname.endsWith('.html')) {
      // A session refresh response must not widen subsequent request authority.
      res.setHeader('Set-Cookie', `${fixtureCookie}; HttpOnly; Path=/; SameSite=Lax`);
      return end(res,'text/html; charset=utf-8',document(url.searchParams.get('who') || 'A'));
    }
    if (url.pathname.endsWith('local.svg')) return end(res,'image/svg+xml',image);
    if (url.pathname.endsWith('module.mjs')) return end(res,'text/javascript',`const data=await fetch('./data.json').then(r=>r.json());document.getElementById('dynamic').textContent=data.message;`);
    if (url.pathname.endsWith('data.json')) return end(res,'application/json',JSON.stringify({message:'Local module and JSON loaded'}));
    res.writeHead(404);res.end();
  });
  let renderer: typeof import('../app/lib/pdf/browser') | undefined;
  let restoreBrowserLaunch: (() => void) | undefined;
  try {
    externalOrigin = await listen(external); internalOrigin = await listen(internal);
    const preview: PdfPreviewAccess = {
      url:'http://canvas-document.invalid'+ROOT+'file.html',
      pathPrefix:ROOT.slice(0,-1),
      async load(url) {
        assert.equal(url.origin,'http://canvas-document.invalid');
        assert.ok(url.pathname.startsWith(ROOT));
        // This recording fixture models a server-owned document provider. The
        // production provider reads a restricted ticket; it sends no cookie.
        return fetch(internalOrigin+url.pathname+url.search,{headers:{cookie:fixtureCookie},redirect:'manual'});
      },
    };

    renderer = process.env.TEST_PDF_BASELINE_PATH
      ? await import(pathToFileURL(process.env.TEST_PDF_BASELINE_PATH).href)
      : await import('../app/lib/pdf/browser');
    // These servers deliberately use loopback for credential-safe captures.
    // Isolate the credential layer by replacing only this test browser's proxy
    // configuration. The separate pdf-network-security suite exercises actual
    // production proxy options, workers, frames and DNS pinning end to end.
    const puppeteer = createRequire(import.meta.url)('puppeteer-core').default as typeof import('puppeteer-core').default;
    const originalLaunch = puppeteer.launch;
    restoreBrowserLaunch = () => { puppeteer.launch = originalLaunch; };
    const launch = originalLaunch.bind(puppeteer);
    puppeteer.launch = async options => {
      const browser = await launch({ ...options, args: [
        ...(options?.args || []).filter(arg => !arg.startsWith('--proxy-') && !arg.startsWith('--host-resolver-rules=')),
        '--disable-features=LocalNetworkAccessChecks',
      ] });
      const createContext = browser.createBrowserContext.bind(browser);
      browser.createBrowserContext = options => createContext({...options,proxyBypassList:['127.0.0.1','localhost','[::1]']});
      return browser;
    };
    for (const who of ['A','B']) {
      const pdf = await renderer!.generatePdfFromUrl((baseline ? internalOrigin+ROOT+'file.html' : preview.url) + '?who=' + who,
        (baseline ? { cookie: fixtureCookie } : preview) as PdfPreviewAccess);
      assert.match(pdf.subarray(0,4).toString(), /%PDF/);
      if (artifactRoot) { await fs.mkdir(artifactRoot,{recursive:true});await fs.writeFile(path.join(artifactRoot,`${baseline?'before':'after'}-${who}.pdf`),pdf); }
      if (!baseline) {
        assert.equal((await renderer!.getBrowser()).browserContexts().length,1,'completed export must close its entire context');
        assert.deepEqual(await (await renderer!.getBrowser()).defaultBrowserContext().cookies(),[],'document cookies cannot enter the shared browser context');
      }
    }
    const remote = requests.filter(request => request.url.startsWith(new URL(externalOrigin).host));
    for (const suffix of ['/image.svg','/background.svg','/style.css','/font.woff2','/redirect-target.svg']) {
      assert.ok(remote.some(request => request.url.endsWith(suffix)), `${suffix} must still load`);
    }
    assert.equal(states.length,2);
    if (baseline) {
      assert.ok(remote.some(request=>request.cookie===fixtureCookie),'baseline must reproduce credential leak');
      assert.equal(states[1].prior,'A','baseline must reproduce shared storage');
    } else {
      assert.deepEqual(remote.filter(request=>request.cookie||request.authorization||request.workspace||request.referer?.startsWith(internalOrigin)).map(request=>({url:request.url,cookie:Boolean(request.cookie),authorization:Boolean(request.authorization),workspace:Boolean(request.workspace),internalReferer:request.referer?.startsWith(internalOrigin)})),[],'external resources and redirects must not receive app credentials or internal document referrers');
      assert.ok(requests.filter(request=>request.url.endsWith('/api/private-probe')).every(request=>!request.cookie),'other app APIs receive no session');
      assert.deepEqual(states,[{prior:null,cookies:''},{prior:null,cookies:''}],'sequential accounts cannot inherit cookies or storage');
      await assert.rejects(renderer!.generatePdfFromUrl('http://127.0.0.1:1/failure'));
      assert.equal((await renderer!.getBrowser()).browserContexts().length,1,'failed export must close its context');
      const htmlPdf = await renderer!.generatePdfFromHtml('<h1>Isolated HTML PDF</h1>');
      assert.match(htmlPdf.subarray(0,4).toString(), /%PDF/);
      assert.equal((await renderer!.getBrowser()).browserContexts().length,1,'HTML export also closes its context');
      if (process.env.TEST_PDF_TIMEOUT === '1') {
        await assert.rejects(renderer!.generatePdfFromHtml('<script>while(true){}</script>'), /PDF_TIMEOUT|timed out/i);
        assert.equal((await renderer!.getBrowser()).browserContexts().length,1,'timed-out export cannot retain a context');
      }
    }
    console.log(JSON.stringify({test:'pdf-security',baseline,requests:requests.length,externalResources:remote.length,isolated:!baseline}));
  } finally {
    await renderer?.disposePdfBrowser('PDF security test complete');
    restoreBrowserLaunch?.();
    for (const server of [internal,external]) {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
