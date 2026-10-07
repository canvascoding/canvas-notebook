import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedSummary } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityPackagePresentation } from '../app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageStoreListResponse, CapabilityPackageStoreSelection } from '../app/lib/capabilities/packages/store-contracts';
import type { PluginNavigation } from '../app/lib/plugins/plugin-navigation';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/plugins', pretendToBeVisual: true });
for (const key of ['self','window','document','localStorage','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','HTMLTextAreaElement','HTMLSelectElement',
  'HTMLDetailsElement','SVGElement','Element','Node','Document','MutationObserver','CustomEvent','Event','MouseEvent','KeyboardEvent','FocusEvent','getComputedStyle']) {
  Object.defineProperty(globalThis,key,{value:dom.window[key as keyof Window],configurable:true});
}
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)});
const resourceRef='canvas-resource:11111111-1111-4111-8111-111111111111';
const otherRef='canvas-resource:22222222-2222-4222-8222-222222222222';
const revisionRef='canvas-package-revision:33333333-3333-4333-8333-333333333333';
const draftRef='canvas-package-draft:44444444-4444-4444-8444-444444444444';
const checksum='a'.repeat(64),otherChecksum='b'.repeat(64);
function descriptor(ref=resourceRef):CapabilityResourceDescriptor {
  const name=ref===resourceRef?'design-package':'research-package';
  return {metadata:{resourceRef:ref,legacyResourceId:`canvas-capability:v1:plugin:org:fixture:standalone:${name}`,resourceType:'plugin',sourceType:'standalone',sourcePluginId:null,
    ownership:{type:'team',organizationId:'fixture-org',workspaceId:'team-design'},displayName:ref===resourceRef?'Design workspace':'Research workspace',description:'A useful design package',
    responsibleUserId:'responsible',createdByUserId:'creator',updatedByUserId:'editor',metadataRevision:1,grantsRevision:1,accessMode:'restricted',status:'active',createdAt:1,updatedAt:1},
  artifact:{resourceId:`canvas-capability:v1:plugin:org:fixture:standalone:${name}`,resourceType:'plugin',scopeType:'organization',name,version:'1.0.0',revision:1,checksum,sourceType:'standalone',sourcePluginId:null},
  access:{canRead:true,canUse:false,canEdit:false,canManage:false},people:{responsible:{userId:'responsible',name:'Design team'},createdBy:{userId:'creator',name:'Creator'},updatedBy:{userId:'editor',name:'Editor'}},
  ownershipLabel:'Design team',activation:{effectivePolicy:'optional',enabled:false,readiness:'unknown',blockedReason:null}};
}
function presentation(value:CapabilityResourceDescriptor):CapabilityPackagePresentation {
  return {schemaVersion:1,origin:'installed',kind:value.artifact.resourceType as 'plugin'|'skill',name:value.artifact.name,version:'1.0.0',title:value.metadata.displayName||value.artifact.name,
    description:'Safe package declaration',resourceRef:value.metadata.resourceRef,license:'MIT',children:[],capabilities:[{declaredBy:{kind:'plugin',name:value.artifact.name},id:'design',application:'Design',required:true,
      alternatives:[{source:'mcp',label:'Design MCP'},{source:'composio',label:'Canva'}]}],requirements:[{declaredBy:{kind:'plugin',name:value.artifact.name},source:'composio',label:'Studio design account',required:true,recommended:false}],
    scripts:[],compatibility:[],requiredEnv:['CANVAS_DESIGN_KEY'],readOnly:false,sourceStampCurrent:true};
}
function packageView(value:CapabilityResourceDescriptor):CapabilityPackageDescriptor {
  return {resource:value.metadata,access:value.access,readOnly:false,defaultEnabled:false,state:null,published:null,
    sourceStamp:{resourceId:value.artifact.resourceId,kind:value.artifact.resourceType as 'plugin'|'skill',name:value.artifact.name,version:'1.0.0',artifactRevision:1,checksum,registryChecksum:checksum,sourcePluginId:null}};
}
function history(value:CapabilityResourceDescriptor):CapabilityPackagePublishedSummary {
  return {resourceRef:value.metadata.resourceRef,revisionRef,kind:'plugin',name:value.artifact.name,version:'1.0.0',checksum,publishedByUserId:'creator',publishedAt:1,
    baseRevisionRef:null,fileCount:2,totalBytes:20};
}
function storeList(value:CapabilityResourceDescriptor):CapabilityPackageStoreListResponse {
  return {schemaVersion:1,selection:{kind:'plugin',scope:'team',audience:null,teamId:'team-design',q:'',page:1,limit:20,selectionRequired:null,installedState:'all'},scopes:{choices:['user','team'],teams:[]},
    stores:[{kind:'plugin',registry:{id:'official',name:'Official',updatedAt:''},availability:'available',pagination:{page:1,pageSize:20,totalItems:1,totalPages:1,hasNextPage:false,hasPreviousPage:false},
      offerings:[{kind:'plugin',registryId:'official',entryKey:value.artifact.name,displayName:'Design package',description:'',latestVersion:'2.0.0',versions:[{version:'2.0.0',checksum:otherChecksum}],
        installedResourceRefs:[value.metadata.resourceRef],installedRefsTruncated:false}],installedResources:[]}],
    installed:{resources:[{...value,storeState:{origin:'verified',localChanges:'modified',upstream:'update-available'}}],pagination:{page:1,limit:20,totalItems:1,totalPages:1,hasNextPage:false,hasPreviousPage:false},
      summary:{total:1,updates:1,modified:1,unknown:0,observed:1,comparison:'known'}}};
}

async function main() {
  const {render,screen,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react');
  const {PackageDetailWorkspace}=await import('../app/components/plugins/PackageDetailWorkspace');
  const {PackageEditorSection}=await import('../app/components/plugins/PackageEditorSection');
  const {confirmPluginNavigation}=await import('../app/components/plugins/plugin-navigation-guard');
  const intl=(content:React.ReactNode)=><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{content}</NextIntlClientProvider>;
  const originalFetch=globalThis.fetch,originalConfirm=window.confirm;
  const requests:Array<{path:string;workspace:string|null;method:string;query:URLSearchParams}>=[];
  let resource=descriptor(),offered=presentation(resource),packageDescriptor=packageView(resource),store:CapabilityPackageStoreListResponse|null=null;
  let metadataStatus=200,presentationStatus=200,heldBase:Promise<void>|undefined,heldFile:Promise<void>|undefined,heldWrite:Promise<void>|undefined;
  const navigation:Partial<PluginNavigation>[]=[],updates:CapabilityPackageStoreSelection[]=[];
  const updateTargets:string[]=[];
  let closeCount=0;
  const file={path:'README.md',size:10,checksum,encoding:'base64' as const,content:Buffer.from('saved text').toString('base64'),offset:0,byteLength:10,eof:true};
  const draft:CapabilityPackageDraft={contractVersion:1,draftRef,resourceRef,kind:'plugin',name:'design-package',operation:'edit',actorUserId:'editor',draftRevision:1,basePackageRevision:0,basePublishedRevisionRef:null,
    baseSourceStamp:packageDescriptor.sourceStamp,sourceResourceRef:resourceRef,sourceMetadataRevision:1,sourceGrantsRevision:1,sourcePackageRevision:0,sourcePublishedRevisionRef:null,createdAt:1,updatedAt:1};
  const draftData=()=>({draft,target:{ownership:resource.metadata.ownership,expectedMetadataRevision:1,expectedGrantsRevision:1}});
  const body=(data:unknown,status=200)=>Response.json(status===200?{success:true,data}:{success:false,code:'CAPABILITY_RESOURCE_NOT_FOUND',error:'PRIVATE_ERROR_BODY'}, {status});
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input),'http://canvas.test'),method=init?.method||'GET';
    requests.push({path:url.pathname,workspace:url.searchParams.get('workspaceId')||(init?.headers?new Headers(init.headers).get('x-canvas-workspace-id'):null),method,query:url.searchParams});
    assert.equal(init?.cache,'no-store');
    const selected=resource,presented=offered,pkg=packageDescriptor;
    if(url.pathname.startsWith('/api/capabilities/resources/')) return body({resource:selected},metadataStatus);
    if(url.pathname.endsWith('/presentation')) {await heldBase;return body({presentation:presented},presentationStatus);}
    if(url.pathname==='/api/integrations/shared-connections/setup') return body({scopes:[]});
    if(url.pathname==='/api/integrations/shared-connections') return body({connections:[
      {resource:{connectionRef:'shared-design',displayName:'Design shared account',source:'composio',ownership:{type:'team',organizationId:'fixture-org',workspaceId:'team-design'},status:'active'},access:{canRead:true,canUse:true,canManage:false}},
      {resource:{connectionRef:'shared-other',displayName:'Other team account',source:'mcp',ownership:{type:'team',organizationId:'fixture-org',workspaceId:'team-other'},status:'active'},access:{canRead:true,canUse:true,canManage:false}},
    ]});
    if(url.pathname.endsWith('/versions')) return body({versions:[history(selected)]});
    if(url.pathname.endsWith('/scopes')) return body({scopes:[{type:'user',label:'Personal'}]});
    if(url.pathname.includes('/drafts/')) {
      if(url.pathname.endsWith('/status')) return body({status:{draftRef,resourceRef,sourceResourceRef:resourceRef,kind:'plugin',name:'design-package',draftRevision:1,operation:'edit',createdAt:1,updatedAt:1,targetOwnership:resource.metadata.ownership}});
      if(url.pathname.endsWith('/tree')) return body({...draftData(),files:[{type:'file',path:'README.md',size:10,checksum},{type:'file',path:'notes.md',size:5,checksum:otherChecksum}]});
      if(url.pathname.endsWith('/file')) {if(method==='PUT'){await heldWrite;return body({draft});}await heldFile;return body({...draftData(),file});}
    }
    if(url.pathname.endsWith('/tree')) return body({files:[{type:'file',path:'README.md',size:10,checksum},{type:'file',path:'notes.md',size:5,checksum:otherChecksum}]});
    if(url.pathname.endsWith('/file')) {await heldFile;return body({file});}
    if(url.pathname.startsWith('/api/capabilities/packages/')) return body({package:pkg});
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  function Detail({reference=resourceRef,workspace='team-design',initialTask='overview',selectedFile}:{reference?:string;workspace?:string;initialTask?:React.ComponentProps<typeof PackageDetailWorkspace>['task'];selectedFile?:string}) {
    const [task,setTask]=React.useState(initialTask);
    return intl(<PackageDetailWorkspace resourceRef={reference} workspaceId={workspace} task={task} file={selectedFile} store={store} onUpdated={()=>{}}
      onNavigate={patch=>{if(confirmPluginNavigation()){navigation.push(patch);if(patch.task)setTask(patch.task);}}}
      onClose={()=>{if(confirmPluginNavigation())closeCount+=1;}} onStoreUpdate={(source,canonicalRef)=>{updates.push(source);updateTargets.push(canonicalRef);}} />);
  }
  const reset=()=>{cleanup();requests.length=0;navigation.length=0;updates.length=0;updateTargets.length=0;closeCount=0;localStorage.clear();resource=descriptor();offered=presentation(resource);packageDescriptor=packageView(resource);store=null;
    metadataStatus=200;presentationStatus=200;heldBase=undefined;heldFile=undefined;heldWrite=undefined;};
  try {
    render(<Detail />);await screen.findByText('Design workspace');
    assert.deepEqual(requests.map(request=>request.path).sort(),[`/api/capabilities/packages/${encodeURIComponent(resourceRef)}/presentation`,`/api/capabilities/resources/${encodeURIComponent(resourceRef)}`].sort());
    assert(requests.every(request=>request.workspace==='team-design'));assert(!document.body.textContent?.includes(resourceRef));assert(!screen.queryByTestId('package-editor'));
    assert(document.body.textContent?.includes('Design team'));assert(document.body.textContent?.includes('Creator'));assert(!screen.queryByTestId('package-detail-store-update'));
    fireEvent.mouseDown(screen.getByTestId('package-detail-tab-versions'),{button:0});await screen.findByText('Published versions');
    await waitFor(()=>assert(requests.some(request=>request.path.endsWith('/versions'))));
    assert(!requests.some(request=>request.path.endsWith('/file')||request.path.endsWith('/tree')||request.path.includes('/drafts')));
    assert(!screen.queryByTestId('package-save-file'));assert(document.body.textContent?.includes('1.0.0'));
    fireEvent.mouseDown(screen.getByTestId('package-detail-tab-sharing'),{button:0});await screen.findByTestId('resource-management');
    assert(!requests.some(request=>request.path.endsWith('/targets')));assert(!screen.queryByTestId('resource-save'));
    fireEvent.mouseDown(screen.getByTestId('package-detail-tab-connections'),{button:0});await screen.findByText('Design shared account');
    assert(screen.queryByText('Other team account')===null);assert(document.body.textContent?.includes('CANVAS_DESIGN_KEY'));assert(document.body.textContent?.includes('Declared by design-package'));
    assert(!requests.some(request=>request.method!=='GET'),'read-only tasks cannot create accounts or change package state');
    fireEvent.click(screen.getByTestId('package-detail-back'));assert.equal(closeCount,1);

    reset();resource.access={canRead:true,canUse:true,canEdit:true,canManage:true};offered=presentation(resource);packageDescriptor=packageView(resource);store=storeList(resource);
    render(<Detail />);await screen.findByTestId('package-detail-store-update');fireEvent.click(screen.getByTestId('package-detail-store-update'));
    assert.deepEqual(updates,[{kind:'plugin',registryId:'official',entryKey:'design-package',version:'2.0.0',checksum:otherChecksum}]);
    assert.deepEqual(updateTargets,[resourceRef]);
    reset();resource.access={canRead:true,canUse:true,canEdit:true,canManage:true};offered=presentation(resource);packageDescriptor=packageView(resource);store=storeList(resource);
    const alias=resource.metadata.legacyResourceId;
    render(<Detail reference={alias} />);await screen.findByTestId('package-detail-store-update');fireEvent.click(screen.getByTestId('package-detail-store-update'));
    assert(requests.some(request=>request.path===`/api/capabilities/resources/${encodeURIComponent(alias)}`),'legacy URL alias is freshly resolved by the resource API');
    assert.deepEqual(updateTargets,[resourceRef],'review update uses the fresh canonical exact resource, not the URL alias or a name');
    assert.deepEqual(updates,[{kind:'plugin',registryId:'official',entryKey:'design-package',version:'2.0.0',checksum:otherChecksum}]);
    reset();resource.access={canRead:true,canUse:true,canEdit:true,canManage:true};offered=presentation(resource);store=storeList(resource);
    const selectedStoreResource=store.installed.resources[0];
    store.installed.resources=Array.from({length:20},(_,index)=>({...selectedStoreResource,metadata:{...selectedStoreResource.metadata,resourceRef:`unrelated-page-one-${index}`}}));
    store.stores[0].installedResources=[selectedStoreResource];
    render(<Detail />);await screen.findByTestId('package-detail-store-update');assert.equal(updates.length,0,'selected exact variant outside top-level page one retains its verified update');
    reset();resource.access={canRead:true,canUse:true,canEdit:true,canManage:true};offered=presentation(resource);store=storeList(resource);store.stores[0].offerings[0].installedResourceRefs=[otherRef];
    render(<Detail />);await screen.findByText('Design workspace');assert(!screen.queryByTestId('package-detail-store-update'),'same-name offering never authorizes an update');
    reset();resource.access={canRead:true,canUse:true,canEdit:true,canManage:true};offered=presentation(resource);store=storeList(resource);store.installed.resources[0].storeState!.origin='derived';
    render(<Detail />);await screen.findByText('Design workspace');assert(!screen.queryByTestId('package-detail-store-update'),'derived resource has no direct upstream update');

    reset();let release!:()=>void;heldBase=new Promise<void>(resolve=>{release=resolve;});const view=render(<Detail />);
    resource=descriptor(otherRef);offered=presentation(resource);packageDescriptor=packageView(resource);heldBase=undefined;
    view.rerender(<Detail reference={otherRef} workspace="team-research" />);assert(!document.body.textContent?.includes('Design workspace'));
    await screen.findByText('Research workspace');await act(async()=>release());assert(!document.body.textContent?.includes('Design workspace'),'late response for a prior selection cannot rehydrate its name');
    assert(requests.filter(request=>request.path.includes(encodeURIComponent(otherRef))).every(request=>request.workspace==='team-research'));
    reset();metadataStatus=404;presentationStatus=404;render(<Detail />);await screen.findByText('This package is no longer available in this workspace. Check its sharing permissions.');
    assert(!screen.queryByTestId('package-detail-title'));assert(!screen.queryByTestId('package-editor'));assert(!document.body.textContent?.includes('PRIVATE_ERROR_BODY'));
    reset();presentationStatus=503;resource.access={canRead:true,canUse:true,canEdit:true,canManage:true};store=storeList(resource);render(<Detail />);
    await screen.findByText('Package declarations could not be verified. Reload before reviewing requirements or updating this package.');assert(!screen.queryByTestId('package-detail-store-update'));
    reset();packageDescriptor.resource=descriptor(otherRef).metadata;
    render(<Detail initialTask="versions" />);await screen.findByTestId('package-detail-versions');
    await screen.findByText('This package is no longer available in this workspace. Check its sharing permissions.');assert(!screen.queryByText('Current'));

    reset();resource.metadata.resourceType='skill';resource.artifact.resourceType='skill';resource.artifact.name='design-context';resource.metadata.sourceType='plugin';resource.metadata.sourcePluginId=otherRef;
    resource.artifact.sourceType='plugin';resource.artifact.sourcePluginId=otherRef;offered=presentation(resource);offered.readOnly=true;
    render(<Detail />);await screen.findByTestId('package-detail-parent');fireEvent.click(screen.getByTestId('package-detail-parent'));assert.equal(navigation[0].resourceRef,otherRef);
    reset();resource.access.canEdit=true;packageDescriptor=packageView(resource);localStorage.setItem(`canvas-private-package-draft:${resourceRef}:team-design`,draftRef);
    render(<Detail initialTask="content" selectedFile="README.md" />);
    const dirtyDetail=await screen.findByTestId('package-file-content') as HTMLTextAreaElement;await waitFor(()=>assert.equal(dirtyDetail.value,'saved text'));
    fireEvent.change(dirtyDetail,{target:{value:'Keep this draft text'}});window.confirm=()=>false;
    fireEvent.click(screen.getByTestId('package-detail-back'));assert.equal(closeCount,0);
    fireEvent.mouseDown(screen.getByTestId('package-detail-tab-versions'),{button:0});assert.equal(navigation.length,0);assert.equal(dirtyDetail.value,'Keep this draft text');
    const beforeDirtyReload=requests.length;fireEvent.click(screen.getByTestId('package-detail-reload'));assert.equal(requests.length,beforeDirtyReload);assert.equal(dirtyDetail.value,'Keep this draft text');
    assert(!requests.some(request=>request.method!=='GET'),'cancelled navigation cannot discard or publish a dirty draft');

    // Actual Editor mounts exercise the additive deep link after current descriptor/tree, with no implicit draft or write.
    reset();render(intl(<PackageEditorSection resourceRef={resourceRef} workspaceId="team-design" initiallyOpen initialFile="README.md" />));
    const initial=await screen.findByTestId('package-file-content') as HTMLTextAreaElement;await waitFor(()=>assert.equal(initial.value,'saved text'));
    assert(requests.findIndex(request=>request.path.endsWith('/file'))>requests.findIndex(request=>request.path.endsWith('/tree')));
    assert(requests.every(request=>request.method==='GET'));assert(!requests.some(request=>request.path.endsWith('/drafts')));
    reset();packageDescriptor.published={...history(resource),contractVersion:1,files:[{path:'README.md',size:10,checksum}],totalBytes:10,
      sourceResourceRef:resourceRef,sourceRevisionRef:null,sourceChecksum:checksum,sourceStamp:packageDescriptor.sourceStamp};
    render(intl(<PackageEditorSection resourceRef={resourceRef} workspaceId="team-design" initiallyOpen initialFile="README.md" />));
    await screen.findByTestId('package-file-content');assert.equal(requests.find(request=>request.path.endsWith('/file'))?.query.get('revisionRef'),revisionRef,'automatic published file read pins the observed immutable revision');
    reset();render(intl(<PackageEditorSection resourceRef={resourceRef} initiallyOpen initialFile="../outside.md" />));await screen.findByTestId('package-file-picker');
    assert(!requests.some(request=>request.path.endsWith('/file')),'only an exact current tree file may be selected automatically');
    reset();resource.access.canEdit=true;packageDescriptor=packageView(resource);
    localStorage.setItem(`canvas-private-package-draft:${resourceRef}:team-design`,draftRef);
    const editorView=render(intl(<PackageEditorSection resourceRef={resourceRef} workspaceId="team-design" initiallyOpen initialFile="README.md" />));
    const editing=await screen.findByTestId('package-file-content') as HTMLTextAreaElement;await waitFor(()=>assert.equal(editing.value,'saved text'));
    fireEvent.change(editing,{target:{value:'Unsaved user text'}});window.confirm=()=>false;assert.equal(confirmPluginNavigation(),false);
    editorView.rerender(intl(<PackageEditorSection resourceRef={resourceRef} workspaceId="team-design" initiallyOpen initialFile="notes.md" />));
    assert.equal(editing.value,'Unsaved user text');assert(!requests.some(request=>request.query.get('path')==='notes.md'));
    let releaseWrite!:()=>void;heldWrite=new Promise<void>(resolve=>{releaseWrite=resolve;});fireEvent.click(screen.getByTestId('package-save-file'));
    await waitFor(()=>assert.equal((screen.getByTestId('package-save-file') as HTMLButtonElement).disabled,true));assert.equal(confirmPluginNavigation(),false);
    await act(async()=>releaseWrite());
    assert(requests.some(request=>request.method==='PUT'),'only the explicit Save action starts a write');
    console.log('PackageDetail real React lazy requests, exact variants/rights, source update correlation, ownership, late responses and Editor guarded deep links PASS.');
  } finally {cleanup();globalThis.fetch=originalFetch;window.confirm=originalConfirm;dom.window.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
