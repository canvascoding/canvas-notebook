import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { CapabilityPackageProvisioning } from '../app/lib/capabilities/packages/provisioning-contracts';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '../app/lib/chat/constants';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self','window','document','localStorage','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','HTMLSelectElement','Element','Node','Document','MutationObserver','CustomEvent','Event','MouseEvent','KeyboardEvent','getComputedStyle'])
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const pin = { resourceRef:'canvas-resource:10000000-0000-4000-8000-000000000001',publishedRevisionRef:'canvas-package-revision:10000000-0000-4000-8000-000000000002',checksum:'a'.repeat(64) };
const session = {user:{id:'owner',name:'Owner',email:'owner@test.invalid',emailVerified:true,createdAt:new Date(0),updatedAt:new Date(0),role:'member',banned:false},
  session:{id:'ui-session',userId:'owner',token:'CONTROLLED_FIXTURE',expiresAt:new Date('2099-01-01'),createdAt:new Date(0),updatedAt:new Date(0)}};
function fixture():CapabilityPackageProvisioning {return {schemaVersion:1,pin,kind:'plugin',name:'exact-test',version:'1.0.0',ownership:{type:'organization',organizationId:'fixture-org'},
  currentHead:{packageRevision:1,publishedRevisionRef:pin.publishedRevisionRef,matchesPin:true},expected:{expectedMetadataRevision:1,expectedGrantsRevision:1,expectedPackageRevision:1,expectedPublishedRevisionRef:pin.publishedRevisionRef,expectedDefaultEnabled:false},
  defaultEnabled:false,personalActivation:{resourceId:'fixture-resource',revision:0,enabled:null},audience:{kind:'users',userIds:['alice']},otherUseTargets:[],targets:{users:[{userId:'alice',name:'Alice',email:'alice@test.invalid',role:'member'},{userId:'bob',name:'Bob',email:'bob@test.invalid',role:'member'}]},
  policy:{canUse:true,effectivePolicy:'optional',enabled:false,readiness:'unknown',blockedReason:null}};}
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(done=>{resolve=done;}),resolve};}
async function main(){
 const {render,screen,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react');
 const loader=Module as typeof Module & {_load(name:string,parent:NodeModule|null,main:boolean):unknown};
 const originalLoad=loader._load,originalFetch=globalThis.fetch,originalConfirm=window.confirm;
 const navigations:unknown[]=[],selectedVersions:unknown[]=[],requests:Array<{path:string;workspace:string|null;method:string;body?:Record<string,unknown>}> = [];
 loader._load=(name,parent,isMain)=>name==='@/i18n/navigation'?{useRouter:()=>({push:(href:unknown)=>navigations.push(href)})}:originalLoad(name,parent,isMain);
 let current=fixture(),failAfterPersonal=false,heldRead:ReturnType<typeof deferred>|null=null,heldWrite:ReturnType<typeof deferred>|null=null,failAfterActivation=false,conflict=false;
 const envelope=(data:unknown,status=200)=>Response.json(status===200?{success:true,data}:{success:false,code:status===409?'PACKAGE_REVISION_CONFLICT':'PACKAGE_SNAPSHOT_UNAVAILABLE'},{status});
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input),'http://canvas.test'),method=init?.method||'GET';
  if(url.pathname==='/api/auth/get-session')return Response.json(session);
  const body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;
  requests.push({path:url.pathname,workspace:url.searchParams.get('workspaceId'),method,body});
  if(url.pathname.endsWith('/provisioning')){
   assert.equal(init?.cache,'no-store');assert.equal(init?.credentials,'same-origin');
   if(method==='GET'){assert.equal(url.searchParams.get('publishedRevisionRef'),pin.publishedRevisionRef);assert.equal(url.searchParams.get('checksum'),pin.checksum);const value=structuredClone(current),hold=heldRead;await hold?.promise;return envelope(value);}
   const hold=heldWrite;await hold?.promise;if(conflict)return envelope({},409);
   assert.deepEqual(body?.pin,pin);assert.equal(body?.expectedPublishedRevisionRef,pin.publishedRevisionRef);
   if(body?.operation==='set_use_audience'){current={...current,audience:body.audience as CapabilityPackageProvisioning['audience'],expected:{...current.expected,expectedMetadataRevision:2,expectedGrantsRevision:2}};return envelope({provisioning:current,changed:true,completedStep:'audience'});}
   if(body?.operation==='enable_for_me'){assert.equal(body.expectedPersonalActivationRevision,current.personalActivation.revision);current={...current,personalActivation:{...current.personalActivation,revision:current.personalActivation.revision+1,enabled:true},policy:{...current.policy,enabled:true}};if(failAfterPersonal)return envelope({},503);return envelope({provisioning:current,changed:true,completedStep:'personal_activation'});}
   assert.equal(body?.operation,'activate');current={...current,defaultEnabled:true,expected:{...current.expected,expectedDefaultEnabled:true},policy:{...current.policy,enabled:true}};
   if(failAfterActivation)return envelope({},503);return envelope({provisioning:current,changed:true,completedStep:'activation'});
  }
  if(url.pathname.endsWith('/versions'))return envelope({versions:[{revisionRef:current.currentHead.publishedRevisionRef,checksum:'b'.repeat(64)}]});
  if(url.pathname==='/api/chat/extension-options'){
   assert.equal(body?.operation,'package_version');assert.deepEqual({resourceRef:body.resourceRef,publishedRevisionRef:body.publishedRevisionRef,checksum:body.checksum},pin);
   return envelope({schemaVersion:1,operation:'package_version',target:body.target,contextKey:'actual-target-fixture',coverage:[],package:{pin,kind:'plugin',name:current.name,displayName:'Exact test',description:'',version:'1.0.0',children:[],declarations:[]}});
  }
  throw new Error(`Unexpected side effect ${method} ${url.pathname}`);
 };
 const {authClient}=await import('../app/lib/auth-client');const atom=authClient.$store.atoms.session,originalSession=atom.get();
 atom.set({...atom.get(),data:session,error:null,isPending:false,isRefetching:false});observeOpenedDocumentAuth({data:{user:{id:'owner'},session:{id:'ui-session'}}});
 const {PackageProvisioningSection}=await import('../app/components/plugins/PackageProvisioningSection');
 const {confirmPluginNavigation}=await import('../app/components/plugins/plugin-navigation-guard');
 const ui=(workspace='workspace-a')=><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><PackageProvisioningSection pin={pin} workspaceId={workspace} onSelectVersion={value=>{assert(confirmPluginNavigation(), 'Version navigation waits for the pending guard.');selectedVersions.push(value);}}/></NextIntlClientProvider>;
 try{
  window.confirm=()=>true;render(ui());await screen.findByText('exact-test · published version 1.0.0');
  assert.equal(requests.length,1,'Initial view only reads package metadata, no provider/account checks.');
  fireEvent.click(screen.getByTestId('provisioning-audience-organization'));heldWrite=deferred();fireEvent.click(screen.getByTestId('provisioning-save-audience'));
  await waitFor(()=>assert(requests.some(request=>request.body?.operation==='set_use_audience')));assert.equal(confirmPluginNavigation(),false,'An already sent availability mutation prevents navigation.');
  await act(async()=>{heldWrite!.resolve();});await screen.findByText(messages.skills.provisioning.saved.audience);heldWrite=null;
  assert.deepEqual(requests.find(request=>request.body?.operation==='set_use_audience')?.body?.audience,{kind:'organization'});
  fireEvent.click(screen.getByTestId('provisioning-activate'));await screen.findByText(messages.skills.provisioning.saved.activation);
  fireEvent.click(screen.getByTestId('provisioning-chat'));await waitFor(()=>assert.equal(navigations.length,1));
  const handoff=JSON.parse(window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY)!);
  assert.equal(handoff.mode,'compose');assert.deepEqual(handoff.body.bundles[0].primary.selection.package,pin);assert.deepEqual(handoff.body.bundles[0].supporting,[],'No account is inferred or embedded.');
  assert(!requests.some(request=>/publish|messages|sessions/u.test(request.path)),'Availability and handoff never republish or send.');

  cleanup();requests.length=0;current=fixture();failAfterActivation=true;render(ui());await screen.findByText('exact-test · published version 1.0.0');
  fireEvent.click(screen.getByTestId('provisioning-activate'));await screen.findByText(messages.skills.provisioning.errors.unavailable);
  fireEvent.click(screen.getByTestId('provisioning-reload'));await screen.findByText(messages.skills.provisioning.active);
  assert.equal(requests.filter(value=>value.body?.operation==='activate').length,1,'A lost acknowledgement recovers from GET, without a second activation or publication.');

  cleanup();requests.length=0;current=fixture();failAfterActivation=false;conflict=true;render(ui());await screen.findByText('exact-test · published version 1.0.0');
  fireEvent.click(screen.getByTestId('provisioning-activate'));await screen.findByText(messages.skills.provisioning.errors.conflict);
  assert.equal((screen.getByTestId('provisioning-activate') as HTMLButtonElement).disabled,true);
  current={...current,currentHead:{...current.currentHead,publishedRevisionRef:'canvas-package-revision:10000000-0000-4000-8000-000000000003',matchesPin:false}};
  fireEvent.click(screen.getByTestId('provisioning-reload'));await screen.findByText(messages.skills.provisioning.headChanged);
  assert.equal((screen.getByTestId('provisioning-save-audience') as HTMLButtonElement).disabled,true);assert(document.body.textContent?.includes('1.0.0'));
  fireEvent.click(screen.getByRole('button',{name:messages.skills.provisioning.openCurrent}));await waitFor(()=>assert.equal(selectedVersions.length,1));
  assert.deepEqual(selectedVersions[0],{resourceRef:pin.resourceRef,publishedRevisionRef:current.currentHead.publishedRevisionRef,checksum:'b'.repeat(64)},'Opening the current version is an explicit selection, never a publication or implicit pin update.');

  cleanup();requests.length=0;conflict=false;current={...fixture(),defaultEnabled:true,expected:{...fixture().expected,expectedDefaultEnabled:true}};render(ui());
  await screen.findByTestId('provisioning-enable-for-me');assert.equal((screen.getByTestId('provisioning-chat') as HTMLButtonElement).disabled,true);
  fireEvent.click(screen.getByTestId('provisioning-enable-for-me'));await screen.findByText(messages.skills.provisioning.saved.personal_activation);
  assert.equal((screen.getByTestId('provisioning-chat') as HTMLButtonElement).disabled,false);assert.equal(requests.filter(value=>value.body?.operation==='enable_for_me').length,1);
  assert.equal(current.personalActivation.enabled,true);assert.equal(current.policy.effectivePolicy,'optional');
  cleanup();requests.length=0;current={...fixture(),defaultEnabled:true,policy:{...fixture().policy,canUse:false}};render(ui());await screen.findByText(messages.skills.provisioning.useNotGranted);
  assert.equal(screen.queryByTestId('provisioning-enable-for-me'),null);assert.equal((screen.getByTestId('provisioning-chat') as HTMLButtonElement).disabled,true);

  cleanup();requests.length=0;current={...fixture(),defaultEnabled:true};failAfterPersonal=true;render(ui());await screen.findByTestId('provisioning-enable-for-me');
  fireEvent.click(screen.getByTestId('provisioning-enable-for-me'));await screen.findByText(messages.skills.provisioning.errors.unavailable);fireEvent.click(screen.getByTestId('provisioning-reload'));
  await waitFor(()=>assert.equal((screen.getByTestId('provisioning-chat') as HTMLButtonElement).disabled,false));assert.equal(requests.filter(value=>value.body?.operation==='enable_for_me').length,1);failAfterPersonal=false;

  cleanup();requests.length=0;current={...fixture(),defaultEnabled:true};heldWrite=deferred();const personalView=render(ui('personal-old'));
  await screen.findByTestId('provisioning-enable-for-me');fireEvent.click(screen.getByTestId('provisioning-enable-for-me'));await waitFor(()=>assert(requests.some(value=>value.body?.operation==='enable_for_me')));
  personalView.rerender(ui('personal-new'));await screen.findByTestId('provisioning-enable-for-me');await act(async()=>{heldWrite!.resolve();});heldWrite=null;
  assert.equal(screen.queryByText(messages.skills.provisioning.saved.personal_activation),null,'A late acknowledgement cannot update another workspace panel.');

  cleanup();requests.length=0;conflict=false;current=fixture();heldRead=deferred();const view=render(ui('old-workspace'));await waitFor(()=>assert.equal(requests.length,1));
  heldRead=null;current={...fixture(),targets:{users:[{userId:'new-user',name:'New current user',email:null,role:'member'}]}};view.rerender(ui('new-workspace'));
  await screen.findByText('New current user');assert.equal(screen.queryByText('Alice'),null,'A different workspace never displays the previous audience choices.');
  console.log('PASS provisioning UI: exact pin, metadata-only read, explicit audience, pending guard, activation/response-loss recovery, current-head fence, unsent pinned chat and workspace isolation.');
 }finally{cleanup();loader._load=originalLoad;globalThis.fetch=originalFetch;window.confirm=originalConfirm;atom.set(originalSession);dom.window.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
