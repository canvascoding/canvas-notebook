import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const previousTmpdir=process.env.TMPDIR;
  process.env.TMPDIR=fixture.root;
  const {sql, registry, owner, alice} = fixture;
  try {
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const presentation = await import('../app/lib/capabilities/packages/presentation-actions');
    const {isCapabilityPackageError} = await import('../app/lib/capabilities/packages/contracts');
    const {CapabilityResourceError} = await import('../app/lib/capabilities/resources/contracts');
    const secret = 'PRIVATE_PRESENTATION_SOURCE_CONTENT';
    const name = 'presentation-package';
    const script = JSON.stringify({version:1,scripts:[{id:'inspect',displayName:'Inspect layout',description:'Bounded declared operation',runtime:{kind:'node',minimumVersion:'22.0.0'},
      path:'scripts/main.cjs',argumentsSchema:{type:'object',properties:{privateDefault:{type:'string',default:secret}}},tools:[],outputs:[]}]});
    const files = {
      '.canvas-plugin/plugin.json': JSON.stringify({name,version:'1.0.0',description:'Verified presentation',license:'MIT',skills:'skills',interface:{displayName:'Presentation Bundle'},
        connectors:{mcp:[{name:'design-server',label:'Design MCP',required:false,recommended:true,env:['CANVAS_TEST_KEY'],configPath:'config/mcp.json'}],
          composio:[{toolkit:'canva',label:'Canva account',required:true}],email:[{kind:'mailbox',label:'Canvas mailbox',required:false,recommended:true}]},
        workflow:{version:1,integrationCapabilities:[{id:'design',application:'canva',required:true,alternatives:[{source:'mcp',connector:'design-server'},{source:'composio',toolkit:'canva'}]}]}}),
      'skills/presentation-context/SKILL.md':'---\nname: presentation-context\ndescription: Readable context\ncompatibility: Requires Canvas and Node\nlicense: MIT\n---\n'+secret,
      'skills/presentation-context/agents/canvas.yaml':'interface:\n  display_name: Presentation Context\nworkflow:\n  version: 1\n  integrationCapabilities:\n    - id: child-design\n      application: canva\n      alternatives:\n        - source: mcp\n          connector: design-server\n',
      'skills/presentation-context/.canvas-skill/runtime.json':script,
      'skills/presentation-context/scripts/main.cjs':`throw new Error('${secret}: script execution forbidden');\n`,
      'config/mcp.json':JSON.stringify({mcpServers:{'design-server':{url:'https://mcp.example.test/design',headers:{Authorization:`Bearer ${secret}`},
        env:{CANVAS_TEST_KEY:secret,REFERENCED_KEY:'${CANVAS_TEST_KEY}'},cwd:fixture.root,
        oauth:{clientSecret:secret,authorizationUrl:'https://oauth.example.test/authorize'}},
        private:{url:'https://private.example.test/secret',headers:{Authorization:`Bearer ${secret}`}}}}),
      'README.md':secret,
    };
    const source = await registry.addPackage('application','plugin',name,'1.0.0',files,plugins.computeCanvasPluginChecksum);
    const selection={kind:'plugin' as const,registryId:'store-application',entryKey:name,version:'1.0.0',checksum:source.checksum};
    const counts = async()=>Promise.all(['capability_resources','capability_package_states','capability_package_versions','capability_resource_history'].map(async table=>(await sql.get(`SELECT COUNT(*)::int AS count FROM ${table}`) as {count:number}).count));
    const tempRoots=async()=>new Set((await fs.readdir(os.tmpdir())).filter(value=>/^canvas-(?:plugin-store-|skill-store-|package-presentation-|store-seed-check-)/u.test(value)));
    const before=await counts(), temporary=await tempRoots();
    const offered=await presentation.inspectCapabilityPackageStoreOfferingAction(owner,{source:selection});
    assert.equal(offered.name,name);assert.equal(offered.title,'Presentation Bundle');assert.equal(offered.version,'1.0.0');assert.equal(offered.license,'MIT');
    assert.deepEqual(offered.children.map(child=>child.name),['presentation-context']);
    assert.deepEqual(offered.requiredEnv,['CANVAS_TEST_KEY']);assert.equal(offered.requirements.find(requirement=>requirement.source==='composio')?.required,true);
    assert.deepEqual(offered.capabilities[0].alternatives,[{source:'mcp',label:'Design MCP',selector:{source:'mcp',connector:'design-server'}},
      {source:'composio',label:'canva',selector:{source:'composio',toolkit:'canva'}}]);
    assert.deepEqual(offered.requirements.find(requirement=>requirement.source==='composio')?.selector,{source:'composio',toolkit:'canva'});
    assert.deepEqual(offered.capabilities[1].alternatives[0].selector,{source:'mcp',connector:'design-server'});
    assert.equal(offered.capabilities[1].declaredBy.name,'presentation-context');assert.equal(offered.scripts[0].title,'Inspect layout');
    assert.deepEqual(offered.scripts[0].runtime,{kind:'node',minimumVersion:'22.0.0'});assert.deepEqual(offered.compatibility,['Requires Canvas and Node']);
    assert.deepEqual(await counts(),before,'Store inspection never installs/adopts/publishes');
    assert.deepEqual([...await tempRoots()].filter(root=>!temporary.has(root)),[],'every private preparation/parse directory was disposed');
    const assertPublic = (value:unknown)=>{
      const body=JSON.stringify(value);
      for(const forbidden of [secret,fixture.root,'https://private.example.test','storeOrigin','registryIdentity','packageRoot','configPath','argumentsSchema','Authorization','tools','outputs','receipt']) assert(!body.includes(forbidden),forbidden);
    };
    assertPublic(offered);assert.equal(fixture.providerRequests(),0,'declared scripts/provider tools are never executed');
    await assert.rejects(presentation.inspectCapabilityPackageStoreOfferingAction(owner,{source:{...selection,packageRoot:'/tmp/forged'}}));
    await assert.rejects(presentation.inspectCapabilityPackageStoreOfferingAction({...owner,workspaceId:'personal-alice'},{source:selection}));

    const installed=await stores.installCapabilityPackageFromStoreAction(owner,{source:selection,ownership:{type:'user'},grants:[{targetType:'user',targetId:'alice',canUse:true,canEdit:false,canManage:false}]});
    const stateBefore=await counts();
    const actual=await presentation.inspectCapabilityPackagePresentationAction(alice,installed.resource.resourceRef);
    assert.equal(actual.origin,'installed');assert.equal(actual.resourceRef,installed.resource.resourceRef);assertPublic(actual);assert.deepEqual(await counts(),stateBefore);
    const all=await resources.listCapabilityResources(owner);
    const child=all.find(resource=>resource.artifact.resourceType==='skill'&&resource.artifact.sourcePluginId===installed.resource.legacyResourceId);
    assert(child);
    const actualChild=await presentation.inspectCapabilityPackagePresentationAction(alice,child.metadata.resourceRef);
    assert.equal(actualChild.kind,'skill');assert.equal(actualChild.version,'1.0.0','child without declared version uses actual artifact version');
    assert.equal(actualChild.readOnly,true);assert.equal(actualChild.capabilities[0].alternatives[0].label,'Design MCP');
    assert.equal(actualChild.capabilities.length,1,'parent workflow groups are not implicitly inherited by the child');
    assert.equal(actualChild.capabilities[0].declaredBy.name,'presentation-context');
    assert.deepEqual(actualChild.requiredEnv,['CANVAS_TEST_KEY']);
    assert.deepEqual(actualChild.requirements.find(requirement=>requirement.source==='composio'),{declaredBy:{kind:'plugin',name},source:'composio',label:'Canva account',required:true,recommended:false,selector:{source:'composio',toolkit:'canva'}});assertPublic(actualChild);
    const templateBefore=await counts();
    const template=await presentation.inspectCapabilityPackageMcpTemplateAction(alice,installed.resource.resourceRef,{connector:'design-server'});
    assert.equal(template.resourceRef,installed.resource.resourceRef);assert.equal(template.source.resourceRef,installed.resource.resourceRef);
    assert.deepEqual(template.declaredBy,{kind:'plugin',name});assert.equal(template.connector.name,'design-server');
    assert.equal(template.config?.url,'https://mcp.example.test/design');
    assert.deepEqual(template.config?.env,{CANVAS_TEST_KEY:'',REFERENCED_KEY:'${CANVAS_TEST_KEY}'});
    assert.deepEqual(template.config?.headers,{Authorization:''});assert.equal(template.config?.cwd,undefined);
    assert.deepEqual(template.config?.oauth,{authorizationUrl:'https://oauth.example.test/authorize'});
    assert(template.redactedFields.includes('oauth.clientSecret'));assert(template.redactedFields.includes('headers.Authorization'));
    const templateBody=JSON.stringify(template);
    for(const forbidden of [secret,fixture.root,'https://private.example.test','rawContent','configPath','packageRoot','storeOrigin']) assert(!templateBody.includes(forbidden),forbidden);
    const childTemplate=await presentation.inspectCapabilityPackageMcpTemplateAction(alice,child.metadata.resourceRef,{connector:'design-server'});
    assert.equal(childTemplate.resourceRef,child.metadata.resourceRef);assert.equal(childTemplate.source.resourceRef,installed.resource.resourceRef);
    assert.deepEqual(childTemplate.config,template.config,'child uses the exact authorized containing plugin declaration');
    const {GET:templateGET}=await import('../app/api/capabilities/packages/[resourceRef]/mcp-template/route');
    const templateUrl=`http://localhost:3001/api/capabilities/packages/${encodeURIComponent(installed.resource.resourceRef)}/mcp-template`;
    const templateWeb=await templateGET(new Request(`${templateUrl}?connector=design-server&expectedChecksum=${template.source.checksum}`,{
      headers:fixture.headers('alice'),
    }),{params:Promise.resolve({resourceRef:installed.resource.resourceRef})});
    assert.equal(templateWeb.status,200);assert.deepEqual(await templateWeb.json(),{success:true,data:{template}});
    for(const [query,status] of [['connector=missing',404],['connector=design-server&expectedChecksum='+ '0'.repeat(64),409],
      ['connector=design-server&connector=private',400],['connector=design-server&packageRoot=/tmp/forged',400]] as const) {
      const response=await templateGET(new Request(`${templateUrl}?${query}`,{headers:fixture.headers('alice')}),{params:Promise.resolve({resourceRef:installed.resource.resourceRef})});
      assert.equal(response.status,status,query);
    }
    await assert.rejects(presentation.inspectCapabilityPackageMcpTemplateAction(fixture.actor('unassigned'),installed.resource.resourceRef,{connector:'design-server'}));
    await assert.rejects(presentation.inspectCapabilityPackageMcpTemplateAction({...alice,workspaceId:'personal-owner'},installed.resource.resourceRef,{connector:'design-server'}));
    assert.deepEqual(await counts(),templateBefore,'Template inspection never adopts/installs/publishes or grants a connection');
    assert.equal(fixture.providerRequests(),0,'Template inspection never connects or executes a provider');
    const core=all.find(resource=>resource.artifact.name==='find-skills'&&resource.artifact.sourceType==='core');assert(core);
    const corePresentation=await presentation.inspectCapabilityPackagePresentationAction(owner,core.metadata.resourceRef);assert.equal(corePresentation.readOnly,true);
    await assert.rejects(presentation.inspectCapabilityPackagePresentationAction(fixture.actor('unassigned'),installed.resource.resourceRef));
    await assert.rejects(presentation.inspectCapabilityPackagePresentationAction({...alice,workspaceId:'personal-owner'},installed.resource.resourceRef));

    // The real AgentTool boundary uses persisted actors/sessions, never caller-supplied source paths or identities.
    const agents=await import('../app/lib/agents/registry'),{piSessions}=await import('../app/lib/db/schema');
    const toolNames=['inspect_canvas_package_presentation','inspect_canvas_package_store_offering','inspect_canvas_package_store_install_options'];
    for(const userId of ['owner','alice']) {
      await agents.createAgentProfile({agentId:`presentation-${userId}`,name:'Presentation specialist',scopeType:'user',ownerUserId:userId,
        organizationId:fixture.organizationId,createdByUserId:userId,enabledTools:toolNames});
      await fixture.database.db.insert(piSessions).values({sessionId:`presentation-${userId}-session`,userId,agentId:`presentation-${userId}`,workspaceId:`personal-${userId}`,
        workspaceType:'personal',organizationId:fixture.organizationId,provider:'fixture',model:'fixture',createdAt:new Date(),updatedAt:new Date()});
    }
    const {createCapabilityPackageTools}=await import('../app/lib/pi/scoped-tools');
    const {runWithAgentExecutionContext}=await import('../app/lib/pi/agent-execution-context');
    const {resolveAgentExecutionContextForStoredSession}=await import('../app/lib/pi/session-workspace-context');
    const toolContext=await resolveAgentExecutionContextForStoredSession({userId:'owner',agentId:'presentation-owner',sessionId:'presentation-owner-session'});
    const readerContext=await resolveAgentExecutionContextForStoredSession({userId:'alice',agentId:'presentation-alice',sessionId:'presentation-alice-session'});
    const tools=createCapabilityPackageTools('owner','presentation-owner','presentation-owner-session');
    const invoke=async(name:string,args:unknown)=>{
      const tool=tools.find(item=>item.name===name);assert(tool);
      return runWithAgentExecutionContext(toolContext,()=>tool.execute(`presentation-${name}`,args));
    };
    const toolCounts=await counts();
    const toolInstalled=await invoke('inspect_canvas_package_presentation',{resourceRef:installed.resource.resourceRef});
    const toolOffered=await invoke('inspect_canvas_package_store_offering',{source:selection});
    for(const result of [toolInstalled,toolOffered]) {
      const details=result.details as {error?:string;capabilityPackage?:{result:unknown}};
      assert.equal(details.error,undefined);assert(details.capabilityPackage);assertPublic(details);
      for(const content of result.content) if(content.type==='text') assertPublic(JSON.parse(content.text));
    }
    assert.deepEqual(await counts(),toolCounts,'AgentTool previews make no package/resource writes');
    const rejectedArchives=registry.count('archive');
    for(const [name,args] of [
      ['inspect_canvas_package_presentation',{resourceRef:installed.resource.resourceRef,actorUserId:'alice'}],
      ['inspect_canvas_package_presentation',{resourceRef:installed.resource.resourceRef,packageRoot:'/tmp/forged'}],
      ['inspect_canvas_package_store_offering',{source:selection,actorUserId:'alice'}],
      ['inspect_canvas_package_store_offering',{source:{...selection,registryUrl:'https://forged.example.test'}}],
      ['inspect_canvas_package_store_offering',{source:{...selection,packageRoot:'/tmp/forged'}}],
    ] as const) {
      const result=await invoke(name,args);assert.equal((result.details as {code:string}).code,'PACKAGE_REQUEST_INVALID');assertPublic(result.details);
    }
    const storeTool=tools.find(item=>item.name==='inspect_canvas_package_store_offering');assert(storeTool);
    const noContext=await storeTool.execute('presentation-no-context',{source:selection});
    assert.equal((noContext.details as {code:string}).code,'PACKAGE_ACCESS_DENIED');
    const foreignContext=await runWithAgentExecutionContext(readerContext,()=>storeTool.execute('presentation-foreign-context',{source:selection}));
    assert.equal((foreignContext.details as {code:string}).code,'PACKAGE_ACCESS_DENIED');
    const missingSessionTool=createCapabilityPackageTools('owner','presentation-owner','missing-presentation-session').find(item=>item.name===storeTool.name);assert(missingSessionTool);
    const mismatchedSession=await runWithAgentExecutionContext(toolContext,()=>missingSessionTool.execute('presentation-missing-session',{source:selection}));
    assert.equal((mismatchedSession.details as {code:string}).code,'PACKAGE_ACCESS_DENIED');
    assert.equal(registry.count('archive'),rejectedArchives,'invalid arguments and context cannot fetch archives');
    assert.deepEqual(await counts(),toolCounts);
    const {filterToolsForPlanningMode,PLANNING_MODE_ALLOWED_TOOLS}=await import('../app/lib/pi/planning-mode');
    const planningNames=filterToolsForPlanningMode(tools).map(tool=>tool.name);
    assert(PLANNING_MODE_ALLOWED_TOOLS.has('inspect_canvas_package_presentation'));
    assert(PLANNING_MODE_ALLOWED_TOOLS.has('inspect_canvas_package_store_install_options'));
    assert(!PLANNING_MODE_ALLOWED_TOOLS.has('inspect_canvas_package_store_offering'));
    assert(planningNames.includes('inspect_canvas_package_presentation'));assert(!planningNames.includes('inspect_canvas_package_store_offering'));
    assert.equal(registry.count('archive'),rejectedArchives,'planning filtering never downloads archives');

    const pointer=(await plugins.readCanvasPluginRegistry(fixture.userScope('owner'))).plugins[name];
    const originalReadme=await fs.readFile(path.join(pointer.installDir,'README.md'));
    let tampered=false;
    fixture.setBeforeRead(async query=>{
      if(!tampered&&query.startsWith('SELECT pg_advisory_xact_lock')) {
        tampered=true; await fs.chmod(path.join(pointer.installDir,'README.md'),0o600);
        await fs.writeFile(path.join(pointer.installDir,'README.md'),'Late actual source change');
      }
    });
    await assert.rejects(presentation.inspectCapabilityPackagePresentationAction(alice,installed.resource.resourceRef),error=>isCapabilityPackageError(error)&&error.status===409);
    fixture.setBeforeRead(undefined);assert(tampered);await fs.writeFile(path.join(pointer.installDir,'README.md'),originalReadme);
    assert.deepEqual([...await tempRoots()].filter(root=>!temporary.has(root)),[],'late source-byte rejection cleans captured private roots');

    let registryReads=0;
    fixture.setBeforeFetch(async url=>{
      if(new URL(url).pathname.startsWith('/registry/')&&++registryReads===2) process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL=registry.registryUrl('different-source');
    });
    await assert.rejects(presentation.inspectCapabilityPackageStoreOfferingAction(owner,{source:selection}),error=>isCapabilityPackageError(error)&&error.status===409);
    fixture.setBeforeFetch(undefined);process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL=registry.registryUrl('application');
    assert.deepEqual(await counts(),stateBefore);

    // Actual metadata transport barrier: late actor revocation must deny the response, with no installation.
    let reads=0;
    fixture.setBeforeFetch(async url=>{
      if(new URL(url).pathname.startsWith('/registry/')&&++reads===2) await sql.run('UPDATE "user" SET banned=1 WHERE id=$1',['alice']);
    });
    await assert.rejects(presentation.inspectCapabilityPackageStoreOfferingAction(alice,{source:selection}));
    fixture.setBeforeFetch(undefined);await sql.run('UPDATE "user" SET banned=0 WHERE id=$1',['alice']);
    assert.deepEqual(await counts(),stateBefore);assert.deepEqual([...await tempRoots()].filter(root=>!temporary.has(root)),[]);

    const seedName='presentation-bundled-seed';
    const seedSource=await registry.addPackage('application','plugin',seedName,'1.0.0',{
      '.canvas-plugin/plugin.json':JSON.stringify({name:seedName,version:'1.0.0',description:'Bundled system source',skillRefs:[{name:'docx',source:'seed'}]}),
      'README.md':'Publicly distributed seeded metadata',
    },plugins.computeCanvasPluginChecksum);
    const seedSelection={...selection,entryKey:seedName,checksum:seedSource.checksum};
    const seedPresentation=await presentation.inspectCapabilityPackageStoreOfferingAction(owner,{source:seedSelection});
    assert.equal(seedPresentation.children[0].name,'docx');assertPublic(seedPresentation);assert.deepEqual(await counts(),stateBefore);
    let seedReads=0;
    fixture.setBeforeFetch(async url=>{
      if(new URL(url).pathname.startsWith('/registry/')&&++seedReads===3) await sql.run('UPDATE "user" SET banned=1 WHERE id=$1',['alice']);
    });
    await assert.rejects(presentation.inspectCapabilityPackageStoreOfferingAction(alice,{source:seedSelection}));
    fixture.setBeforeFetch(undefined);await sql.run('UPDATE "user" SET banned=0 WHERE id=$1',['alice']);
    assert.deepEqual([...await tempRoots()].filter(root=>!temporary.has(root)),[],'late seeded Read revoke cleans every prepared source');

    // Fresh stored rights after real source resolution cannot be replaced by the initial catalog observation.
    let revoked=false;
    fixture.setBeforeRead(async query=>{
      if(!revoked&&query.startsWith('SELECT pg_advisory_xact_lock')){revoked=true;await sql.run('DELETE FROM capability_resource_grants WHERE resource_ref=$1 AND target_id=$2',[installed.resource.resourceRef,'alice']);}
    });
    await assert.rejects(presentation.inspectCapabilityPackagePresentationAction(alice,installed.resource.resourceRef));
    fixture.setBeforeRead(undefined);assert(revoked);
    // PGlite's shared test connection rolls back the injected delete with the denied transaction.
    // Commit an independent actual revoke before comparing subsequent current-reader entry points.
    await sql.run('DELETE FROM capability_resource_grants WHERE resource_ref=$1 AND target_id=$2',[installed.resource.resourceRef,'alice']);
    const denied=await presentation.inspectCapabilityPackagePresentationAction(alice,installed.resource.resourceRef).then(
      ()=>assert.fail('Revoked reader cannot inspect package presentation'),
      (error:unknown)=>{assert(error instanceof CapabilityResourceError);return error;},
    );
    assert.equal(denied.code,'CAPABILITY_RESOURCE_NOT_FOUND');assert.equal(denied.status,404);
    const readerTool=createCapabilityPackageTools('alice','presentation-alice','presentation-alice-session').find(item=>item.name==='inspect_canvas_package_presentation');assert(readerTool);
    const deniedTool=await runWithAgentExecutionContext(readerContext,()=>readerTool.execute('presentation-revoked-reader',{resourceRef:installed.resource.resourceRef}));
    assert.deepEqual(deniedTool.details,{error:denied.message,code:denied.code},'AgentTool preserves the actual safe current-Read denial instead of a generic outage');
    const {GET}=await import('../app/api/capabilities/packages/[resourceRef]/presentation/route');
    const deniedWeb=await GET(new Request(`http://localhost:3001/api/capabilities/packages/${encodeURIComponent(installed.resource.resourceRef)}/presentation`,{
      headers:fixture.headers('alice'),
    }),{params:Promise.resolve({resourceRef:installed.resource.resourceRef})});
    assert.equal(deniedWeb.status,denied.status);assert.deepEqual(await deniedWeb.json(),{success:false,error:denied.message,code:denied.code});
    const deniedTemplateWeb=await templateGET(new Request(`${templateUrl}?connector=design-server`,{headers:fixture.headers('alice')}),{params:Promise.resolve({resourceRef:installed.resource.resourceRef})});
    assert.equal(deniedTemplateWeb.status,404,'A previously observed selector cannot bypass a current reader revoke');
    assertPublic(deniedTool.details);assert.deepEqual(await counts(),stateBefore,'Reader errors cause no resource/package mutation');
    assert.equal(fixture.providerRequests(),0);
    assert.deepEqual([...await tempRoots()].filter(root=>!temporary.has(root)),[]);
    console.log('Capability package presentation actual Store/ZIP, exact source+parent ACL, core/child metadata, scripts without execution, redaction, revocation and cleanup PASS.');
  } finally {
    try { await fixture.close(); }
    finally { if(previousTmpdir===undefined) delete process.env.TMPDIR; else process.env.TMPDIR=previousTmpdir; }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
