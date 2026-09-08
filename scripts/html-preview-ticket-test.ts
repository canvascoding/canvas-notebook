import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-preview-ticket-'));
  process.env.DATA = temporary;
  process.env.CANVAS_DATA_ROOT = temporary;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  process.env.BASE_URL = 'http://localhost:3000';
  process.env.BETTER_AUTH_SECRET = 'preview-ticket-test-secret-at-least-32-characters';
  try {
    const {createInitialOwner} = await import('../app/lib/auth-setup');
    await createInitialOwner({name:'Preview Owner',email:'preview-owner@example.test',password:'PreviewFixture123!'});
    const {auth} = await import('../app/lib/auth');
    const response = await auth.handler(new Request('http://localhost:3000/api/auth/sign-in/email',{
      method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},
      body:JSON.stringify({email:'preview-owner@example.test',password:'PreviewFixture123!'}),
    }));
    assert.equal(response.status,200);
    const headers = new Headers({cookie:response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')});
    const session = await auth.api.getSession({headers});assert.ok(session);
    const {NextRequest} = await import('next/server');
    const {requireRequestPersonalWorkspace} = await import('../app/lib/workspaces/request');
    const resolved = await requireRequestPersonalWorkspace(new NextRequest('http://localhost:3000/api/files/list',{headers}));
    assert.equal(resolved.response,null);assert.ok(resolved.workspace);
    const workspace=resolved.workspace;
    await fs.mkdir(path.join(workspace.rootPath,'preview-fixture'),{recursive:true});
    await fs.writeFile(path.join(workspace.rootPath,'preview-fixture/index.html'),'<img src="image.svg"><script type="module" src="main.mjs"></script>');
    await fs.writeFile(path.join(workspace.rootPath,'preview-fixture/image.svg'),'<svg/>');
    await fs.writeFile(path.join(workspace.rootPath,'preview-fixture/main.mjs'),"fetch('./data.json');new Worker('./worker.js');");
    await fs.writeFile(path.join(workspace.rootPath,'preview-fixture/data.json'),'{}');
    await fs.writeFile(path.join(workspace.rootPath,'preview-fixture/worker.js'),'postMessage(true)');
    await fs.writeFile(path.join(workspace.rootPath,'private.txt'),'PRIVATE');
    const {issueHtmlPreviewTicket,resolveHtmlPreviewTicket,revokeHtmlPreviewTicket,HTML_PREVIEW_TICKET_TTL_MS} = await import('../app/lib/html-preview-ticket');
    const input={session,workspace,rootHtmlPath:'preview-fixture/index.html',kind:'workspace' as const};
    const issued=await issueHtmlPreviewTicket(input);
    for(const file of ['index.html','image.svg','main.mjs','data.json','worker.js']) assert.ok(await resolveHtmlPreviewTicket(issued.ticket,'preview-fixture/'+file));
    for(const file of ['private.txt','preview-fixture/unmentioned.json','../private.txt','preview-fixture/../private.txt']) assert.equal(await resolveHtmlPreviewTicket(issued.ticket,file),null,file);
    assert.equal(await resolveHtmlPreviewTicket('x'.repeat(43),'preview-fixture/index.html'),null);
    revokeHtmlPreviewTicket(issued.ticket);
    assert.equal(await resolveHtmlPreviewTicket(issued.ticket,'preview-fixture/index.html'),null);
    const expired=await issueHtmlPreviewTicket(input);
    const now=Date.now;
    try {
      Date.now=()=>now()+HTML_PREVIEW_TICKET_TTL_MS+1;
      assert.equal(await resolveHtmlPreviewTicket(expired.ticket,'preview-fixture/index.html'),null,'expired ticket cannot read');
    } finally { Date.now=now; }
    const disabled=await issueHtmlPreviewTicket(input);
    const {openDb}=await import('../app/lib/db');
    const database=await openDb();
    try {
      await database.run("UPDATE canvas_workspaces SET status='disabled' WHERE id=?",[workspace.workspaceId]);
      assert.equal(await resolveHtmlPreviewTicket(disabled.ticket,'preview-fixture/index.html'),null,'current workspace permission wins over issued snapshot');
      await database.run("UPDATE canvas_workspaces SET status='active' WHERE id=?",[workspace.workspaceId]);
    } finally { await database.close(); }
    assert.equal(await resolveHtmlPreviewTicket(disabled.ticket,'preview-fixture/index.html'),null,'revoked tickets stay revoked');
    const after=await issueHtmlPreviewTicket(input);
    await auth.handler(new Request('http://localhost:3000/api/auth/sign-out',{method:'POST',headers:new Headers([...headers,['origin','http://localhost:3000']])}));
    assert.equal(await resolveHtmlPreviewTicket(after.ticket,'preview-fixture/index.html'),null,'sign-out revokes document and asset authority immediately');
    assert.equal(await resolveHtmlPreviewTicket(after.ticket,'preview-fixture/image.svg'),null);
    console.log('HTML preview ticket tests passed (actual SQLite session revocation and restricted assets)');
  } finally { await fs.rm(temporary,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
