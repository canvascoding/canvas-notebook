import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../../app/lib/db';
import type { AgentExecutionContext } from '../../app/lib/pi/agent-execution-context';
import type { AgentTool } from '@earendil-works/pi-agent-core';

/** Real Options, persisted fixed Agent, accepted turn and actual scoped reads. */
export async function runCoreSkillSelectionCases(input: {
  raw: SqlConnection; ownerContext: AgentExecutionContext; emptyContext: AgentExecutionContext; read: AgentTool;
}): Promise<void> {
  const { raw, ownerContext, emptyContext, read } = input;
  const owner = {userId:ownerContext.userId,workspaceId:ownerContext.workspaceId,source:'api' as const};
  const skillId = 'canvas-capability:v1:skill:system:core:skill-creator';
  const { listChatExtensionOptions } = await import('../../app/lib/chat/extension-options');
  const options = await listChatExtensionOptions(owner, { operation:'search',
    target:{kind:'draft_turn',agentId:ownerContext.agentId,workspaceId:ownerContext.workspaceId},
    q:'skill-creator',types:['skill'],stock:'installed',scope:'system',limit:20 });
  assert.equal(options.operation,'search');
  if(options.operation!=='search')throw new Error('Wrong options result.');
  const choice=options.items.find(item=>item.item.id===skillId);
  assert(choice);assert.equal(choice.eligibility.action,'select');assert.equal(choice.selection?.kind,'core_skill');
  if(choice.selection?.kind!=='core_skill')throw new Error('Missing exact Core skill source.');
  assert.equal(choice.publishedVersions,undefined);
  const entry={selection:choice.selection,requirement:'required' as const,toolCap:null};
  const {loadCoreSkillSource}=await import('../../app/lib/capabilities/extensions/core-source');
  const actual=await loadCoreSkillSource('skill-creator');
  const {readExactPackageInventory}=await import('../../app/lib/capabilities/packages/io');
  assert.deepEqual(entry.selection.coreSource,actual.source);
  assert.equal(actual.source.checksum,(await readExactPackageInventory(actual.skill.directory)).checksum);
  const body=await fs.readFile(actual.skill.path,'utf8');
  const management=await import('../../app/lib/agents/management-actions');
  const fixed=await management.createManagedAgent(owner,{name:'Explicit standalone Skill Creator',scopeType:'user',
    enabledTools:['read','search_canvas_extensions'],extensions:{version:1,origin:'agent_configuration',mode:'fixed',
      selections:[entry],workflow:null,standalone:[]}});
  const stored=await raw.get('SELECT resource_type,resource_id,configuration_json FROM agent_capability_bindings WHERE agent_id=$1',[fixed.agent.agentId]) as
    {resource_type:string;resource_id:string;configuration_json:string};
  assert.equal(stored.resource_type,'skill');assert.equal(stored.resource_id,skillId);
  assert.deepEqual(JSON.parse(stored.configuration_json),{version:2,kind:'core_skill',entry});
  await raw.run(`INSERT INTO pi_sessions (session_id,user_id,agent_id,provider,model,session_kind,organization_id,workspace_id,workspace_type,workspace_name,created_at,updated_at)
    VALUES ('skill-creator-fixed',$1,$2,'fixture','offline','conversation',$3,$4,'personal',$1,1000,1000)`,
  [owner.userId,fixed.agent.agentId,ownerContext.organizationId,ownerContext.workspaceId]);
  const sessions=await import('../../app/lib/pi/session-workspace-context');
  const runtime=await import('../../app/lib/capabilities/packages/runtime-bindings');
  const effective=await import('../../app/lib/capabilities/extensions/effective-context');
  const fresh=await import('../../app/lib/skills/fresh-agent-skill-read-roots');
  const {wrapToolWithExecutionContext}=await import('../../app/lib/pi/tool-runtime-helpers');
  const fixedContext=await sessions.resolveAgentExecutionContextForSession({userId:owner.userId,sessionId:'skill-creator-fixed',agentId:fixed.agent.agentId});
  const fixedData=effective.readEffectiveExtensionContext(fixedContext);assert(fixedData);
  assert.equal(fixedData.packages.length,0);assert.equal(fixedData.corePackages?.length,1);
  assert.equal(fixedData.corePackages?.[0].kind,'core_skill');
  assert.deepEqual(fixedData.corePackages?.[0].coreSource,actual.source);
  const receipt=fixedContext.corePluginSkillBindings?.find(binding=>binding.resourceId===skillId);assert(receipt);
  assert.equal(receipt.kind,'core_skill');assert.equal(receipt.checksum,actual.source.checksum);
  const result=await wrapToolWithExecutionContext(read,fixedContext).execute('read-fixed-skill-creator',{path:actual.skill.path});
  assert(JSON.stringify(result.content).includes(JSON.stringify(body).slice(1,-1)));
  const reference=path.join(actual.skill.directory,'references/schemas.md');
  const referenceBody=await fs.readFile(reference,'utf8');
  assert(JSON.stringify((await wrapToolWithExecutionContext(read,fixedContext).execute('read-core-reference',{path:reference})).content)
    .includes(JSON.stringify(referenceBody).slice(1,-1)),'The complete seed directory, including supporting files, is readable.');
  const forged={...fixedContext,corePluginSkillBindings:structuredClone(fixedContext.corePluginSkillBindings)};
  assert(!(await fresh.resolveFreshAgentSkillReadRoots(forged)).includes(actual.skill.directory),'Cloned receipt JSON cannot grant an exact selected Core root.');
  assert(!(await runtime.loadCapabilityPackageRuntimeSkills(forged)).some(skill=>skill.name==='skill-creator'));
  const {getPiTools}=await import('../../app/lib/pi/tool-registry');
  const {buildEffectiveToolManifest}=await import('../../app/lib/pi/effective-tool-manifest');
  const tools=buildEffectiveToolManifest(await getPiTools(owner.userId,fixed.agent.agentId,'skill-creator-fixed',{executionContext:fixedContext}));
  assert.deepEqual([...tools.registeredToolNames].sort(),['canvas_extensions','read']);
  assert.deepEqual(tools.gateways.find(gateway=>gateway.toolName==='canvas_extensions')?.allowedOperationNames,['search_canvas_extensions']);
  const acceptedApi=await import('../../app/lib/capabilities/extensions/accepted-turn-selection');
  const turnApi=await import('../../app/lib/capabilities/extensions/turn-runtime');
  const intake={...ownerContext,agentTurnId:randomUUID()};
  const selection={version:1 as const,origin:'turn_reference' as const,selections:[entry]};
  const accepted=await acceptedApi.prepareAcceptedTurnExtensionSelection(intake,selection);
  const turnContext:AgentExecutionContext={...ownerContext,agentTurnId:randomUUID(),
    turnExtensions:acceptedApi.readAcceptedTurnExtensionSelection(accepted,intake).publicSelection};
  const prepared=await runtime.getAuthorizedAgentWorkflowPackageSelections(turnContext);
  turnContext.turnExtensionSource=await turnApi.reissueAcceptedTurnRuntimeSelection(turnContext,accepted,intake,{packageSelection:prepared});
  const compiled=await effective.resolveEffectiveExtensionContext(turnContext,{packageSelection:prepared});
  assert.equal(effective.readEffectiveExtensionContext(compiled)?.corePackages?.[0].kind,'core_skill');
  assert.equal(effective.isIssuedScopedIntegrationTurn(compiled),true);
  const policy=effective.readEffectiveExtensionContext(compiled)?.workflowProjection?.policy;assert(policy);
  const {isIntegrationOperationAllowed}=await import('../../app/lib/integration-tools/policy');
  assert.equal(isIntegrationOperationAllowed(policy,'mcp','call'),false);
  assert.equal(isIntegrationOperationAllowed(policy,'composio','call'),false);
  assert.deepEqual(policy.providerToolRules,[],'Core instruction selection has no provider execution rule.');
  assert(JSON.stringify((await wrapToolWithExecutionContext(read,compiled).execute('read-turn-skill-creator',{path:actual.skill.path})).content)
    .includes(JSON.stringify(body).slice(1,-1)));
  await assert.rejects(acceptedApi.prepareAcceptedTurnExtensionSelection(intake,{...selection,selections:[{...entry,
    selection:{...entry.selection,coreSource:{...entry.selection.coreSource,checksum:'0'.repeat(64)}}}]}));
  const contracts=await import('../../app/lib/capabilities/extensions/contracts');
  assert.equal(contracts.chatExtensionSelectionInputSchema.safeParse({...selection,selections:[{...entry,toolCap:[]}]}).success,false);
  assert.equal(contracts.extensionSelectionSchema.safeParse({kind:'core_skill',coreSource:{...actual.source,
    resourceRef:'canvas-capability:v1:skill:system:core:plugin-visual'}}).success,false);
  const emptyIntake={...emptyContext,agentTurnId:randomUUID()};
  const outside=await acceptedApi.prepareAcceptedTurnExtensionSelection(emptyIntake,selection);
  await assert.rejects(runtime.getAuthorizedAgentWorkflowPackageSelections({...emptyContext,agentTurnId:randomUUID(),
    turnExtensions:acceptedApi.readAcceptedTurnExtensionSelection(outside,emptyIntake).publicSelection}));
  const fixedOptions=await listChatExtensionOptions(owner,{operation:'search',target:{kind:'turn',sessionId:'skill-creator-fixed',
    expectedAgentId:fixed.agent.agentId,expectedWorkspaceId:ownerContext.workspaceId},q:'skill-creator',types:['skill'],stock:'installed',scope:'system',limit:20});
  assert(fixedOptions.operation==='search' && fixedOptions.items.some(item=>item.item.id===skillId && item.eligibility.action==='select'));
  console.log('PASS Core Skill selection: actual Chat Options, exact full inventory, persisted fixed Agent, accepted Turn, real read and supporting resource, private receipt rejection, stale hash/allowlist/null toolCap/fixed mask; no new tools or SQL pins.');
}
