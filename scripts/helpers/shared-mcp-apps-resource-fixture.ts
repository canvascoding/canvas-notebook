import { build } from 'esbuild';

/** Bundle the actual MCP App SDK locally; the sandbox needs no network or CDN. */
export async function createSharedMcpAppsResourceHtml(): Promise<string> {
  const result = await build({ bundle: true, write: false, platform: 'browser', format: 'iife', minify: true,
    stdin: { resolveDir: process.cwd(), sourcefile: 'shared-app-fixture.ts', contents: `
      import { App } from '@modelcontextprotocol/ext-apps';
      const app = new App({name:'Shared design fixture',version:'1.0.0'},{});
      const status=document.getElementById('status');
      const context=document.getElementById('context');
      const updateContext=(ctx)=>{
        document.body.dataset.theme=ctx?.theme||'light';
        context.textContent=JSON.stringify({theme:ctx?.theme,locale:ctx?.locale});
      };
      app.ontoolresult=(result)=>{
        document.getElementById('result').textContent=JSON.stringify(result.structuredContent);
        document.getElementById('meta').textContent=JSON.stringify(result._meta);
        const image=result.content?.find(block=>block.type==='image');
        if(image){const img=document.createElement('img');img.alt='Shared result image';img.src='data:'+image.mimeType+';base64,'+image.data;document.getElementById('image').replaceChildren(img);}
      };
      app.onhostcontextchanged=updateContext;
      document.getElementById('action').onclick=async()=>{
        status.textContent='Waiting for approval';
        try{const result=await app.callServerTool({name:'app_action',arguments:{value:'from-widget'}});status.textContent=result.isError?'Rejected':'Approved';}
        catch{status.textContent='Unavailable';}
      };
      document.getElementById('isolation').onclick=async()=>{
        let parentBlocked=false,storageBlocked=false,networkBlocked=false;
        try{void parent.document.body;}catch{parentBlocked=true;}
        try{localStorage.getItem('fixture');}catch{storageBlocked=true;}
        try{await fetch('http://127.0.0.1:3001/api/auth/get-session');}catch{networkBlocked=true;}
        document.getElementById('sandbox').textContent=JSON.stringify({parentBlocked,storageBlocked,networkBlocked});
      };
      app.connect().then(()=>{updateContext(app.getHostContext());status.textContent='Ready';}).catch(()=>{status.textContent='Unavailable';});
    ` } });
  const script = result.outputFiles[0].text.replace(/<\/script/giu, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shared design fixture</title>
    <style>body{margin:0;padding:16px;font:14px system-ui;background:#fff;color:#151515;overflow-wrap:anywhere}body[data-theme=dark]{background:#202020;color:#f3f3f3}h1{font-size:18px}button{min-height:44px;margin:4px;padding:8px 12px}pre{white-space:pre-wrap}img{height:24px;width:24px}</style></head>
    <body><h1>Shared design fixture</h1><p id="status">Starting</p><pre id="context"></pre><pre id="result"></pre><pre id="meta"></pre><div id="image"></div>
    <button id="action">Read selected design</button><button id="isolation">Check sandbox</button><pre id="sandbox"></pre><script>${script}</script></body></html>`;
}
