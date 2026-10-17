import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../../app/lib/db';
import type { CapabilityPackageDraft } from '../../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageDraftPresentation } from '../../app/lib/capabilities/packages/draft-presentation-contracts';

type Packages=typeof import('../../app/lib/capabilities/packages/actions');
type Actor={userId:string;workspaceId:string};
type RequestFactory=(userId:string|null,method?:string,body?:unknown,url?:string)=>Request;
const svg=(color:string)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Account brief</title><desc>CRM facts and research become a reviewed brief.</desc><rect x="8" y="8" width="48" height="48" fill="${color}"/></svg>`;

/** Real private authoring routes, SQL state and actual passive image bytes, without publication. */
export async function verifyCapabilityPackageDraftPresentation(input:{
  packages:Packages;raw:Pick<SqlConnection,'get'|'all'|'run'>;owner:Actor;other:Actor;request:RequestFactory;
}):Promise<void>{
  const {packages,raw,owner,other,request}=input;
  const collection=await import('../../app/api/capabilities/packages/drafts/route');
  const previewRoute=await import('../../app/api/capabilities/packages/drafts/[draftRef]/presentation/route');
  const imageRoute=await import('../../app/api/capabilities/packages/drafts/[draftRef]/image/route');
  const {creatorPluginManifestTemplate}=await import('../../app/lib/plugins/creator-plugin-manifest');
  const collectionContext=()=>({params:Promise.resolve({} as Record<string,string>)});
  const context=(draftRef:string)=>({params:Promise.resolve({draftRef})});
  const data=async<T>(response:Response,status=200):Promise<T>=>{
    assert.equal(response.status,status,await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    return (await response.json() as {data:T}).data;
  };
  const counts=async()=>Promise.all(['capability_resources','capability_package_versions','capability_package_states'].map(async table=>
    Number((await raw.get(`SELECT COUNT(*)::integer AS count FROM ${table}`) as {count:number}).count)));
  const before=await counts();
  const create=async(kind:'plugin'|'skill',name:string)=>(await data<{draft:CapabilityPackageDraft}>(await collection.POST(
    request(owner.userId,'POST',{operation:'create',kind,targetName:name,requestId:randomUUID()}),collectionContext()))).draft;
  const write=async(draft:CapabilityPackageDraft,path:string,content:string)=>(await packages.writeCapabilityPackageDraftFileAction(owner,draft.draftRef,
    {expectedDraftRevision:draft.draftRevision,path,encoding:'base64',content:Buffer.from(content).toString('base64')})).draft;
  const req=(draft:CapabilityPackageDraft,actor=owner.userId,revision:number|undefined=draft.draftRevision)=>request(actor,'GET',undefined,
    `http://localhost/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/presentation${revision===undefined?'':`?expectedDraftRevision=${revision}`}`);
  const preview=async(draft:CapabilityPackageDraft)=>data<CapabilityPackageDraftPresentation>(await previewRoute.GET(req(draft),context(draft.draftRef)));
  const image=async(draft:CapabilityPackageDraft,revision=draft.draftRevision)=>imageRoute.GET(req(draft,owner.userId,revision),context(draft.draftRef));
  const preserved=async(draft:CapabilityPackageDraft)=>{
    assert.equal(Number((await raw.get('SELECT draft_revision FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2',[draft.draftRef,owner.userId]) as {draft_revision:number}).draft_revision),draft.draftRevision);
    assert.deepEqual(await counts(),before,'A private preview/image never adopts a resource, publishes a version or changes a package head.');
  };
  let draft=await create('plugin','draft-presentation-fixture');
  const empty=await preview(draft);
  assert.equal(empty.origin,'draft');assert.equal(empty.draftRef,draft.draftRef);assert.equal(empty.draftRevision,draft.draftRevision);
  assert.equal(empty.previewIncomplete,true);assert.equal(empty.presentation,null);assert.deepEqual(empty.skills,[]);assert.equal(empty.imageAvailable,false);
  assert.deepEqual(empty.authoring,{operation:'create',intendedAudience:'not_specified',captures:[],capturesTruncated:false});
  for(const field of ['resourceRef','publishedRevisionRef','sourceStampCurrent','canUse','runtimeReadiness'])assert.equal(Object.hasOwn(empty,field),false,
    'A private preview never fabricates installed or executable authority.');
  assert.match(empty.checksum,/^[a-f0-9]{64}$/u);
  assert.equal((await image(draft)).status,404);await preserved(draft);
  const child='account-context';
  const manifest={...structuredClone(creatorPluginManifestTemplate),name:draft.name,
    description:'Prepare a concise account brief from current authorized facts.',
    interface:{displayName:'Account Brief',shortDescription:'CRM and research become a brief.',logo:'./assets/logo.svg'},
    connectors:{mcp:[{name:'research',label:'Company Research',required:true,env:['RESEARCH_KEY']}],
      composio:[{toolkit:'hubspot',label:'HubSpot',required:true}]},
    workflow:{version:1,integrationCapabilities:[
      {id:'research',application:'research',required:true,alternatives:[{source:'mcp',connector:'research'}],skillRefs:[child]},
      {id:'crm',application:'hubspot',required:true,alternatives:[{source:'composio',toolkit:'hubspot'}],skillRefs:[child]},
    ]}};
  draft=await write(draft,'.canvas-plugin/plugin.json',JSON.stringify(manifest));
  draft=await write(draft,`skills/${child}/SKILL.md`,`---\nname: ${child}\ndescription: Prepare a source-backed account brief\nmetadata:\n  version: "1.0.0"\n---\nKeep facts and missing evidence visible.\n`);
  draft=await write(draft,`skills/${child}/agents/canvas.yaml`,'interface:\n  display_name: Account Context\n  short_description: Read facts for the brief\n');
  draft=await write(draft,`skills/${child}/references/example/SKILL.md`,'---\nname: example\ndescription: An embedded instruction example, not another plugin skill\n---\nExample only.\n');
  draft=await write(draft,'assets/logo.svg',svg('#17614B'));
  const complete=await preview(draft);
  assert.equal(complete.previewIncomplete,false);assert.equal(complete.title,'Account Brief');assert.equal(complete.version,'1.0.0');
  assert.equal(complete.ownership.type,'organization');assert.equal(complete.imageAvailable,true);
  assert.deepEqual(complete.skills.map(skill=>[skill.name,skill.title,skill.version,skill.path]),[[child,'Account Context','1.0.0',`skills/${child}/SKILL.md`]]);
  assert.equal(complete.skillsTruncated,false);assert.equal(complete.presentation?.children.length,1);
  assert.equal(complete.skills[0]?.origin,'not_recorded','A directly authored child is not mislabeled as a captured source.');
  assert(complete.presentation?.capabilities.some(capability=>capability.id==='research'&&capability.required));
  assert(complete.presentation?.capabilities.some(capability=>capability.id==='crm'&&capability.required));
  assert(complete.presentation?.requirements.some(requirement=>requirement.source==='mcp'&&requirement.selector?.source==='mcp'&&requirement.selector.connector==='research'));
  assert(complete.presentation?.requirements.some(requirement=>requirement.source==='composio'&&requirement.selector?.source==='composio'&&requirement.selector.toolkit==='hubspot'));
  assert.deepEqual(complete.presentation?.requiredEnv,['RESEARCH_KEY']);
  assert(!JSON.stringify(complete).includes('rootPath'));assert(!JSON.stringify(complete).includes('/capability-packages/'));
  const bytes=await image(draft);assert.equal(bytes.status,200,await bytes.clone().text());
  assert.equal(bytes.headers.get('Content-Type'),'image/svg+xml');assert.equal(bytes.headers.get('Cache-Control'),'private, no-store');
  assert.equal(bytes.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(bytes.headers.get('Content-Security-Policy'),"default-src 'none'; sandbox");
  assert.equal(Buffer.from(await bytes.arrayBuffer()).toString('utf8'),svg('#17614B'));
  assert.equal((await imageRoute.GET(request(owner.userId),context(draft.draftRef))).status,400,'Binary requests require the exact current revision.');
  assert.equal((await previewRoute.GET(req(draft,other.userId),context(draft.draftRef))).status,404);
  assert.equal((await imageRoute.GET(req(draft,other.userId),context(draft.draftRef))).status,404);
  assert.equal((await previewRoute.GET(request(null),context(draft.draftRef))).status,401);
  const foreign=req(draft);foreign.headers.set('x-canvas-workspace-id',other.workspaceId);
  assert.equal((await previewRoute.GET(foreign,context(draft.draftRef))).status,403,'The owner cannot borrow another actor’s private workspace.');
  const foreignImage=req(draft);foreignImage.headers.set('x-canvas-workspace-id',other.workspaceId);
  assert.equal((await imageRoute.GET(foreignImage,context(draft.draftRef))).status,403);
  await raw.run('UPDATE organization_user_permissions SET can_share_plugins_and_skills=0 WHERE user_id=$1',[owner.userId]);
  try{
    assert.equal((await previewRoute.GET(req(draft),context(draft.draftRef))).status,403);
    assert.equal((await image(draft)).status,403,'Revoked creation rights close image reads as well as metadata.');
  }finally{await raw.run('UPDATE organization_user_permissions SET can_share_plugins_and_skills=1 WHERE user_id=$1',[owner.userId]);}
  await preserved(draft);
  const prior=draft;
  draft=await write(draft,'assets/logo.svg',svg('#2458A4'));
  assert.equal((await previewRoute.GET(req(draft,owner.userId,prior.draftRevision),context(draft.draftRef))).status,409);
  assert.equal((await image(draft,prior.draftRevision)).status,409);
  const current=await preview(draft);assert.notEqual(current.checksum,complete.checksum);
  const currentImage=await image(draft);assert.equal(currentImage.status,200);
  assert.equal(Buffer.from(await currentImage.arrayBuffer()).toString('utf8'),svg('#2458A4'),'A new draft revision serves its new bytes without a stale preview cache.');
  draft=(await packages.deleteCapabilityPackageDraftFileAction(owner,draft.draftRef,{expectedDraftRevision:draft.draftRevision,path:'assets/logo.svg'})).draft;
  assert.equal((await preview(draft)).imageAvailable,false);assert.equal((await image(draft)).status,404);await preserved(draft);
  draft=await write(draft,'assets/logo.svg','<svg xmlns="http://www.w3.org/2000/svg"><script>run()</script></svg>');
  assert.equal((await preview(draft)).imageAvailable,false);assert.equal((await image(draft)).status,404,'Active SVG bytes are never delivered.');await preserved(draft);
  let standalone=await create('skill','draft-presentation-standalone');
  standalone=await write(standalone,'SKILL.md','---\nname: draft-presentation-standalone\ndescription: Reusable source review\nmetadata:\n  version: "1.0.0"\n---\nReview supplied facts.\n');
  standalone=await write(standalone,'agents/canvas.yaml','interface:\n  display_name: Standalone Review\n  icon_small: ./assets/logo.svg\n');
  standalone=await write(standalone,'assets/logo.svg',svg('#17614B'));
  const standalonePreview=await preview(standalone);
  assert.equal(standalonePreview.kind,'skill');assert.equal(standalonePreview.title,'Standalone Review');
  assert.equal(standalonePreview.previewIncomplete,false);assert.equal(standalonePreview.imageAvailable,true);
  assert.equal(standalonePreview.skills[0]?.path,'SKILL.md');assert.equal((await image(standalone)).status,200);await preserved(standalone);
  let rootSkill=await create('plugin','draft-presentation-root-skill');
  rootSkill=await write(rootSkill,'.canvas-plugin/plugin.json',JSON.stringify({...structuredClone(creatorPluginManifestTemplate),name:rootSkill.name,skills:'.'}));
  rootSkill=await write(rootSkill,'SKILL.md','---\nname: root-protocol\ndescription: The manifest-declared root skill owns this plugin\nmetadata:\n  version: "1.0.0"\n---\nFollow the root protocol.\n');
  rootSkill=await write(rootSkill,'nested-child/SKILL.md','---\nname: nested-child\ndescription: Root discovery must suppress this child\n---\nNot a separate runtime skill.\n');
  const rootSkillPreview=await preview(rootSkill);
  assert.equal(rootSkillPreview.previewIncomplete,false);
  assert.deepEqual(rootSkillPreview.skills.map(skill=>[skill.name,skill.path]),[['root-protocol','SKILL.md']],
    'The manifest-declared root skill uses the actual loader semantics and suppresses child discovery.');
  assert.deepEqual(rootSkillPreview.presentation?.children.map(skill=>skill.name),['root-protocol']);await preserved(rootSkill);

  // Exercise genuine capture provenance, then a later manual edit. No DTO invents copy equality.
  let source=await create('skill','draft-presentation-capture-source');
  source=await write(source,'SKILL.md','---\nname: draft-presentation-capture-source\ndescription: Review exact source facts\nmetadata:\n  version: "1.0.0"\n---\nUse the captured instructions.\n');
  const published=await packages.publishCapabilityPackageDraftAction(owner,{draftRef:source.draftRef,requestId:randomUUID(),
    expectedDraftRevision:source.draftRevision,expectedPackageRevision:0,expectedPublishedRevisionRef:null,expectedMetadataRevision:0,expectedGrantsRevision:0});
  draft=await write(draft,'assets/logo.svg',svg('#17614B'));
  const composition=await import('../../app/lib/capabilities/packages/composition');
  draft=(await composition.composeCapabilityPackageSkillsAction(owner,draft.draftRef,{expectedDraftRevision:draft.draftRevision,skills:[{
    source:{resourceRef:published.state.resourceRef,revisionRef:published.published.revisionRef,expectedChecksum:published.published.checksum},
    targetName:'captured-facts',targetVersion:'1.0.1'}]})).draft;
  const beforeCapturedPreview=await counts();
  const captured=await preview(draft);
  assert.deepEqual(captured.authoring,{operation:'create',intendedAudience:'not_specified',captures:[{source:'package',
    sourceName:source.name,sourceVersion:'1.0.0',targetName:'captured-facts',targetVersionAtCapture:'1.0.1',versionChangedAtCapture:true,adjustmentsAtCapture:['name']}],capturesTruncated:false});
  assert.equal(captured.skills.find(skill=>skill.name==='captured-facts')?.origin,'captured');
  assert.equal(captured.skills.find(skill=>skill.name===child)?.origin,'not_recorded');
  const privateCaptureJson=JSON.stringify(captured.authoring);
  for(const privateField of ['storage','parentStorage','ownerUserId','workspaceId','workspaceDraftId','resourceRef','revisionRef','account','rootPath','selectedChildChecksum']) {
    assert.equal(Object.hasOwn(captured.authoring.captures[0],privateField),false,`Private capture field ${privateField} is never projected.`);
  }
  assert(!privateCaptureJson.includes(published.state.resourceRef));assert(!privateCaptureJson.includes(owner.userId));
  assert.deepEqual(await counts(),beforeCapturedPreview,'Capture presentation cannot publish or adopt another resource.');
  draft=await write(draft,'skills/captured-facts/SKILL.md','---\nname: captured-facts\ndescription: Manually revised after capture\nmetadata:\n  version: "2.0.0"\n---\nThese instructions were manually changed.\n');
  const revised=await preview(draft);
  assert.equal(revised.skills.find(skill=>skill.name==='captured-facts')?.version,'2.0.0');
  assert.deepEqual(revised.authoring.captures,captured.authoring.captures,'Historical capture versions stay at capture; current manual version is independent.');
  console.log('PASS Draft presentation: actual authenticated routes/SQL/files, empty and canonical plugin/standalone skill, loader-consistent children/root skills excluding nested examples, requirements and exact passive image bytes, headers, stale revisions, foreign actor/workspace, revoked rights, changed/missing/active image fallback, preserved private drafts and no publication/resource side effects.');
}
