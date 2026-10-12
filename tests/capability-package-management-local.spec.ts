import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect,test,type APIResponse,type BrowserContext,type Page,type Response,type TestInfo} from '@playwright/test';
import {createAuthenticatedContext,runManagedTestPreflight} from './helpers/managed-test-context';
import {cleanupOwnedCapabilityPackageFixture,type OwnedCapabilityPackageFixture} from './helpers/capability-package-test-cleanup';
import type {CapabilityPackageDescriptor,CapabilityPackageDraft,CapabilityPackagePublishedRevision,CapabilityPackageState} from '../app/lib/capabilities/packages/contracts';
import type {CapabilityResourceDescriptor} from '../app/lib/capabilities/resources/contracts';
import type {ClientWorkspaceSummary} from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

const nonce=randomBytes(5).toString('hex'),name=`package-editor-qa-${nonce}`;
const variants={organization:`package-editor-qa-org-${nonce}`,team:`package-editor-qa-team-${nonce}`};
const labels=en.skills.packageEditor;
let admin:BrowserContext,member:BrowserContext,adminPage:Page,memberPage:Page;
let receipt:OwnedCapabilityPackageFixture|undefined,resourceRef='',legacy='',teamId='',memberId='';
let sourceDirectory:string|undefined,artifactRoot='',ownedTeam:ClientWorkspaceSummary|undefined,ownedTeamMembers:string|undefined;
const drafts=new Set<string>();
test.use({trace:'off',video:'off'});

async function payload<T>(response:Pick<APIResponse,'ok'|'status'|'json'>|Pick<Response,'ok'|'status'|'json'>,phase:string):Promise<T>{
  if(!response.ok())throw new Error(`${phase} returned HTTP ${response.status()}.`);return await response.json() as T;
}
const pkg=(suffix:string)=>`/api/capabilities/packages${suffix}`;
async function resource(ref=resourceRef,context=admin):Promise<CapabilityResourceDescriptor>{return(await payload<{data:{resource:CapabilityResourceDescriptor}}>(await context.request.get(`/api/capabilities/resources/${encodeURIComponent(ref)}`),'Owned resource inspection')).data.resource;}
async function open(page:Page,expanded=true){
  const hydration=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/workspaces'&&response.request().method()==='GET');
  await page.goto(`/en/plugins?${new URLSearchParams({view:'installed',scope:'organization',plugin:name,source:'installed',resourceId:legacy})}`,{waitUntil:'domcontentloaded'});
  const workspaces=(await payload<{workspaces:ClientWorkspaceSummary[]}>(await hydration,'Actual workspace hydration')).workspaces.filter(workspace=>workspace.status==='active');
  await expect.poll(async()=>{const active=await page.evaluate(()=>localStorage.getItem('canvas.activeWorkspaceId'));return workspaces.some(workspace=>workspace.id===active);}).toBe(true);
  const section=page.getByTestId('package-editor');await expect(section).toBeVisible();
  const disclosure=section.locator('summary').filter({hasText:labels.title});
  if(expanded){await disclosure.click();await expect(section.getByTestId('package-reload')).toBeEnabled();await expect(section.getByText(labels.loading,{exact:true})).toHaveCount(0);}
  return section;
}
async function begin(page:Page,operation:'edit'|'fork'='edit',target?:'organization'|'team'){
  const section=page.getByTestId('package-editor');
  if(operation==='fork'){
    await section.locator('summary').filter({hasText:labels.createVariant}).click();
    await section.getByTestId('package-variant-name').fill(variants[target!]);
    await section.getByTestId('package-variant-scope').selectOption(target==='team'?`team:${teamId}`:'organization');
  }
  const response=page.waitForResponse(value=>new URL(value.url()).pathname===pkg('/drafts')&&value.request().method()==='POST'&&value.request().postDataJSON()?.operation===operation);
  await section.getByTestId(operation==='edit'?'package-create-edit':'package-create-fork').click();
  const draft=(await payload<{data:{draft:CapabilityPackageDraft}}>(await response,'UI private draft creation')).data.draft;
  drafts.add(draft.draftRef);await expect(section.getByTestId('package-validate')).toBeEnabled();return draft;
}
async function chooseFile(page:Page,file:string){
  const response=page.waitForResponse(value=>new URL(value.url()).pathname.endsWith('/file')&&new URL(value.url()).searchParams.get('path')===file&&value.request().method()==='GET');
  await page.getByTestId('package-file-picker').selectOption(file);await payload(await response,'UI complete package file read');
  await expect(page.getByTestId('package-file-content')).toBeVisible();
}
async function save(page:Page,draft:CapabilityPackageDraft,text:string){
  await page.getByTestId('package-file-content').fill(text);
  const response=page.waitForResponse(value=>new URL(value.url()).pathname===pkg(`/drafts/${encodeURIComponent(draft.draftRef)}/file`)&&value.request().method()==='PUT');
  await page.getByTestId('package-save-file').click();
  const updated=(await payload<{data:{draft:CapabilityPackageDraft}}>(await response,'UI draft file save')).data.draft;
  await expect(page.getByTestId('package-validate')).toBeEnabled();return updated;
}
async function publish(page:Page,draft:CapabilityPackageDraft){
  const validateResponse=page.waitForResponse(value=>new URL(value.url()).pathname.endsWith(`/${encodeURIComponent(draft.draftRef)}/validate`)&&value.request().method()==='POST');
  await page.getByTestId('package-validate').click();await payload(await validateResponse,'UI full package validation');
  await expect(page.getByTestId('package-publish')).toBeEnabled();
  const response=page.waitForResponse(value=>new URL(value.url()).pathname.endsWith(`/${encodeURIComponent(draft.draftRef)}/publish`)&&value.request().method()==='POST');
  await page.getByTestId('package-publish').click();
  const result=(await payload<{data:{state:CapabilityPackageState;published:CapabilityPackagePublishedRevision}}>(await response,'UI immutable publication')).data;
  receipt!.publications.push({resourceRef:result.state.resourceRef,revisionRef:result.published.revisionRef,checksum:result.published.checksum,version:result.published.version});
  if(!receipt!.resourceRevisions.some(value=>value.resourceRef===result.state.resourceRef))receipt!.resourceRevisions.push({resourceRef:result.state.resourceRef,metadataRevision:1,grantsRevision:1});
  drafts.delete(draft.draftRef);await expect(page.getByTestId('package-publish')).toHaveCount(0);return result;
}
async function screenshot(page:Page,info:TestInfo,label:string){const file=path.join(artifactRoot,`${label}.png`);await page.screenshot({path:file,fullPage:true,animations:'disabled'});await info.attach(label,{path:file,contentType:'image/png'});}

test.describe('Actual complete package editor, private drafts and immutable versions',()=>{
  test.describe.configure({mode:'serial',timeout:180_000,retries:0});
  test.beforeAll(async({browser})=>{
    const intake=process.env.CAPABILITY_PACKAGE_E2E_SOURCE_ROOT||process.env.CAPABILITY_RESOURCE_E2E_SOURCE_ROOT;
    const email=process.env.TEST_SECONDARY_EMAIL||process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL,password=process.env.TEST_SECONDARY_PASSWORD||process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    if(!intake||!path.isAbsolute(intake)||!process.env.DATA||!email||!password)throw new Error('Actual managed DATA, intake directory and secondary credentials are required; no acceptance skip.');
    admin=await createAuthenticatedContext(browser,{viewport:{width:1280,height:900}});await runManagedTestPreflight(admin);
    member=await createAuthenticatedContext(browser,{viewport:{width:1280,height:900}},{email,password});await runManagedTestPreflight(member);
    const adminIdentity=await payload<{user:{id:string}}>(await admin.request.get('/api/auth/get-session'),'Actual admin identity');
    const memberIdentity=await payload<{user:{id:string;role?:string}}>(await member.request.get('/api/auth/get-session'),'Actual editor identity');
    memberId=memberIdentity.user.id;expect(memberIdentity.user.role).not.toBe('admin');
    const listing=(await payload<{workspaces:ClientWorkspaceSummary[]}>(await admin.request.get('/api/workspaces'),'Actual scopes')).workspaces;
    let team=listing.find(workspace=>workspace.type==='team'&&workspace.status==='active');
    if(!team){team=(await payload<{workspace:ClientWorkspaceSummary}>(await admin.request.post('/api/workspaces',{data:{type:'team',name:`Package editor QA ${nonce}`,description:`Owned package fixture ${nonce}`}}),'Owned team creation')).workspace;ownedTeam=team;
      ownedTeamMembers=JSON.stringify((await payload<{members:unknown[]}>(await admin.request.get(`/api/workspaces/${team.id}/members`),'Owned team membership')).members);}
    teamId=team.id;
    artifactRoot=await fs.mkdtemp(path.join(os.tmpdir(),`canvas-package-browser-${nonce}-`));
    await fs.mkdir(intake,{recursive:true});sourceDirectory=await fs.mkdtemp(path.join(intake,`${name}-`));
    const child=`package-ui-context-${nonce}`;
    await fs.mkdir(path.join(sourceDirectory,'.canvas-plugin'));await fs.mkdir(path.join(sourceDirectory,'skills',child,'scripts'),{recursive:true});await fs.mkdir(path.join(sourceDirectory,'assets'));
    await fs.writeFile(path.join(sourceDirectory,'.canvas-plugin/plugin.json'),JSON.stringify({name,version:'1.0.0',description:'Owned complete package editor acceptance',skills:'skills'}));
    await fs.writeFile(path.join(sourceDirectory,'skills',child,'SKILL.md'),`---\nname: ${child}\ndescription: Complete package editor context\nmetadata:\n  version: "1.0.0"\n---\nRead the bundled script and asset.\n`);
    await fs.writeFile(path.join(sourceDirectory,'skills',child,'scripts/run.js'),'process.stdout.write("INITIAL_PACKAGE_UI");\n');await fs.writeFile(path.join(sourceDirectory,'assets/icon.bin'),Buffer.from([0,255,128,12]));
    const installed=await payload<{success:boolean;plugin:{resourceId:string;name:string;checksum:string;version:string}}>(await admin.request.post('/api/plugins/install',{data:{sourcePath:sourceDirectory,scope:'organization',enable:true,replace:false}}),'Actual package installation');
    expect(installed.success).toBe(true);expect(installed.plugin.name).toBe(name);legacy=installed.plugin.resourceId;
    const initial=await resource(legacy);expect(initial.metadata.ownership.type).toBe('organization');
    const organizationId=initial.metadata.ownership.type==='organization'?initial.metadata.ownership.organizationId:'';
    receipt={nonce,names:[name,variants.organization,variants.team],actorIds:[adminIdentity.user.id,memberId],adminId:adminIdentity.user.id,organizationId,
      dataRoot:await fs.realpath(process.env.DATA),sourceDirectory,sourceName:name,initialChecksum:installed.plugin.checksum,initialVersion:installed.plugin.version,publications:[],resourceRevisions:[]};
    const configured=(await payload<{data:{resource:CapabilityResourceDescriptor}}>(await admin.request.post(`/api/capabilities/resources/${encodeURIComponent(legacy)}`,{data:{
      expectedMetadataRevision:0,expectedGrantsRevision:0,ownership:{type:'team',workspaceId:teamId},accessMode:'restricted',grants:[{targetType:'user',targetId:memberId,canUse:false,canEdit:true,canManage:false}],
    }}),'Actual package editor grant')).data.resource;resourceRef=configured.metadata.resourceRef;
    receipt.resourceRevisions.push({resourceRef,metadataRevision:configured.metadata.metadataRevision,grantsRevision:configured.metadata.grantsRevision});
    receipt.sourceResourceRef=resourceRef;
    adminPage=await admin.newPage();memberPage=await member.newPage();
  });
  test.afterAll(async()=>{
    const failures:unknown[]=[];
    for(const page of [adminPage,memberPage])if(page)await page.close().catch(error=>failures.push(error));
    if(receipt){try{await cleanupOwnedCapabilityPackageFixture(receipt);}catch(error){failures.push(error);}}
    if(ownedTeam&&failures.length===0){try{const listing=(await payload<{workspaces:ClientWorkspaceSummary[]}>(await admin.request.get('/api/workspaces'),'Owned team cleanup snapshot')).workspaces;expect(listing.find(workspace=>workspace.id===ownedTeam!.id)).toEqual(ownedTeam);
      const memberships=JSON.stringify((await payload<{members:unknown[]}>(await admin.request.get(`/api/workspaces/${ownedTeam.id}/members`),'Owned team cleanup membership')).members);expect(memberships).toBe(ownedTeamMembers);
      await payload(await admin.request.delete(`/api/workspaces/${ownedTeam.id}`),'Owned team cleanup');}catch(error){failures.push(error);}}
    for(const context of [admin,member])if(context)await context.close().catch(error=>failures.push(error));
    if(failures.length)throw new AggregateError(failures,'Owned package fixture cleanup failed; preserve unmatched resources.');
  });
  test('editor saves full package text/assets, handles real stale CAS, and keeps published v1 after v2',async()=>{
    await open(memberPage);let draft=await begin(memberPage);expect(draft.actorUserId).toBe(memberId);
    expect((await admin.request.get(pkg(`/drafts/${encodeURIComponent(draft.draftRef)}`))).status(),'Organization management does not expose another creator draft.').toBe(404);
    const script=`skills/package-ui-context-${nonce}/scripts/run.js`;await chooseFile(memberPage,script);
    const cleanReload='process.stdout.write("CLEAN_RELOAD_FROM_OTHER_CLIENT");\n';
    const cleanSaved=(await payload<{data:{draft:CapabilityPackageDraft}}>(await member.request.put(pkg(`/drafts/${encodeURIComponent(draft.draftRef)}/file`),{data:{expectedDraftRevision:draft.draftRevision,path:script,encoding:'base64',content:Buffer.from(cleanReload).toString('base64')}}),'Concurrent clean creator save')).data.draft;
    await memberPage.route(url=>url.pathname===pkg(`/drafts/${encodeURIComponent(draft.draftRef)}/file`)&&url.searchParams.get('path')===script,
      route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,code:'PACKAGE_SNAPSHOT_UNAVAILABLE',error:'Temporary file read unavailable.'})}),{times:1});
    const unavailable=memberPage.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname.endsWith('/file')&&response.status()===503);
    await memberPage.getByTestId('package-reload').click();expect((await unavailable).status()).toBe(503);await expect(memberPage.getByTestId('package-reload')).toBeEnabled();
    const transportLocal='process.stdout.write("LOCAL_AFTER_FAILED_RELOAD");\n';await memberPage.getByTestId('package-file-content').fill(transportLocal);
    const staleAfterReadFailure=memberPage.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/file'));
    await memberPage.getByTestId('package-save-file').click();expect((await staleAfterReadFailure).status()).toBe(409);await expect(memberPage.getByTestId('package-file-content')).toHaveValue(transportLocal);
    await memberPage.getByTestId('package-reload').click();await expect(memberPage.getByTestId('package-reload')).toBeEnabled();await expect(memberPage.getByTestId('package-file-content')).toHaveValue(transportLocal);draft=cleanSaved;
    // A clean reader separately proves reload paints current saved text.
    await memberPage.getByTestId('package-file-content').fill(cleanReload);
    const nextClean='process.stdout.write("CLEAN_RELOAD_LATEST_REVISION");\n';
    draft=(await payload<{data:{draft:CapabilityPackageDraft}}>(await member.request.put(pkg(`/drafts/${encodeURIComponent(draft.draftRef)}/file`),{data:{expectedDraftRevision:cleanSaved.draftRevision,path:script,encoding:'base64',content:Buffer.from(nextClean).toString('base64')}}),'Another real clean creator save')).data.draft;
    await memberPage.getByTestId('package-reload').click();await expect(memberPage.getByTestId('package-file-content')).toHaveValue(nextClean);
    const unsaved='process.stdout.write("UI_UNSAVED_AFTER_CONFLICT");\n';await memberPage.getByTestId('package-file-content').fill(unsaved);
    const otherSaved=(await payload<{data:{draft:CapabilityPackageDraft}}>(await member.request.put(pkg(`/drafts/${encodeURIComponent(draft.draftRef)}/file`),{data:{expectedDraftRevision:draft.draftRevision,path:script,encoding:'base64',content:Buffer.from('process.stdout.write("OTHER_CLIENT");\n').toString('base64')}}),'Concurrent real creator save')).data.draft;
    const conflict=memberPage.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/file'));
    await memberPage.getByTestId('package-save-file').click();expect((await conflict).status()).toBe(409);await expect(memberPage.getByText(labels.conflict,{exact:true})).toBeVisible();await expect(memberPage.getByTestId('package-file-content')).toHaveValue(unsaved);
    await memberPage.getByTestId('package-reload').click();await expect(memberPage.getByTestId('package-reload')).toBeEnabled();
    const binarySaved=(await payload<{data:{draft:CapabilityPackageDraft}}>(await member.request.put(pkg(`/drafts/${encodeURIComponent(draft.draftRef)}/file`),{data:{expectedDraftRevision:otherSaved.draftRevision,path:script,encoding:'base64',content:Buffer.from([0,255,128,12]).toString('base64')}}),'Concurrent selected-file binary replacement')).data.draft;
    await memberPage.getByTestId('package-reload').click();await expect(memberPage.getByTestId('package-reload')).toBeEnabled();await expect(memberPage.getByText(labels.conflict,{exact:true})).toBeVisible();await expect(memberPage.getByTestId('package-file-content')).toHaveValue(unsaved);
    const binaryConflict=memberPage.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/file'));
    await memberPage.getByTestId('package-save-file').click();expect((await binaryConflict).status()).toBe(409);await expect(memberPage.getByTestId('package-file-content')).toHaveValue(unsaved);
    const restored=(await payload<{data:{draft:CapabilityPackageDraft}}>(await member.request.put(pkg(`/drafts/${encodeURIComponent(draft.draftRef)}/file`),{data:{expectedDraftRevision:binarySaved.draftRevision,path:script,encoding:'base64',content:Buffer.from('process.stdout.write("OTHER_CLIENT");\n').toString('base64')}}),'Restore exact selected script after binary conflict')).data.draft;
    await memberPage.getByTestId('package-reload').click();await expect(memberPage.getByTestId('package-reload')).toBeEnabled();await expect(memberPage.getByTestId('package-file-content')).toHaveValue(unsaved);draft=await save(memberPage,restored,unsaved);
    await chooseFile(memberPage,'.canvas-plugin/plugin.json');const manifest=JSON.parse(await memberPage.getByTestId('package-file-content').inputValue()) as Record<string,unknown>;draft=await save(memberPage,draft,JSON.stringify({...manifest,version:'1.1.0'},null,2));
    const upload=memberPage.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname.endsWith('/file')&&response.request().postDataJSON()?.path==='assets/upload.bin');
    await memberPage.getByTestId('package-upload-path').fill('assets/upload.bin');await memberPage.getByTestId('package-upload-input').setInputFiles({name:'upload.bin',mimeType:'application/octet-stream',buffer:Buffer.from([0,255,128,23,44])});
    draft=(await payload<{data:{draft:CapabilityPackageDraft}}>(await upload,'UI binary upload')).data.draft;await expect(memberPage.getByTestId('package-validate')).toBeEnabled();
    const first=await publish(memberPage,draft);expect(first.published.version).toBe('1.1.0');
    expect((await resource()).access.canUse).toBe(false);expect((await resource(resourceRef,member)).access).toEqual({canRead:true,canUse:false,canEdit:true,canManage:false});
    await open(memberPage);draft=await begin(memberPage);await chooseFile(memberPage,script);draft=await save(memberPage,draft,'process.stdout.write("PUBLISHED_VERSION_TWO");\n');
    await chooseFile(memberPage,'.canvas-plugin/plugin.json');const nextManifest=JSON.parse(await memberPage.getByTestId('package-file-content').inputValue()) as Record<string,unknown>;draft=await save(memberPage,draft,JSON.stringify({...nextManifest,version:'1.2.0'},null,2));
    const second=await publish(memberPage,draft);expect(second.state.packageRevision).toBe(2);
    const old=(await payload<{data:{file:{content:string}}}>(await member.request.get(pkg(`/${encodeURIComponent(resourceRef)}/file?${new URLSearchParams({path:script,revisionRef:first.published.revisionRef})}`)),'Pinned v1 read')).data.file;
    expect(Buffer.from(old.content,'base64').toString()).toBe(unsaved);
    const asset=(await payload<{data:{file:{content:string}}}>(await member.request.get(pkg(`/${encodeURIComponent(resourceRef)}/file?path=assets%2Fupload.bin`)),'Published binary read')).data.file;
    expect(Buffer.from(asset.content,'base64')).toEqual(Buffer.from([0,255,128,23,44]));
  });
  test('organization and team variants remain separate, restricted and disabled',async()=>{
    const original=await resource();
    const originalPackage=(await payload<{data:{package:CapabilityPackageDescriptor}}>(await admin.request.get(pkg(`/${encodeURIComponent(resourceRef)}`)),'Original package head before variant activation')).data.package;
    for(const target of ['organization','team'] as const){await open(adminPage);let draft=await begin(adminPage,'fork',target);
      expect((await admin.request.get(`/api/capabilities/resources/${encodeURIComponent(draft.resourceRef)}`)).status()).toBe(404);
      await chooseFile(adminPage,'.canvas-plugin/plugin.json');const manifest=JSON.parse(await adminPage.getByTestId('package-file-content').inputValue()) as Record<string,unknown>;draft=await save(adminPage,draft,JSON.stringify({...manifest,name:variants[target]},null,2));
      const published=await publish(adminPage,draft);const variant=await resource(published.state.resourceRef);
      expect(variant.metadata.ownership.type).toBe(target);expect(variant.metadata.accessMode).toBe('restricted');expect(variant.grants).toEqual([]);expect(variant.access.canUse).toBe(false);expect(variant.activation?.enabled).toBe(false);
      expect((await member.request.get(`/api/capabilities/resources/${encodeURIComponent(published.state.resourceRef)}`)).status()).toBe(404);
      const script=`skills/package-ui-context-${nonce}/scripts/run.js`;const bytes=(await payload<{data:{file:{content:string}}}>(await admin.request.get(pkg(`/${encodeURIComponent(published.state.resourceRef)}/file?${new URLSearchParams({path:script})}`)),'Complete fork script read')).data.file;
      expect(Buffer.from(bytes.content,'base64').toString()).toContain('PUBLISHED_VERSION_TWO');
      if(target==='organization'){
        const before=(await payload<{data:{package:CapabilityPackageDescriptor}}>(await admin.request.get(pkg(`/${encodeURIComponent(published.state.resourceRef)}`)),'Fork activation baseline')).data.package;
        const hydration=adminPage.waitForResponse(response=>new URL(response.url()).pathname==='/api/workspaces'&&response.request().method()==='GET');
        await adminPage.getByTestId('package-editor').getByRole('link',{name:labels.openVariant.replace('{name}',variants.organization),exact:true}).click();
        await adminPage.waitForURL(url=>url.searchParams.get('plugin')===variants.organization);const hydrated=(await payload<{workspaces:ClientWorkspaceSummary[]}>(await hydration,'Actual variant workspace hydration')).workspaces.filter(workspace=>workspace.status==='active');
        await expect.poll(async()=>{const active=await adminPage.evaluate(()=>localStorage.getItem('canvas.activeWorkspaceId'));return hydrated.some(workspace=>workspace.id===active);}).toBe(true);
        const section=adminPage.getByTestId('package-editor');await expect(section).toBeVisible();await section.locator('summary').filter({hasText:labels.title}).click();
        const activation=section.getByTestId('package-default-activation');await expect(activation).toHaveAttribute('aria-checked','false');
        for(const enabled of[true,false]){
          const patch=adminPage.waitForResponse(response=>new URL(response.url()).pathname===pkg(`/${encodeURIComponent(variant.artifact.resourceId)}/activation`)&&response.request().method()==='PATCH');
          await activation.click();const response=await patch;expect(response.request().postDataJSON().enabled).toBe(enabled);
          const activationResult=(await payload<{data:{enabled:boolean;resourceRef:string;publishedRevisionRef:string}}>(response,'Actual fork activation PATCH')).data;
          expect(activationResult.enabled).toBe(enabled);expect(activationResult.resourceRef).toBe(published.state.resourceRef);expect(activationResult.publishedRevisionRef).toBe(published.published.revisionRef);await expect(activation).toHaveAttribute('aria-checked',String(enabled));
          const after=(await payload<{data:{package:CapabilityPackageDescriptor}}>(await admin.request.get(pkg(`/${encodeURIComponent(published.state.resourceRef)}`)),'Fork activation state comparison')).data.package;
          expect(after.defaultEnabled).toBe(enabled);expect(after.resource).toEqual(before.resource);expect(after.access).toEqual(before.access);expect(after.access.canUse).toBe(false);expect(after.state).toEqual(before.state);expect(after.published).toEqual(before.published);
          const actualResource=await resource(published.state.resourceRef);expect(actualResource.grants).toEqual([]);expect(actualResource.metadata).toEqual(variant.metadata);
          const sourceHead=(await payload<{data:{package:CapabilityPackageDescriptor}}>(await admin.request.get(pkg(`/${encodeURIComponent(resourceRef)}`)),'Unchanged source head after fork activation')).data.package;
          expect(sourceHead.state).toEqual(originalPackage.state);expect(sourceHead.published).toEqual(originalPackage.published);
        }
      }
    }expect((await resource()).metadata).toEqual(original.metadata);expect((await resource()).grants).toEqual(original.grants);
  });
  test('collapsed and active editor controls fit light/dark desktop and mobile',async({},info)=>{
    await open(memberPage);const draft=await begin(memberPage);expect(drafts.has(draft.draftRef)).toBe(true);
    for(const [width,theme]of[[1280,'light'],[1280,'dark'],[390,'light'],[390,'dark']]as const){await memberPage.setViewportSize({width,height:900});await memberPage.evaluate(value=>localStorage.setItem('theme',value),theme);
      await open(memberPage,false);expect(await memberPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await screenshot(memberPage,info,`collapsed-${width}-${theme}`);
      await memberPage.getByTestId('package-editor').locator('summary').filter({hasText:labels.title}).click();await expect(memberPage.getByTestId('package-validate')).toBeEnabled();
      await chooseFile(memberPage,`skills/package-ui-context-${nonce}/scripts/run.js`);await memberPage.getByTestId('package-file-content').fill('process.stdout.write("RESPONSIVE_UNSAVED_DRAFT");\n');
      const saveControl=memberPage.getByTestId('package-save-file');await expect(saveControl).toBeEnabled();await saveControl.scrollIntoViewIfNeeded();const bounds=await saveControl.boundingBox();expect(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=901).toBe(true);
      const dialog=memberPage.getByRole('dialog').filter({has:memberPage.getByTestId('package-editor')});expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await screenshot(memberPage,info,`editor-${width}-${theme}`);
    }
  });
  test('revoked creator recovers only own draft status and discards after live reload',async()=>{
    const own=(await payload<{data:{status:{draftRef:string;draftRevision:number}}}>(await member.request.get(pkg(`/drafts/${encodeURIComponent([...drafts][0])}/status`)),'Own recovery status')).data.status;
    const before=await resource();
    if(!before.grants)throw new Error('The actual fixture manager must receive the original grant inputs.');
    const grantInput=before.grants.map(({targetType,targetId,canUse,canEdit,canManage})=>({targetType,targetId,canUse,canEdit,canManage}));
    let revoked:CapabilityResourceDescriptor|undefined;
    try{
      revoked=(await payload<{data:{resource:CapabilityResourceDescriptor}}>(await admin.request.patch(`/api/capabilities/resources/${encodeURIComponent(resourceRef)}`,{data:{expectedMetadataRevision:before.metadata.metadataRevision,expectedGrantsRevision:before.metadata.grantsRevision,grants:[{targetType:'user',targetId:memberId,canUse:true,canEdit:false,canManage:false}]}}),'Revoke actual editing while retaining published use')).data.resource;
      const tracked=receipt!.resourceRevisions.find(value=>value.resourceRef===resourceRef)!;tracked.metadataRevision=revoked.metadata.metadataRevision;tracked.grantsRevision=revoked.metadata.grantsRevision;expect(tracked.grantsRevision).toBe(2);
      expect((await admin.request.get(pkg(`/drafts/${encodeURIComponent(own.draftRef)}/status`))).status()).toBe(404);
      const published=(await payload<{data:{package:CapabilityPackageDescriptor}}>(await member.request.get(pkg(`/${encodeURIComponent(resourceRef)}`)),'Published inspection remains available after edit revocation')).data.package;
      expect(published.access).toEqual({canRead:true,canUse:true,canEdit:false,canManage:false});
      expect((await member.request.get(pkg(`/drafts/${encodeURIComponent(own.draftRef)}/tree`))).status()).toBe(403);
      const status=(await payload<{data:{status:{draftRef:string;draftRevision:number}}}>(await member.request.get(pkg(`/drafts/${encodeURIComponent(own.draftRef)}/status`)),'Creator-only recovery remains available after edit revocation')).data.status;expect(status).toEqual(expect.objectContaining(own));
      const deniedSave=memberPage.waitForResponse(response=>new URL(response.url()).pathname===pkg(`/drafts/${encodeURIComponent(own.draftRef)}/file`)&&response.request().method()==='PUT');
      await memberPage.getByTestId('package-save-file').click();expect((await deniedSave).status()).toBe(403);
      await expect(memberPage.getByTestId('package-discard')).toBeEnabled();await expect(memberPage.getByTestId('package-file-content')).toHaveCount(0);await expect(memberPage.getByTestId('package-publish')).toHaveCount(0);
      await memberPage.getByTestId('package-reload').click();await expect(memberPage.getByTestId('package-discard')).toBeEnabled();await expect(memberPage.getByTestId('package-file-content')).toHaveCount(0);await expect(memberPage.getByTestId('package-publish')).toHaveCount(0);
      const discard=memberPage.waitForResponse(response=>new URL(response.url()).pathname===pkg(`/drafts/${encodeURIComponent(own.draftRef)}`)&&response.request().method()==='DELETE');
      await memberPage.getByTestId('package-discard').click();await payload(await discard,'Revoked creator cleanup');drafts.delete(own.draftRef);
      expect((await member.request.get(pkg(`/drafts/${encodeURIComponent(own.draftRef)}/status`))).status()).toBe(404);
    }finally{
      if(revoked){const restored=(await payload<{data:{resource:CapabilityResourceDescriptor}}>(await admin.request.patch(`/api/capabilities/resources/${encodeURIComponent(resourceRef)}`,{data:{expectedMetadataRevision:revoked.metadata.metadataRevision,expectedGrantsRevision:revoked.metadata.grantsRevision,grants:grantInput}}),'Restore exact own fixture grants')).data.resource;
        const tracked=receipt!.resourceRevisions.find(value=>value.resourceRef===resourceRef)!;tracked.metadataRevision=restored.metadata.metadataRevision;tracked.grantsRevision=restored.metadata.grantsRevision;
        if(!restored.grants)throw new Error('The actual fixture manager must receive the restored grants.');
        expect(restored.grants.map(({targetType,targetId,canUse,canEdit,canManage})=>({targetType,targetId,canUse,canEdit,canManage}))).toEqual(grantInput);}
    }
  });
});
