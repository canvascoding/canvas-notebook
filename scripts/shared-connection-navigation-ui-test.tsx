import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM,VirtualConsole } from 'jsdom';
import React,{ useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';

let observeNavigation:(()=>void)|undefined;
const virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',error=>{if(error.message.includes('navigation'))observeNavigation?.();else throw error;});
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://canvas.test/en/plugins?view=advanced&scope=organization',pretendToBeVisual:true,virtualConsole});
for(const key of ['self','window','document','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','HTMLTextAreaElement','HTMLSelectElement','HTMLBodyElement',
  'Element','Node','NodeFilter','DocumentFragment','MutationObserver','CustomEvent','Event','MouseEvent','KeyboardEvent','getComputedStyle']){
  Object.defineProperty(globalThis,key,{value:dom.window[key as keyof Window],configurable:true});
}
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)});
Object.defineProperty(globalThis,'PointerEvent',{value:dom.window.MouseEvent,configurable:true});
Object.defineProperty(dom.window,'PointerEvent',{value:dom.window.MouseEvent,configurable:true});
dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
class FixtureResizeObserver{observe(){}unobserve(){}disconnect(){}}
Object.defineProperty(globalThis,'ResizeObserver',{value:FixtureResizeObserver,configurable:true});

/** Real Parent/Forms/Radix/Intl/PluginGuard; controlled SafeDTO HTTP, no database or provider authority claims. */
async function main(){
  const loader=Module as typeof Module&{_load:(name:string,parent:NodeModule|null,isMain:boolean)=>unknown};
  const originalLoad=loader._load,originalFetch=globalThis.fetch,originalConfirm=window.confirm;
  loader._load=(name,parent,isMain)=>name==='@/i18n/navigation'
    ?{Link:React.forwardRef<HTMLAnchorElement,React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props,ref){return <a {...props} ref={ref}/>;})}
    :originalLoad(name,parent,isMain);
  const { render,screen,fireEvent,waitFor,cleanup,act,within }=await import('@testing-library/react');
  const { SharedConnectionsSection }=await import('../app/components/plugins/SharedConnectionsSection');
  const { PluginNavigationGuard,confirmPluginNavigation,usePluginEditorNavigationGuard }=await import('../app/components/plugins/plugin-navigation-guard');
  const labels=en.sharedConnections,refs={mcp:'canvas-connection:11111111-1111-4111-8111-111111111111',composio:'canvas-connection:22222222-2222-4222-8222-222222222222'};
  const initial=(source:'mcp'|'composio'):IntegrationConnectionDescriptor=>({resource:{connectionRef:refs[source],source,ownership:{type:'organization',organizationId:'fixture-org'},
    displayName:`Owned ${source} fixture`,description:'Saved description',application:source==='composio'?'canva':null,responsibleUserId:null,createdByUserId:'fixture-admin',updatedByUserId:'fixture-admin',
    metadataRevision:1,grantsRevision:1,bindingRevision:1,allowedToolNames:null,accessMode:'restricted',status:'active',createdAt:1,updatedAt:1},
    access:{canRead:true,canUse:false,canManage:true},grants:[]});
  let records={mcp:initial('mcp'),composio:initial('composio')},accepts=false,prompts=0,writeStatus=200;
  type Seen={path:string;method:string;body:Record<string,unknown>|null;workspaceId:string|null};
  const requests:Seen[]=[];let releaseWrite:(()=>void)|undefined,writeGate:Promise<void>|undefined;
  let oauthStatus=200,oauthFailure:'none'|'fetch'|'json'='none',oauthJsonStarted=0;
  let oauthJsonGate:Promise<void>|undefined,releaseOAuthJson:(()=>void)|undefined;
  const writes=()=>requests.filter(request=>request.method!=='GET');
  window.confirm=()=>{prompts++;return accepts;};
  const ok=(data:unknown)=>Response.json({success:true,data});
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input),window.location.origin),pathname=decodeURIComponent(url.pathname),method=init?.method??'GET';
    const workspaceId=new Headers(init?.headers).get('x-canvas-workspace-id');
    assert(['fixture-workspace','next-fixture-workspace'].includes(workspaceId??''));
    const body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:null;requests.push({path:pathname,method,body,workspaceId});
    if(pathname==='/api/integrations/shared-connections/setup')return ok({scopes:[{ownership:{type:'organization',organizationId:'fixture-org'},label:'Organization'}]});
    if(pathname==='/api/integrations/shared-connections'&&method==='GET')return ok({connections:structuredClone(Object.values(records))});
    if(pathname==='/api/composio/shared-profiles'&&method==='GET')return ok({profiles:[{id:'fixture-profile',name:'Own shared profile',providerMode:'local'}]});
    const source=pathname.includes(refs.composio)?'composio':'mcp',record=records[source];
    if(pathname.endsWith('/targets')&&method==='GET')return ok({targets:{users:[{userId:'fixture-reader',name:'Reader',email:'reader@fixture.invalid',role:'member'}],workspaces:[],projects:[],agents:[]}});
    if(pathname.startsWith('/api/integrations/shared-connections/')&&method==='GET')return ok({connection:structuredClone(record)});
    if(pathname.endsWith('/accounts')&&method==='GET')return ok({accounts:[{accountRef:'opaque-owned-account',label:'Own account',selectable:true}]});
    if((pathname.endsWith('/oauth')||pathname.endsWith('/connect'))&&method==='POST'){
      await writeGate;
      if(oauthFailure==='fetch')throw new Error('PRIVATE_ACK_LOSS_BODY');
      const response=oauthStatus===200?ok(source==='mcp'?{authorizationUrl:'https://login.fixture.invalid/oauth'}:{redirectUrl:'https://login.fixture.invalid/connect'})
        :Response.json({success:false,code:oauthStatus===409?'binding_changed':'provider_denied',error:'PRIVATE_PROVIDER_BODY'},{status:oauthStatus});
      const readJson=response.json.bind(response);
      Object.defineProperty(response,'json',{value:async()=>{oauthJsonStarted++;await oauthJsonGate;
        if(oauthFailure==='json')throw new Error('PRIVATE_ACK_JSON_BODY');return readJson();}});
      return response;
    }
    if(pathname.startsWith('/api/integrations/shared-connections/')&&method==='PATCH'){
      await writeGate;
      if(writeStatus===409){record.resource={...record.resource,metadataRevision:2,displayName:'Remote current label'};return Response.json({success:false,code:'binding_changed',error:'PRIVATE_PROVIDER_BODY'},{status:409});}
      const metadata=body?.metadata as Record<string,unknown>|undefined;
      record.resource={...record.resource,displayName:typeof metadata?.displayName==='string'?metadata.displayName:record.resource.displayName,metadataRevision:record.resource.metadataRevision+1};
      return ok({connection:structuredClone(record)});
    }
    throw new Error(`Unexpected controlled UI endpoint ${method} ${pathname}`);
  };
  function App({locale='en',workspaceId='fixture-workspace'}:{locale?:'en'|'de';workspaceId?:string}){
    const [epoch,setEpoch]=useState(0),[scope,setScope]=useState('organization');
    return <NextIntlClientProvider locale={locale} messages={locale==='en'?en:de} timeZone="UTC">
      <PluginNavigationGuard unsavedChangesMessage={(locale==='en'?en:de).skills.drafts.unsavedNavigation}/>
      <header><button type="button" onClick={()=>{if(confirmPluginNavigation())setEpoch(value=>value+1);}}>Fixture Header Reload</button>
        <button type="button" onClick={()=>{if(confirmPluginNavigation()){window.history.pushState(null,'','/en/plugins?scope=user');setScope('user');}}}>Fixture scope navigation</button><output data-testid="fixture-scope">{scope}</output></header>
      <SharedConnectionsSection key={epoch} workspaceId={workspaceId} ownership={{type:'organization',organizationId:'fixture-org'}} initiallyOpen/>
    </NextIntlClientProvider>;
  }
  const field=(id:string)=>{const value=document.getElementById(id);assert(value,`Expected field ${id}`);return value;};
  const change=(id:string,value:string)=>fireEvent.change(field(id),{target:{value}});
  const value=(id:string)=>(field(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement).value;
  const waitReady=async()=>{await waitFor(()=>assert.equal((screen.getByTestId('shared-connection-create') as HTMLButtonElement).disabled,false));};
  const reset=async(locale:'en'|'de'='en')=>{
    observeNavigation=undefined;cleanup();releaseWrite?.();releaseOAuthJson?.();releaseWrite=undefined;writeGate=undefined;releaseOAuthJson=undefined;oauthJsonGate=undefined;
    oauthStatus=200;oauthFailure='none';oauthJsonStarted=0;records={mcp:initial('mcp'),composio:initial('composio')};requests.length=0;accepts=false;prompts=0;writeStatus=200;
    window.history.replaceState(null,'','/en/plugins?view=advanced&scope=organization');window.history.pushState(null,'','/en/plugins?view=advanced&task=connections');
    const view=render(<App locale={locale}/>);await waitReady();return view;
  };
  const openCreate=async()=>{fireEvent.click(screen.getByTestId('shared-connection-create'));return screen.findByTestId('shared-connection-create-dialog');};
  const openEditor=async(source:'mcp'|'composio'='mcp')=>{
    fireEvent.click(screen.getByRole('button',{name:new RegExp(`Owned ${source} fixture`,'u')}));const dialog=await screen.findByTestId('shared-connection-edit-dialog');
    await waitFor(()=>assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled,false));return dialog;
  };
  const closeButton=(dialog:HTMLElement)=>within(dialog).getByRole('button',{name:'Close'});
  const escape=()=>fireEvent.keyDown(document,{key:'Escape'});
  const dirtyClose=async(dialog:HTMLElement)=>{
    const reads=requests.length,before=prompts;escape();await waitFor(()=>assert.equal(prompts,before+1));assert(document.body.contains(dialog));
    fireEvent.click(closeButton(dialog));assert.equal(prompts,before+2);assert(document.body.contains(dialog));assert.equal(requests.length,reads);
  };
  try{
    await reset();const create=await openCreate();assert.equal(confirmPluginNavigation(),true);
    change('shared-name','Unsaved connection');change('shared-url','https://fixture.invalid/mcp');change('shared-token','ONLY_FAKE_HIDDEN_TOKEN');
    await dirtyClose(create);
    const oldHref=window.location.href;
    // Radix hides the modal background; these direct harness callbacks exercise Guard consumers, not behind-modal user clicks.
    fireEvent.click(screen.getByRole('button',{name:'Fixture Header Reload',hidden:true}));assert.equal(value('shared-token'),'ONLY_FAKE_HIDDEN_TOKEN');
    fireEvent.click(screen.getByRole('button',{name:'Fixture scope navigation',hidden:true}));assert.equal(screen.getByTestId('fixture-scope').textContent,'organization');
    await act(async()=>{window.history.back();await new Promise(resolve=>setTimeout(resolve,40));});
    await waitFor(()=>assert.equal(window.location.href,oldHref));assert.equal(value('shared-name'),'Unsaved connection');assert.equal(writes().length,0);
    accepts=true;fireEvent.click(closeButton(create));await waitFor(()=>assert.equal(screen.queryByTestId('shared-connection-create-dialog'),null));assert.equal(confirmPluginNavigation(),true);

    const compCreate=await openCreate();change('shared-source','composio');await screen.findByRole('option',{name:'Own shared profile'});
    change('shared-profile','fixture-profile');change('shared-app','canva');
    const profileDetails=field('shared-profile-name').closest('details');assert(profileDetails);profileDetails.open=true;
    change('shared-profile-name','Unsaved profile name');profileDetails.open=false;
    accepts=false;await dirtyClose(compCreate);assert.equal(value('shared-profile-name'),'Unsaved profile name');assert.equal(value('shared-app'),'canva');assert.equal(writes().length,0);
    accepts=true;fireEvent.click(closeButton(compCreate));await waitFor(()=>assert.equal(screen.queryByTestId('shared-connection-create-dialog'),null));assert.equal(confirmPluginNavigation(),true);

    // Each isolated editor case starts from the actual Parent-issued loaded baseline.
    const cases:[string,()=>void,string][]=[['name',()=>change('shared-edit-name','Local name'),'shared-edit-name'],['description',()=>change('shared-edit-description','Local description'),'shared-edit-description'],
      ['tools',()=>{change('shared-tool-mode','selected');change('shared-allowed-tools','tool.one');},'shared-allowed-tools'],
      ['repair configuration',()=>change('shared-repair-config','{"url":"https://fixture.invalid/new"}'),'shared-repair-config'],
      ['hidden repair slots',()=>change('shared-repair-secrets','[{"name":"TOKEN","value":"FAKE_SLOT_ONLY"}]'),'shared-repair-secrets']];
    for(const [label,mutate,id]of cases){
      await reset();const editor=await openEditor();mutate();const text=value(id),reads=requests.length;
      fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));assert.equal(requests.length,reads,`${label} cancelled Reload performs zero reads.`);assert.equal(value(id),text);
      await dirtyClose(editor);assert.equal(value(id),text);assert.equal(writes().length,0);
      accepts=true;fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));await waitFor(()=>assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled,false));
      assert.equal(confirmPluginNavigation(),true,`${label} accepted Reload clears the draft guard.`);assert(requests.length>reads);
    }

    await reset();let editor=await openEditor();
    fireEvent.click(screen.getByTestId('shared-grant-target'));fireEvent.click(await screen.findByTestId('shared-grant-target-option-fixture-reader'));
    fireEvent.click(within(editor).getByRole('checkbox',{name:labels.canUse}));
    const grantTools=within(editor).getByRole('textbox',{name:labels.grantToolLimits,hidden:true}) as HTMLTextAreaElement;
    const grantDetails=grantTools.closest('details');assert(grantDetails);grantDetails.open=true;
    fireEvent.change(grantTools,{target:{value:'staged.tool'}});
    await dirtyClose(editor);assert.equal(writes().length,0);
    const stagedReads=requests.length;fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));assert.equal(requests.length,stagedReads);
    accepts=true;fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));await waitFor(()=>assert.equal(confirmPluginNavigation(),true));
    assert.equal((within(editor).getByRole('textbox',{name:labels.grantToolLimits}) as HTMLTextAreaElement).value,'');

    await reset();editor=await openEditor('composio');
    const loadAccounts=within(editor).getByRole('button',{name:labels.loadAccounts,hidden:true});
    const accountDetails=loadAccounts.closest('details');assert(accountDetails);accountDetails.open=true;
    fireEvent.click(loadAccounts);await screen.findByRole('option',{name:'Own account'});change('shared-account','opaque-owned-account');
    const accountReads=requests.length;fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));assert.equal(requests.length,accountReads);await dirtyClose(editor);assert.equal(value('shared-account'),'opaque-owned-account');
    accepts=true;fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));await waitFor(()=>assert.equal(confirmPluginNavigation(),true));assert.equal(document.getElementById('shared-account'),null);assert.equal(writes().length,0);

    await reset();editor=await openEditor();change('shared-edit-name','Saved fixture label');
    writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;});fireEvent.click(screen.getByTestId('shared-connection-save'));
    await waitFor(()=>assert.equal(writes().length,1));const beforePending=prompts,pendingHref=window.location.href;
    escape();fireEvent.click(closeButton(editor));fireEvent.click(screen.getByRole('button',{name:'Fixture Header Reload',hidden:true}));fireEvent.click(screen.getByRole('button',{name:'Fixture scope navigation',hidden:true}));
    await act(async()=>{window.history.back();await new Promise(resolve=>setTimeout(resolve,40));});
    await waitFor(()=>assert.equal(window.location.href,pendingHref));assert(document.body.contains(editor));assert.equal(prompts,beforePending,'Actual Parent pending refuses all departures without confirmation.');
    assert.equal(writes().length,1);assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled,true);
    await act(async()=>releaseWrite?.());await waitFor(()=>assert.equal(screen.queryByTestId('shared-connection-edit-dialog'),null));await waitReady();
    assert.equal(prompts,beforePending,'Successful controlled Save closes programmatically without a discard prompt.');assert.equal(confirmPluginNavigation(),true);assert.equal(writes().length,1);
    assert.deepEqual(writes()[0].body?.expectedMetadataRevision,1);assert.deepEqual(writes()[0].body?.expectedBindingRevision,1);

    await reset();editor=await openEditor();change('shared-edit-name','Retained after conflict');writeStatus=409;fireEvent.click(screen.getByTestId('shared-connection-save'));
    await screen.findByText(labels.conflict);assert.equal(value('shared-edit-name'),'Retained after conflict');assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled,true);
    const conflictReads=requests.length;fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));assert.equal(requests.length,conflictReads);assert.equal(value('shared-edit-name'),'Retained after conflict');
    accepts=true;fireEvent.click(screen.getByTestId('shared-connection-editor-reload'));await waitFor(()=>assert.equal(value('shared-edit-name'),'Remote current label'));assert.equal(confirmPluginNavigation(),true);
    assert.equal(writes().length,1);assert.equal(document.body.textContent?.includes('PRIVATE_PROVIDER_BODY'),false);

    if(process.argv.includes('--oauth-pending-regression')){
      // Actual location.assign invokes JSDOM's navigation boundary; the observer injects
      // beforeUnload synchronously there. This proves React/Guard ordering, not native timing.
      let redirects=0;const preventedAtAssign:boolean[]=[];
      const unload=()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;};
      const observe=()=>{redirects=0;preventedAtAssign.length=0;observeNavigation=()=>{redirects++;preventedAtAssign.push(unload());};};
      const connectButton=(dialog:HTMLElement)=>{const button=within(dialog).getByRole('button',{name:labels.connect,hidden:true});
        const details=button.closest('details');assert(details);details.open=true;return button;};
      const exactOAuthRequest=(source:'mcp'|'composio')=>{
        assert.equal(writes().length,1);assert.deepEqual(writes()[0],{path:`/api/${source}/shared-connections/${refs[source]}/${source==='mcp'?'oauth':'connect'}`,
          method:'POST',workspaceId:'fixture-workspace',body:{expectedMetadataRevision:1,expectedGrantsRevision:1,expectedBindingRevision:1}});
      };
      for(const source of ['mcp','composio'] as const){
        await reset();editor=await openEditor(source);observe();assert.equal(confirmPluginNavigation(),true);
        const connect=connectButton(editor);fireEvent.click(connect);
        await waitFor(()=>assert.equal(redirects,1));
        assert.deepEqual(preventedAtAssign,[false],'The clean intentional OAuth navigation must not acquire a child busy/pending unload fence.');
        assert.equal(prompts,0);exactOAuthRequest(source);
        await waitFor(()=>assert.equal((connect as HTMLButtonElement).disabled,false));
        assert.equal(unload(),false);assert.equal(confirmPluginNavigation(),true);
        // A later ordinary dirty editor must still be protected; there is no general unload exemption.
        change('shared-edit-name','Unsaved after acknowledged OAuth');assert.equal(unload(),true);
        assert.equal(confirmPluginNavigation(),false);assert.equal(prompts,1);exactOAuthRequest(source);
        console.log(`PASS OAuth clean ${source}: synchronous ACK assign unfenced, exact scoped CAS POST, ordinary dirty guard retained.`);
      }
      for(const boundary of ['http','json'] as const){
        await reset();editor=await openEditor();observe();const connect=connectButton(editor);
        if(boundary==='http')writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;});
        else oauthJsonGate=new Promise<void>(resolve=>{releaseOAuthJson=resolve;});
        fireEvent.click(connect);await waitFor(()=>assert.equal(writes().length,1));
        if(boundary==='json')await waitFor(()=>assert.equal(oauthJsonStarted,1));
        const pendingHref=window.location.href;assert.equal(unload(),true);assert.equal(confirmPluginNavigation(),false);assert.equal(prompts,0);
        escape();fireEvent.click(closeButton(editor));
        // Controlled background callbacks exercise Guard consumers, not native behind-modal clicks.
        fireEvent.click(screen.getByRole('button',{name:'Fixture Header Reload',hidden:true}));
        fireEvent.click(screen.getByRole('button',{name:'Fixture scope navigation',hidden:true}));
        await act(async()=>{window.history.back();await new Promise(resolve=>setTimeout(resolve,40));});
        await waitFor(()=>assert.equal(window.location.href,pendingHref));assert(document.body.contains(editor));assert.equal(prompts,0);
        assert.equal((connect as HTMLButtonElement).disabled,true);fireEvent.click(connect);exactOAuthRequest('mcp');assert.equal(redirects,0);
        await act(async()=>{if(boundary==='http')releaseWrite?.();else releaseOAuthJson?.();});
        await waitFor(()=>assert.equal(redirects,1));assert.deepEqual(preventedAtAssign,[false]);assert.equal(prompts,0);
        await waitFor(()=>assert.equal((connect as HTMLButtonElement).disabled,false));assert.equal(unload(),false);assert.equal(confirmPluginNavigation(),true);exactOAuthRequest('mcp');
        console.log(`PASS OAuth ${boundary} acknowledgement boundary: pending refuses departure/no duplicate, settled clean ACK permits exactly one redirect.`);
      }
      for(const outcome of ['fetch','json',403,409,503] as const){
        await reset();editor=await openEditor();observe();const connect=connectButton(editor);
        if(typeof outcome==='number')oauthStatus=outcome;else oauthFailure=outcome;
        const baseline=structuredClone(records.mcp);change('shared-edit-name',`Retained ${outcome}`);
        fireEvent.click(connect);await screen.findByText(outcome===409?labels.conflict:labels.saveError);
        assert.equal(redirects,0);exactOAuthRequest('mcp');assert.deepEqual(records.mcp,baseline);
        assert.equal(value('shared-edit-name'),`Retained ${outcome}`);assert.equal(value('shared-edit-description'),'Saved description');
        assert.equal(document.body.textContent?.includes('PRIVATE_'),false);assert.equal(prompts,0);
        // A prompt here distinguishes a settled Parent counter from a still-pending write:
        // the dirty form is retained and cancellation cannot close it.
        fireEvent.click(closeButton(editor));assert.equal(prompts,1);assert(document.body.contains(editor));assert.equal(redirects,0);
        assert.equal((connect as HTMLButtonElement).disabled,outcome===409);
        console.log(`PASS OAuth ${outcome}: no redirect/auto-retry, Parent pending settled, dirty draft and baseline retained.`);
      }
      for(const outcome of ['url','error'] as const){
        const view=await reset();editor=await openEditor();observe();writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;});
        if(outcome==='error')oauthFailure='fetch';fireEvent.click(connectButton(editor));await waitFor(()=>assert.equal(writes().length,1));
        const baseline=structuredClone(records.mcp);view.rerender(<App workspaceId="next-fixture-workspace"/>);await waitReady();
        assert.equal(Boolean(screen.queryByTestId('shared-connection-edit-dialog')),false);
        await act(async()=>releaseWrite?.());assert.equal(redirects,0);assert.deepEqual(records.mcp,baseline);
        assert.equal(confirmPluginNavigation(),true);assert.equal(unload(),false);assert.equal(prompts,0);exactOAuthRequest('mcp');
        assert(requests.filter(request=>request.method==='GET').some(request=>request.workspaceId==='next-fixture-workspace'));
        assert.equal(document.body.textContent?.includes('PRIVATE_'),false);
        console.log(`PASS OAuth late ${outcome}: old keyed scope response ignored without redirect/current-scope state or guard pollution.`);
      }
      function OtherEditorFence({dirty,pending}:{dirty:boolean;pending:boolean}){usePluginEditorNavigationGuard({dirty,pending});return <p>Other fixture editor</p>;}
      for(const kind of ['dirty','pending'] as const){
        await reset();editor=await openEditor();observe();const other=render(<OtherEditorFence dirty={kind==='dirty'} pending={kind==='pending'}/>);
        fireEvent.click(connectButton(editor));await waitFor(()=>assert.equal(redirects,1));
        assert.deepEqual(preventedAtAssign,[true],`Acknowledged OAuth must not bypass another editor's boolean ${kind} guard.`);assert.equal(prompts,0);
        other.unmount();assert.equal(unload(),false);assert.equal(confirmPluginNavigation(),true);exactOAuthRequest('mcp');
      }
      observeNavigation=undefined;
      console.log('PASS OAuth pending-only matrix. Controlled HTTP/React synchronous assign boundary; no native OAuth, server authority, dirty-authorize preflight or actor-only policy claims.');
    }

    await reset('de');await openCreate();assert(screen.getByRole('dialog',{name:de.sharedConnections.createTitle}));
    console.log('PASS real SharedConnections Parent/Forms/Intl/Radix navigation: dirty hidden/staged inputs, local Escape/X/Reload and scope/history fences, actual Parent pending single Save, programmatic successful close, retained409 and German labels. Controlled SafeDTO HTTP only; no server/provider authority, OAuth acceptance or production-browser claims.');
  }finally{observeNavigation=undefined;releaseWrite?.();releaseOAuthJson?.();cleanup();loader._load=originalLoad;globalThis.fetch=originalFetch;window.confirm=originalConfirm;dom.window.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
