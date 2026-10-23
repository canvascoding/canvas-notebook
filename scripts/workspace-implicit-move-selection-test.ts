import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest,
  type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import type { WorkspaceRequestHistoricalOrigin } from '../app/lib/workspaces/request-principal';
import { captureWorkspaceImplicitMoveSelection, decodeWorkspaceImplicitMoveSelectionRequest,
  assertWorkspaceImplicitMoveSelectionCurrent, getWorkspaceImplicitMoveSelectionBatchIdentity,
  getWorkspaceImplicitMoveSelectionDigest, getWorkspaceImplicitMoveRequestIdentity, WorkspaceImplicitMoveSelectionError }
  from '../app/lib/files/workspace-implicit-move-selection';
import { workspacePathImportPreparationFixture } from './workspace-path-import-preparation-plan-test';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Base = ReturnType<typeof workspacePathImportPreparationFixture>;
type Input = Parameters<typeof captureWorkspaceImplicitMoveSelection>[0];
function originFor(scope: Base['scope']): WorkspaceRequestHistoricalOrigin {
  return { userId: scope.ownerUserId!, sessionId: 'fixture-session', impersonatedBy: null,
    workspaceId: scope.workspaceId, workspaceType: scope.workspaceType, organizationId: scope.organizationId,
    customerId: scope.customerId, projectId: scope.projectId, ownerUserId: scope.ownerUserId,
    rootPath: scope.rootPath, rootRelativePath: scope.rootRelativePath!, legacy: false, status: 'active',
    schema: 'fixture_schema', schemaOid: 101, searchPath: 'fixture_schema, pg_catalog', databaseOid: 201 };
}
function inputFor(base: Base, sourcePath = 'folder/note.md'): Input {
  return { operationId: 'implicit-fixture-operation', kind: 'move', selections: [{ sourcePath, destinationPath: 'target/note.md' }],
    origin: originFor(base.scope), scope: base.scope, observation: base.observation };
}
function nativeFixture(text = '# Original\n') {
  return workspacePathImportPreparationFixture({ native: [['folder/note.md',text],['outside.md','# Backlink\n']], raw: [] });
}
function pristineFixture() {
  const base = workspacePathImportPreparationFixture({ native: [['folder/note.md','# Note\n'],['outside.md','# Backlink\n']], raw: [],
    extra: [{ path: 'folder/plain.txt', kind: 'file' }] });
  base.observation.privateCatalogue.push({ id: 'pristine-document', lineage_id: 'pristine-lineage', path: 'folder/plain.txt',
    workspace_id: base.scope.workspaceId, organization_id: null, status: 'active', state_version: 0,
    yjs_state_lifecycle: 'never_initialized', has_persisted_state: false, has_state_history: false, lifecycle_generation: null,
    authority: 'pristine', state_status: null, state_path: null, state_workspace_id: null, state_organization_id: null });
  return base;
}
function changedRequest(request: CollaborationAdmissionRequest, mutate: (selection: Record<string, unknown>) => void) {
  const selected = JSON.parse(request.actionPayloadText!) as Record<string, unknown>; mutate(selected);
  const actionPayloadText = JSON.stringify(selected);
  return captureCollaborationAdmissionRequest({ ...request, actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest(request.action, actionPayloadText) }).request;
}
const rejected = (operation: () => unknown) => assert.throws(operation, error => error instanceof WorkspaceImplicitMoveSelectionError);

/** Pure data regression only. Declared real Yjs/catalogue/namespace inputs do
 * not stand in for an authenticated SQL read, admission, owner or FD test.
 * Nothing executes on import; the existing fixed runner owns execution. */
export function workspaceImplicitMoveSelectionTest(): void {
  let passed = 0;
  const check = (label: string, run: () => void) => { run(); passed++; console.log('Implicit Move selection family passed:',label); };
  check('native roundtrip retains exact legacy Web operation hashes and historical SID data', () => {
    const base = nativeFixture(), input = inputFor(base), captured = captureWorkspaceImplicitMoveSelection(input);
    const before = structuredClone(input);
    assert.deepEqual(decodeWorkspaceImplicitMoveSelectionRequest(captured.request),captured.selection);
    assert.equal(captured.selection.batchId,hash(['workspace-path-operation-id-v1',base.scope.workspaceId,input.origin.userId,input.operationId]));
    assert.equal(captured.selection.requestHash,hash(['workspace-path-operation-v1',base.scope.workspaceId,'move',
      [{ sourcePath:'folder/note.md',destinationPath:'target/note.md' }],false,false,null,input.origin.userId,'user',input.origin.userId,null]));
    assert.equal(captured.selection.origin.sessionId,'fixture-session');
    assert.deepEqual(getWorkspaceImplicitMoveSelectionBatchIdentity(captured.selection),
      { batchId:captured.selection.batchId,requestHash:captured.selection.requestHash });
    assert.equal(getWorkspaceImplicitMoveSelectionDigest(captured.selection),captured.selectionDigest);
    assert.deepEqual(getWorkspaceImplicitMoveRequestIdentity({workspaceId:base.scope.workspaceId,userId:input.origin.userId,operationId:input.operationId}),
      {batchId:captured.selection.batchId,requestId:captured.request.requestId});
    assert.deepEqual(input,before); assert(Object.isFrozen(captured.selection)); assert(Object.isFrozen(captured.selection.anchors));
    assert.equal(captured.request.scopes.length,1); assert.equal(captured.request.expectedDocuments.length,2);
  });
  check('accepted native text/projection clocks do not freeze contents before final binding', () => {
    const before = nativeFixture(), after = nativeFixture('# Accepted native edit\n');
    const captured = captureWorkspaceImplicitMoveSelection(inputFor(before));
    const projection = after.observation.stage.namespace.find(entry => entry.path === 'folder/note.md')!;
    projection.filesystemIdentity = '1:999:999:900:900';
    const parent = after.observation.stage.namespace.find(entry => entry.path === 'folder')!;
    const parts = parent.filesystemIdentity!.split(':'); parent.filesystemIdentity = parent.identity = `${parts[0]}:${parts[1]}:8192:900:900`;
    for (const binding of after.observation.nativeBindings) {
      binding.expected.documentSequence += 1; binding.expected.persistedAt += 1;
      binding.expected.registryStateVersion += 1; binding.registry.stateVersion += 1;
    }
    for (const row of after.observation.privateCatalogue) row.state_version += 1;
    assertWorkspaceImplicitMoveSelectionCurrent(captured.selection,{origin:originFor(after.scope),scope:after.scope,observation:after.observation});
  });
  check('native lineage/generation/representation/schema and complete root identities remain bound', () => {
    const before = nativeFixture(), captured = captureWorkspaceImplicitMoveSelection(inputFor(before));
    for (const mutate of [
      (base: Base) => { base.observation.nativeBindings[0].expected.lineageId='replacement-lineage'; },
      (base: Base) => { base.observation.nativeBindings[0].expected.lifecycleGeneration++; },
      (base: Base) => { base.observation.nativeBindings[0].expected.representation='tiptap_blocks'; },
      (base: Base) => { base.observation.nativeBindings[0].expected.schemaVersion++; },
      (base: Base) => { base.observation.privateNativeStates.pop(); },
      (base: Base) => { base.observation.privateCatalogue.pop(); },
      (base: Base) => { base.observation.nativeBindings.push(structuredClone(base.observation.nativeBindings[0])); },
    ]) { const after=nativeFixture(); mutate(after); rejected(()=>assertWorkspaceImplicitMoveSelectionCurrent(captured.selection,
      {origin:originFor(after.scope),scope:after.scope,observation:after.observation})); }
    // A consistent incoming registry/lineage replacement keeps document ID,
    // path, generation, representation and schema unchanged. It still changes
    // root identity and must never become the final planner's new backlink.
    const incoming=nativeFixture(), binding=incoming.observation.nativeBindings.find(item=>item.expected.path==='outside.md')!;
    const replacement='incoming-replacement-lineage';
    binding.expected.lineageId=replacement;binding.registry.lineageId=replacement;binding.lineage.lineageId=replacement;
    incoming.observation.privateCatalogue.find(row=>row.id===binding.expected.documentId)!.lineage_id=replacement;
    rejected(()=>assertWorkspaceImplicitMoveSelectionCurrent(captured.selection,
      {origin:originFor(incoming.scope),scope:incoming.scope,observation:incoming.observation}));
  });
  check('physical folder includes pristine registry identity, native children and exact subtree membership', () => {
    const base = pristineFixture(), input=inputFor(base,'folder'); input.selections=[{sourcePath:'folder',destinationPath:'target/folder'}];
    const captured=captureWorkspaceImplicitMoveSelection(input);
    assert(captured.selection.anchors.some(anchor=>anchor.kind==='pristine'&&anchor.documentId==='pristine-document'));
    assert(captured.selection.anchors.some(anchor=>anchor.kind==='physical-directory'&&anchor.path==='folder'));
    assertWorkspaceImplicitMoveSelectionCurrent(captured.selection,{origin:originFor(base.scope),scope:base.scope,observation:base.observation});
    for(const mutate of [
      (next:Base)=>{ next.observation.privateCatalogue.find(row=>row.id==='pristine-document')!.id='D2'; },
      (next:Base)=>{ next.observation.privateCatalogue.find(row=>row.id==='pristine-document')!.lineage_id='D2-lineage'; },
      (next:Base)=>{ const entry=next.observation.stage.namespace.find(entry=>entry.path==='folder/plain.txt')!;entry.identity=entry.filesystemIdentity='1:99999:0:100:100'; },
      (next:Base)=>{ next.observation.stage.namespace.push({workspaceId:next.scope.workspaceId,path:'folder/new.bin',kind:'file',identity:'1:999:1:100:100',filesystemIdentity:'1:999:1:100:100',documentId:null,lifecycleGeneration:null}); },
      (next:Base)=>{ next.observation.stage.namespace=next.observation.stage.namespace.filter(entry=>entry.path!=='folder/plain.txt'); },
    ]) {const next=pristineFixture();mutate(next);rejected(()=>assertWorkspaceImplicitMoveSelectionCurrent(captured.selection,
      {origin:originFor(next.scope),scope:next.scope,observation:next.observation}));}
  });
  check('existing directory ancestors are exact and inferred-to-physical is an explicit conflict', () => {
    const base=nativeFixture(), captured=captureWorkspaceImplicitMoveSelection(inputFor(base));
    const next=nativeFixture(), parent=next.observation.stage.namespace.find(entry=>entry.path==='folder')!;
    parent.identity=parent.filesystemIdentity='1:999999:4096:100:100';
    rejected(()=>assertWorkspaceImplicitMoveSelectionCurrent(captured.selection,{origin:originFor(next.scope),scope:next.scope,observation:next.observation}));
    const inferred=nativeFixture(), virtual=inferred.observation.stage.namespace.find(entry=>entry.path==='folder')!;
    virtual.identity=`registry-directory:${'a'.repeat(64)}`;virtual.filesystemIdentity=null;
    const original=captureWorkspaceImplicitMoveSelection(inputFor(inferred));
    const physical=nativeFixture();rejected(()=>assertWorkspaceImplicitMoveSelectionCurrent(original.selection,
      {origin:originFor(physical.scope),scope:physical.scope,observation:physical.observation}));
  });
  check('outer request/actor/scope/doc identity must match the full saved selection', () => {
    const captured=captureWorkspaceImplicitMoveSelection(inputFor(nativeFixture()));
    for(const mutate of [
      (request:CollaborationAdmissionRequest)=>({...request,actorId:'other'}),
      (request:CollaborationAdmissionRequest)=>({...request,requestId:'00000000-0000-4000-8000-000000000000'}),
      (request:CollaborationAdmissionRequest)=>({...request,scopes:[...request.scopes,...request.scopes]}),
      (request:CollaborationAdmissionRequest)=>({...request,expectedDocuments:request.expectedDocuments.slice(0,1)}),
      (request:CollaborationAdmissionRequest)=>({...request,expectedDocuments:request.expectedDocuments.map(doc=>({...doc,schemaVersion:doc.schemaVersion+1}))}),
    ])rejected(()=>decodeWorkspaceImplicitMoveSelectionRequest(mutate(captured.request)));
    rejected(()=>decodeWorkspaceImplicitMoveSelectionRequest({...captured.request,extra:true} as CollaborationAdmissionRequest));
    rejected(()=>decodeWorkspaceImplicitMoveSelectionRequest({...captured.request,scopes:[{...captured.request.scopes[0],extra:true}]} as unknown as CollaborationAdmissionRequest));
  });
  check('unknown versions, extra fields, duplicates, malformed realm and retargeted operations fail', () => {
    const captured=captureWorkspaceImplicitMoveSelection(inputFor(nativeFixture()));
    for(const mutate of [
      (record:Record<string,unknown>)=>{record.version=2;},
      (record:Record<string,unknown>)=>{record.extra=true;},
      (record:Record<string,unknown>)=>{record.operationId='other-operation';},
      (record:Record<string,unknown>)=>{record.batchId='0'.repeat(64);},
      (record:Record<string,unknown>)=>{(record.nativeDocumentIds as string[]).push((record.nativeDocumentIds as string[])[0]);},
      (record:Record<string,unknown>)=>{(record.nativeLineageIds as string[]).pop();},
      (record:Record<string,unknown>)=>{const ids=record.nativeLineageIds as string[];ids[1]=ids[0];},
      (record:Record<string,unknown>)=>{(record.anchors as unknown[]).push((record.anchors as unknown[])[0]);},
      (record:Record<string,unknown>)=>{(record.origin as Record<string,unknown>).schemaOid=-1;},
      (record:Record<string,unknown>)=>{(record.origin as Record<string,unknown>).impersonatedBy={};},
      (record:Record<string,unknown>)=>{record.expectedPlanId='a'.repeat(64);},
    ])rejected(()=>decodeWorkspaceImplicitMoveSelectionRequest(changedRequest(captured.request,mutate)));
    const input=inputFor(nativeFixture());
    rejected(()=>captureWorkspaceImplicitMoveSelection({...input,selections:[{sourcePath:'folder/note.md',destinationPath:'../escape.md'}]}));
    rejected(()=>captureWorkspaceImplicitMoveSelection({...input,selections:[{sourcePath:'folder/note.md',destinationPath:'x.md'},{sourcePath:'folder',destinationPath:'y'}]}));
  });
  check('getters/proxies/cycles and admission byte/node budgets are rejected without execution', () => {
    const input=inputFor(nativeFixture()); let invoked=0;
    const getter={...input};Object.defineProperty(getter,'operationId',{enumerable:true,get(){invoked++;throw new Error('getter executed');}});
    rejected(()=>captureWorkspaceImplicitMoveSelection(getter));assert.equal(invoked,0);
    const proxy=new Proxy(input,{get(){invoked++;throw new Error('proxy executed');}});
    rejected(()=>captureWorkspaceImplicitMoveSelection(proxy));assert.equal(invoked,0);
    const cycle={...input,selections:[] as unknown[]};cycle.selections.push(cycle);
    rejected(()=>captureWorkspaceImplicitMoveSelection(cycle as Input));
    rejected(()=>captureWorkspaceImplicitMoveSelection({...input,operationId:'x'.repeat(513)}));
    rejected(()=>captureWorkspaceImplicitMoveSelection({...input,selections:Array.from({length:1001},(_,index)=>({sourcePath:`s${index}`,destinationPath:`d${index}`}))}));
    rejected(()=>captureWorkspaceImplicitMoveSelection({...input,selections:[{sourcePath:'x'.repeat(4097),destinationPath:'d'}]}));
    const oversized=workspacePathImportPreparationFixture({native:[],raw:[],extra:
      Array.from({length:800},(_,index)=>({path:`folder/item-${index}.bin`,kind:'file' as const}))});
    assert.throws(()=>captureWorkspaceImplicitMoveSelection({...inputFor(oversized,'folder'),
      selections:[{sourcePath:'folder',destinationPath:'target/folder'}]}),
    error=>error instanceof WorkspaceImplicitMoveSelectionError&&error.code==='IMPLICIT_MOVE_SELECTION_TOO_LARGE');
    // Action payload remains small (selected short path + root IDs/lineages),
    // but 600 ordinary in-bounds incoming paths exceed the durable outer cap.
    // The writer must reject before an unreadable reservation can be stored.
    const prefix=Array.from({length:29},(_,index)=>`s${index}-${'x'.repeat(119)}`).join('/');
    const longIncoming=workspacePathImportPreparationFixture({raw:[],native:[['folder/note.md','# Selected\n'],
      ...Array.from({length:600},(_,index)=>[`${prefix}/incoming-${index}.md`,'# Incoming\n'] as const)]});
    assert.throws(()=>captureWorkspaceImplicitMoveSelection(inputFor(longIncoming)),
      error=>error instanceof WorkspaceImplicitMoveSelectionError&&error.code==='IMPLICIT_MOVE_SELECTION_TOO_LARGE');
  });
  assert.equal(passed,8);
  console.log('Implicit Move selection pure data contract: 8 families passed; no SQL, FS, principal, owner or lifecycle authority claim.');
}
