import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import * as decoding from 'lib0/decoding';
import { Y } from '../collaboration/server-runtime';
import { decodePreparedWorkspacePathMoveOriginal, preparedWorkspacePathMoveProof,
  type PreparedWorkspacePathMoveOriginal,
  type PreparedWorkspacePathMoveParentReceipt, type PreparedWorkspacePathMoveReceipt,
  type PreparedPathMoveIdentity, type PreparedPathMoveSource } from '../filesystem/prepared-workspace-path-move-contract';
import { captureNativeFileOperationBundle, type NativeFileOperationBundle } from '../markdown/native-file-operation-handoff';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { NativeLinkMutationRecipe, NativeLinkDocumentIdentity } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import type { WorkspaceOperationNativeSourceEvidence, WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import { decodeWorkspaceOperationNativeOriginalSourceWitness } from './workspace-operation-native-original-source';
import type { WorkspaceOperationOriginalMoveIntent, WorkspaceOperationOriginalMoveParentReceipt,
  WorkspaceOperationOriginalMovePathReceipt, WorkspaceOperationOriginalMoveReceipt } from './workspace-operation-original-move-repository';
import { decodeWorkspaceOperationOriginalMoveNamespaceStage,
  decodeWorkspaceOperationOriginalMoveNamespaceReceipt } from './workspace-operation-original-move-namespace-effects';

/** Strict original data only. No claim, current permission, DB/FS observation,
 * admission lease or proof of a caller's COMMIT is conferred by this codec. */
export type WorkspaceOperationOriginalMoveActor = Readonly<{ userId: string; actorId: string;
  actorType: 'user' | 'agent'; actorSessionId: string | null }>;
export type WorkspaceOperationOriginalMoveContext = Readonly<{ batchId: string; requestHash: string;
  actor: WorkspaceOperationOriginalMoveActor; plan: WorkspaceOperationNativeMoveBatchPlan }>;
export type WorkspaceOperationOriginalMoveNativeBundleData = Readonly<{ privateText: string;
  changesBundleProof: string; actionPayloadText: string }>;
export type WorkspaceOperationOriginalMoveNamespaceState = Readonly<{ stageText: string; stageDigest: string }>;
export type WorkspaceOperationOriginalMoveStep = Readonly<{ stepKey: string; selectionIndex: number;
  originalProof: string; physical: PreparedWorkspacePathMoveOriginal }>;
export type WorkspaceOperationOriginalMoveParentConsumer = Readonly<{ stepKey: string;
  sourceKind: PreparedPathMoveSource['kind'] }>;
export type WorkspaceOperationOriginalMoveParentPlan = Readonly<{ parentPath: string; producerStep: string;
  consumers: readonly WorkspaceOperationOriginalMoveParentConsumer[] }>;
export type WorkspaceOperationOriginalMoveNamespaceEffect = Readonly<{ sourcePath: string;
  destinationPath: string; kind: 'file' | 'directory'; identity: string; filesystemIdentity: string | null }>;
type WorkspaceOperationOriginalMoveIntentFields = Readonly<{ batchId: string; planId: string;
  requestHash: string; actor: WorkspaceOperationOriginalMoveActor; jobScope: WorkspaceOperationJobScope;
  compilerPlanProof: string; finalGraphProof: string; steps: readonly WorkspaceOperationOriginalMoveStep[];
  parents: readonly WorkspaceOperationOriginalMoveParentPlan[];
  namespaceEffects: readonly WorkspaceOperationOriginalMoveNamespaceEffect[];
  nativeBundle: WorkspaceOperationOriginalMoveNativeBundleData | null;
  namespaceState: WorkspaceOperationOriginalMoveNamespaceState | null }>;
export type WorkspaceOperationOriginalMoveIntentData = WorkspaceOperationOriginalMoveIntentFields & (
  Readonly<{ version: 1; currentWitness?: never }>
  | Readonly<{ version: 2; currentWitness: WorkspaceOperationNativeSourceEvidenceV2 }>
);
export type WorkspaceOperationOriginalMoveParentReceiptData = Readonly<{ version: 1; batchId: string;
  intentDigest: string; parentPath: string; producerStep: string;
  consumers: readonly WorkspaceOperationOriginalMoveParentConsumer[]; birth: PreparedWorkspacePathMoveParentReceipt }>;
export type WorkspaceOperationOriginalMoveParentReference = Readonly<{ parentPath: string; receiptDigest: string }>;
export type WorkspaceOperationOriginalMovePathReceiptData = Readonly<{ version: 1; batchId: string;
  intentDigest: string; stepKey: string; originalProof: string; physical: PreparedWorkspacePathMoveReceipt;
  parentReceipts: readonly WorkspaceOperationOriginalMoveParentReference[] }>;
export type WorkspaceOperationOriginalMoveNativeReceiptReference = Readonly<{ mutationId: string; receiptDigest: string }>;
export type WorkspaceOperationOriginalMoveCompletionData = Readonly<{ version: 1; batchId: string; intentDigest: string;
  planId: string; compilerPlanProof: string; finalGraphProof: string;
  parentReceipts: readonly WorkspaceOperationOriginalMoveParentReference[];
  pathReceipts: readonly Readonly<{ stepKey: string; receiptDigest: string }>[];
  native: Readonly<{ operationId: string; requestId: string; changesBundleProof: string;
    receipts: readonly WorkspaceOperationOriginalMoveNativeReceiptReference[]; sideEffectReceiptDigest: string | null }> | null;
  namespaceEffects: Readonly<{ effectsProof: string; receiptDigest: string; receiptText: string }> | null }>;
export const WORKSPACE_OPERATION_ORIGINAL_MOVE_LIMITS = Object.freeze({ steps: 1000, parents: 1000,
  entries: 10_000, hashBytes: 4 * 1024 ** 3, intentBytes: 16 * 1024 ** 2, pathReceiptBytes: 64 * 1024 ** 2,
  parentReceiptBytes: 1024 ** 2, totalParentReceiptBytes: 16 * 1024 ** 2, completionBytes: 1024 ** 2,
  nativeBundleBytes: 8 * 1024 ** 2, nativeMutations: 64, nativeEffects: 16 });
export class WorkspaceOperationOriginalMoveCodecError extends Error {
  readonly status = 409;
  constructor(readonly code: 'ORIGINAL_MOVE_INVALID' | 'ORIGINAL_MOVE_CHANGED' | 'ORIGINAL_MOVE_UNSUPPORTED' | 'ORIGINAL_MOVE_TOO_LARGE') {
    super(code); this.name = 'WorkspaceOperationOriginalMoveCodecError';
  }
}
const L = WORKSPACE_OPERATION_ORIGINAL_MOVE_LIMITS;
type Row = Record<string, unknown>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(code: WorkspaceOperationOriginalMoveCodecError['code'] = 'ORIGINAL_MOVE_INVALID'): never { throw new WorkspaceOperationOriginalMoveCodecError(code); }
function changed(): never { return fail('ORIGINAL_MOVE_CHANGED'); }
function exact(value: unknown, names: readonly string[]): Row {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail();
  for (const key of keys) {
    if (typeof key !== 'string' || !names.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  return value as Row;
}
function list<T>(value: readonly T[], maximum: number): readonly T[] {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>maximum||Reflect.ownKeys(value).length!==value.length+1)fail();
  const result:T[]=[];
  for(let index=0;index<value.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail();result.push(descriptor.value as T);
  }
  return result;
}
function quotedBytes(value: string, maximum: number): number {
  if (value.length > maximum) fail('ORIGINAL_MOVE_TOO_LARGE');
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) fail(); bytes += 4; }
    else if (code >= 0xdc00 && code <= 0xdfff) fail();
    else bytes += code === 34 || code === 92 ? 2 : code < 32 ? [8,9,10,12,13].includes(code) ? 2 : 6 : code < 128 ? 1 : code < 2048 ? 2 : 3;
    if (bytes > maximum) fail('ORIGINAL_MOVE_TOO_LARGE');
  }
  return bytes;
}
/** Capture/cost every JSON token before cloning, invoking no user code. */
function capture(value: unknown, maximum = L.intentBytes): unknown {
  let remaining = maximum, nodes = 600_000; const ancestors = new Set<object>();
  const charge = (bytes: number) => { remaining -= bytes; if (remaining < 0) fail('ORIGINAL_MOVE_TOO_LARGE'); };
  const visit = (item: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 64) fail('ORIGINAL_MOVE_TOO_LARGE');
    if (typeof item === 'string') { charge(quotedBytes(item, maximum)); return item; }
    if (item === null || typeof item === 'boolean') { charge(item === null || item === true ? 4 : 5); return item; }
    if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) fail(); charge(String(item).length); return item; }
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 100_000 || Reflect.ownKeys(item).length !== item.length + 1) fail();
      charge(2 + Math.max(item.length - 1, 0)); const result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(); result.push(visit(descriptor.value, depth + 1));
      }
      ancestors.delete(item); return result;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) fail();
    const keys = Reflect.ownKeys(item); if (keys.length > 4096) fail('ORIGINAL_MOVE_TOO_LARGE');
    charge(2 + Math.max(keys.length - 1, 0)); const result: Row = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__','constructor','prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      charge(quotedBytes(key, maximum) + 1); result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item); return result;
  };
  return visit(value, 0);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
function id(value: unknown, minimum = 1, maximum = 256): string {
  if (typeof value !== 'string' || Array.from(value).length < minimum || Array.from(value).length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(); quotedBytes(value, 4096); return value;
}
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(); return value; }
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER - 1): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < 0 || (value as number) > maximum) fail(); return value as number;
}
function rawText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || Buffer.byteLength(value) > maximum) fail();
  quotedBytes(value, maximum * 6 + 2); return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Row)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function serializeWorkspaceOperationOriginalMoveData(value: unknown): string { return canonical(capture(value, L.pathReceiptBytes)); }
function parse(text: unknown, maximum: number): unknown {
  const literal = rawText(text, maximum); let parsed: unknown;
  try { parsed = JSON.parse(literal); } catch { fail(); }
  const copied = capture(parsed, maximum); if (canonical(copied) !== literal) changed(); return copied;
}
function actor(value: unknown): WorkspaceOperationOriginalMoveActor {
  const row = exact(value, ['userId','actorId','actorType','actorSessionId']);
  id(row.userId); id(row.actorId); if (!['user','agent'].includes(row.actorType as string)) fail();
  if (row.actorSessionId !== null) id(row.actorSessionId); return row as WorkspaceOperationOriginalMoveActor;
}
function context(input: WorkspaceOperationOriginalMoveContext): WorkspaceOperationOriginalMoveContext {
  const supplied = exact(input, ['batchId','requestHash','actor','plan']);
  const batchId = id(supplied.batchId, 16, 128), requestHash = digest(supplied.requestHash);
  const selectedActor = actor(capture(supplied.actor, 4096)), plan = decodeWorkspaceOperationNativeMoveBatchPlan(supplied.plan);
  return freeze({ batchId, requestHash, actor: selectedActor, plan });
}
const within = (candidate: string, parent: string) => candidate === parent || candidate.startsWith(parent + '/');
const stepName = (index: number) => `path:${String(index).padStart(4, '0')}`;
const compareText = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function getWorkspaceOperationOriginalMoveNativeIds(input: WorkspaceOperationOriginalMoveContext, documentId?: string) {
  return nativeIds(context(input),documentId);
}
function nativeIds(selected: WorkspaceOperationOriginalMoveContext, documentId?: string) {
  const seed=sha(canonical([selected.batchId,selected.requestHash,selected.plan.planId]));
  return Object.freeze({operationId:`native-move:${seed}`,requestId:`${seed.slice(0,8)}-${seed.slice(8,12)}-4${seed.slice(13,16)}-8${seed.slice(17,20)}-${seed.slice(20,32)}`,
    ...(documentId===undefined?{}:{mutationId:`native-move-mutation:${sha(canonical([seed,id(documentId)]))}`})});
}
function scopeOf(plan: WorkspaceOperationNativeMoveBatchPlan): WorkspaceOperationJobScope { return plan.sourceEvidence.workspaceScope; }
function namespaceEffects(plan: WorkspaceOperationNativeMoveBatchPlan): WorkspaceOperationOriginalMoveNamespaceEffect[] {
  return plan.nativePathPlan.pathMappings.filter(mapping => mapping.source.documentId === null).map(mapping => ({
    sourcePath: mapping.source.path, destinationPath: mapping.destinationPath, kind: mapping.source.kind,
    identity: mapping.source.identity, filesystemIdentity: mapping.source.filesystemIdentity,
  })).sort((a,b) => compareText(a.sourcePath,b.sourcePath));
}
export function workspaceOperationOriginalMoveNamespaceEffects(input: WorkspaceOperationOriginalMoveContext): readonly WorkspaceOperationOriginalMoveNamespaceEffect[] {
  return freeze(namespaceEffects(context(input).plan));
}
function parentPlans(steps: readonly WorkspaceOperationOriginalMoveStep[]): WorkspaceOperationOriginalMoveParentPlan[] {
  const producers = new Map<string,string>();
  for (const step of steps) {
    if (step.physical.source.kind === 'projection_absent') continue;
    const components = step.physical.destinationPath.split('/').slice(0,-1);
    for (let index = step.physical.filesystem.destinationParents.directories.length; index < components.length; index++) {
      const name = components.slice(0,index+1).join('/'); if (!producers.has(name)) producers.set(name,step.stepKey);
    }
  }
  return [...producers].map(([parentPath,producerStep]) => ({ parentPath,producerStep,
    consumers: steps.filter(step => within(step.physical.destinationPath,parentPath)).map(step => ({ stepKey:step.stepKey,sourceKind:step.physical.source.kind })) }))
    .sort((a,b)=>compareText(a.parentPath,b.parentPath));
}
function sameIdentity(a: PreparedPathMoveIdentity,b: PreparedPathMoveIdentity,rootCtime = false): boolean {
  return Object.keys(a).every(key => rootCtime && key === 'ctimeNs' || a[key as keyof typeof a] === b[key as keyof typeof b]);
}
function safeProfile(value: PreparedPathMoveIdentity, kind: 'regular_file'|'directory', ownerUid: number): void {
  if ((value.mode & 0o170000) !== (kind === 'directory' ? 0o040000 : 0o100000) || value.mode & 0o022
    || value.uid !== ownerUid || kind === 'regular_file' && value.linkCount !== '1') fail();
}
function physicalNamespaceIdentity(value: PreparedPathMoveIdentity, original: {kind:'file'|'directory';filesystemIdentity:string|null}): void {
  if(original.filesystemIdentity===null)changed();
  const fields=original.filesystemIdentity.split(':');
  if(fields.length!==5||fields[0]!==value.device||fields[1]!==value.inode||original.kind==='file'&&fields[2]!==value.size)changed();
}
function identityShape(value: unknown): PreparedPathMoveIdentity {
  const row=exact(value,['device','inode','mode','uid','gid','linkCount','size','birthtimeNs','mtimeNs','ctimeNs']);
  for(const key of ['device','inode','linkCount','size'])if(typeof row[key]!=='string'||!/^(?:0|[1-9][0-9]{0,19})$/u.test(row[key] as string)
    ||BigInt(row[key] as string)>BigInt('18446744073709551615'))fail();
  if(row.inode==='0'||row.linkCount==='0')fail();
  for(const key of ['mode','uid','gid'])count(row[key],0xffff_ffff);
  for(const key of ['birthtimeNs','mtimeNs','ctimeNs'])if(typeof row[key]!=='string'||!/^-?(?:0|[1-9][0-9]{0,29})$/u.test(row[key] as string))fail();
  return row as PreparedPathMoveIdentity;
}
function checkSteps(steps: readonly WorkspaceOperationOriginalMoveStep[], plan: WorkspaceOperationNativeMoveBatchPlan,
  sourceEvidence: WorkspaceOperationNativeSourceEvidence = plan.sourceEvidence): void {
  const selections = plan.actions[0].selections, scope = scopeOf(plan);
  if (!steps.length || steps.length !== selections.length || steps.length > L.steps) fail();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]; exact(step,['stepKey','selectionIndex','originalProof','physical']);
    if (step.stepKey !== stepName(index) || step.selectionIndex !== index || step.originalProof !== preparedWorkspacePathMoveProof(step.physical)) changed();
    const source = step.physical, expected = selections[index];
    if (source.sourcePath !== expected.sourcePath || source.destinationPath !== expected.destinationPath
      || !equal(source.workspace,{workspaceId:scope.workspaceId,workspaceType:scope.workspaceType,organizationId:scope.organizationId,rootPath:scope.rootPath})) changed();
    if (!sameIdentity(source.filesystem.root.identity, steps[0].physical.filesystem.root.identity)
      || source.filesystem.root.resolvedPath !== steps[0].physical.filesystem.root.resolvedPath) changed();
    safeProfile(source.filesystem.root.identity,'directory',source.filesystem.root.identity.uid);
    for (const parent of [...source.filesystem.sourceParents.directories,...source.filesystem.destinationParents.directories]) safeProfile(parent.identity,'directory',source.filesystem.root.identity.uid);
    const originalEntry = sourceEvidence.stage.namespace.find(entry=>entry.path===source.sourcePath);
    if (!originalEntry || originalEntry.kind === 'directory' && source.source.kind === 'regular_file'
      || originalEntry.kind === 'file' && source.source.kind === 'directory') changed();
    if (source.source.kind === 'projection_absent') {
      if (originalEntry.filesystemIdentity !== null || originalEntry.kind === 'file' && originalEntry.documentId === null) changed();
      if(plan.nativePathPlan.pathMappings.some(mapping=>within(mapping.source.path,source.sourcePath)&&mapping.source.documentId===null
        &&mapping.source.filesystemIdentity!==null))changed();
      if(originalEntry.kind==='directory'&&!plan.nativePathPlan.pathMappings.some(mapping=>within(mapping.source.path,source.sourcePath)
        &&mapping.source.documentId!==null))changed();
    } else if (source.source.kind === 'regular_file') safeProfile(source.source.identity,'regular_file',source.filesystem.root.identity.uid);
    else for (const entry of source.source.entries) {
      safeProfile(entry.identity,entry.kind,source.filesystem.root.identity.uid);
      const literal = entry.relativePath ? source.sourcePath+'/'+entry.relativePath : source.sourcePath;
      const mapped = plan.nativePathPlan.pathMappings.find(mapping=>mapping.source.path===literal);
      if (!mapped || mapped.source.kind !== (entry.kind==='directory'?'directory':'file')) changed();
      if(mapped.source.documentId===null)physicalNamespaceIdentity(entry.identity,mapped.source);
    }
    if(source.source.kind==='regular_file'&&originalEntry.documentId===null)physicalNamespaceIdentity(source.source.identity,originalEntry);
    if(source.source.kind==='directory') {
      const physicalNames=new Set(source.source.entries.map(entry=>entry.relativePath?source.sourcePath+'/'+entry.relativePath:source.sourcePath));
      if(plan.nativePathPlan.pathMappings.some(mapping=>within(mapping.source.path,source.sourcePath)&&mapping.source.documentId===null
        &&mapping.source.filesystemIdentity!==null&&!physicalNames.has(mapping.source.path)))changed();
    }
    // No staging contract exists for a root whose target/source depends on a
    // different root. Reject all such cases before publishing any journal.
    for (let other = 0; other < steps.length; other++) if (other !== index) {
      const candidate = steps[other].physical;
      if (within(source.sourcePath,candidate.sourcePath) || within(candidate.sourcePath,source.sourcePath)
        || within(source.destinationPath,candidate.destinationPath) || within(candidate.destinationPath,source.destinationPath)
        || within(source.destinationPath,candidate.sourcePath) || within(candidate.sourcePath,source.destinationPath)) fail('ORIGINAL_MOVE_UNSUPPORTED');
    }
  }
}
function base64(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > 4*Math.ceil(maximum/3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail();
  const bytes = Buffer.from(value,'base64'); if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) fail(); return bytes;
}
function nativeIdentity(value: unknown): NativeLinkDocumentIdentity {
  const row=exact(value,['documentId','workspaceId','organizationId','path','lifecycleGeneration','representation','schemaVersion']);
  id(row.documentId);id(row.workspaceId);if(row.organizationId!==null)id(row.organizationId);
  id(row.path,1,4096);count(row.lifecycleGeneration);if(!(row.lifecycleGeneration as number)||row.schemaVersion!==1
    ||!['plain_text','tiptap_xml','tiptap_blocks'].includes(row.representation as string))fail();return row as NativeLinkDocumentIdentity;
}
function clock(value: unknown): void {
  const row=exact(value,['documentSequence','persistedAt','stateProof','stateVector','binaryHash']);
  count(row.documentSequence);count(row.persistedAt);digest(row.binaryHash);
  if(typeof row.stateProof!=='string'||!/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(row.stateProof))fail();base64(row.stateVector,4*1024**2);
}
function textReference(value: unknown): void {
  const row=exact(value,['blockId','startAnchor','endAnchor']);if(row.blockId!==null)id(row.blockId);base64(row.startAnchor,16_384);base64(row.endAnchor,16_384);
}
function inverseReference(value: unknown, recipe: NativeLinkMutationRecipe): void {
  if (!value || typeof value !== 'object') fail();
  const row=value as Row, original=recipe.reference;
  if(row.kind!==original.kind)changed();
  if(row.kind==='node-attribute') {
    exact(row,['kind','ownerBlockId','nodeId','attribute','expected','membershipAnchor']);
    if(original.kind!=='node-attribute'||!equal({...row,expected:original.expected},original)||row.expected!==recipe.nextValue)changed();
  } else if(row.kind==='link-mark') {
    exact(row,['kind','text','expected']);textReference(row.text);
    if(original.kind!=='link-mark'||!equal(row.expected,{...original.expected,href:recipe.nextValue}))changed();
  } else {
    exact(row,['kind','text','expected','syntaxText','syntaxStart','syntaxEnd','targetStart','targetEnd','raw']);textReference(row.text);
    if(original.kind!=='plain-target'||!equal({...row,text:original.text,expected:original.expected},original)
      ||row.expected!==recipe.nextValue)changed();
  }
}
function checkPrepared(value: unknown, mutation: Row, recipes: readonly NativeLinkMutationRecipe[]): Uint8Array | null {
  if (!recipes.length) {if(value!==null)changed();return null;}
  const prepared=exact(value,['contractVersion','operationId','source','before','after','update','inverseRecipes']);
  const before=exact(prepared.before,['stateProof','stateVector','documentSequence']), after=exact(prepared.after,['stateProof','stateVector']);
  if(prepared.contractVersion!==2||prepared.operationId!==mutation.mutationId||!equal(prepared.source,mutation.source)
    ||!equal(before,{stateProof:(mutation.before as Row).stateProof,stateVector:(mutation.before as Row).stateVector,documentSequence:(mutation.before as Row).documentSequence})
    ||typeof after.stateProof!=='string'||!/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(after.stateProof)||after.stateProof===before.stateProof)changed();
  base64(after.stateVector,4*1024**2);
  if(!Array.isArray(prepared.inverseRecipes)||prepared.inverseRecipes.length!==recipes.length)changed();
  const ids=new Set<string>();
  for(const inverse of prepared.inverseRecipes) {
    const item=exact(inverse,['contractVersion','originalLinkId','source','expectedScopeProof','command','authorizedForwardRecipeProof']);
    const recipe=recipes.find(candidate=>candidate.linkId===item.originalLinkId);
    if(!recipe||ids.has(recipe.linkId)||item.contractVersion!==2||!equal(item.source,mutation.source)
      ||item.authorizedForwardRecipeProof!==nativeLinkJsonProof(recipe))changed();
    ids.add(recipe.linkId);digest(item.expectedScopeProof);const command=exact(item.command,['kind','reference','nextValue']);
    if(command.kind!=='rewrite-target'||command.nextValue!==(recipe.reference.kind==='link-mark'?String(recipe.reference.expected.href):recipe.reference.expected))changed();
    inverseReference(command.reference,recipe);
  }
  const bytes=base64(prepared.update,16*1024**2),doc=new Y.Doc();
  try{const decoder=decoding.createDecoder(bytes);Y.readUpdate(decoder,doc);if(decoding.hasContent(decoder))fail();}catch{fail();}finally{doc.destroy();}
  return bytes;
}
function decodeNative(data: WorkspaceOperationOriginalMoveNativeBundleData | null, selected: WorkspaceOperationOriginalMoveContext,
  sourceEvidence: WorkspaceOperationNativeSourceEvidence = selected.plan.sourceEvidence): NativeFileOperationBundle | null {
  const plan=selected.plan, mappings=plan.nativePathPlan.pathMappings.filter(mapping=>mapping.source.documentId!==null), recipes=plan.nativePathPlan.mutations;
  const expectedIds=new Set([...mappings.map(mapping=>mapping.source.documentId!),...recipes.map(recipe=>recipe.source.documentId)]);
  if(!expectedIds.size){if(data!==null)changed();return null;} if(data===null)changed();
  exact(data,['privateText','changesBundleProof','actionPayloadText']);
  const literal=rawText(data.privateText,L.nativeBundleBytes);let parsed: unknown;try{parsed=JSON.parse(literal);}catch{fail();}
  const bundle=exact(capture(parsed,L.nativeBundleBytes),['version','operationId','requestId','action','actor','reviewDigest','mutations']);
  const identity=exact(bundle.actor,['actorUserId','actorId','actorType','actorSessionId']);
  if(bundle.version!==1||bundle.action!==plan.actions[0].kind||bundle.reviewDigest!==plan.planId
    ||!equal(identity,{actorUserId:selected.actor.userId,actorId:selected.actor.actorId,actorType:selected.actor.actorType,actorSessionId:selected.actor.actorSessionId}))changed();
  id(bundle.operationId);if(typeof bundle.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(bundle.requestId))fail();
  const originalIds=nativeIds(selected);
  if(bundle.operationId!==originalIds.operationId||bundle.requestId!==originalIds.requestId)changed();
  if(!Array.isArray(bundle.mutations)||bundle.mutations.length!==expectedIds.size||bundle.mutations.length>L.nativeMutations)fail('ORIGINAL_MOVE_TOO_LARGE');
  const seen=new Set<string>(), mutationIds=new Set<string>();let moved=0;
  for(const value of bundle.mutations) {
    const mutation=exact(value,['mutationId','kind','source','lineageId','registryStateVersion','before','destinationPath','trashEntryId','prepared']);
    const source=nativeIdentity(mutation.source), original=sourceEvidence.nativeBindings.find(binding=>binding.expected.documentId===source.documentId);
    id(mutation.mutationId); if(!original||!expectedIds.has(source.documentId)||seen.has(source.documentId)||mutationIds.has(mutation.mutationId as string))changed();
    if(mutation.mutationId!==nativeIds(selected,source.documentId).mutationId)changed();
    seen.add(source.documentId);mutationIds.add(mutation.mutationId as string);const expected=original.expected;
    if(!equal(source,{documentId:expected.documentId,workspaceId:expected.workspaceId,organizationId:expected.organizationId,path:expected.path,
      lifecycleGeneration:expected.lifecycleGeneration,representation:expected.representation,schemaVersion:expected.schemaVersion})
      ||mutation.lineageId!==expected.lineageId||mutation.registryStateVersion!==expected.registryStateVersion||mutation.trashEntryId!==null)changed();
    clock(mutation.before);
    if(!equal(mutation.before,{documentSequence:expected.documentSequence,persistedAt:expected.persistedAt,stateProof:expected.stateProof,
      stateVector:sourceEvidence.stage.sources.find(entry=>entry.inventory.document.documentId===source.documentId)!.inventory.version.stateVector,binaryHash:expected.binaryHash}))changed();
    const mapping=mappings.find(item=>item.source.documentId===source.documentId);
    if(mutation.kind!==(mapping?'move':'link')||mutation.destinationPath!==(mapping?.destinationPath??null))changed();if(mapping)moved++;
    const selectedRecipes=recipes.filter(recipe=>recipe.source.documentId===source.documentId);
    for(const recipe of selectedRecipes) if(!equal(recipe.source,source)||recipe.sourceVersion.stateProof!==expected.stateProof
      ||recipe.sourceVersion.documentSequence!==expected.documentSequence||recipe.sourceVersion.stateVector!==(mutation.before as Row).stateVector)changed();
    const update=checkPrepared(mutation.prepared,mutation,selectedRecipes);
    if(update)(mutation.prepared as Row).update=update;
  }
  if(moved>L.nativeEffects)fail('ORIGINAL_MOVE_TOO_LARGE');
  const captured=captureNativeFileOperationBundle(bundle as NativeFileOperationBundle);
  if(captured.privateText!==literal||data.changesBundleProof!==captured.changesBundleProof||data.actionPayloadText!==captured.actionPayloadText)changed();
  return captured.bundle;
}
// This association remembers which original V3 context has been decoded. It is
// data-validation provenance, never an execution or current-observation grant.
const contexts = new WeakMap<WorkspaceOperationOriginalMoveIntentData,WorkspaceOperationOriginalMoveContext>();
const intentHashes = new WeakMap<WorkspaceOperationOriginalMoveIntentData,string>();
function originalContext(intent: WorkspaceOperationOriginalMoveIntentData): WorkspaceOperationOriginalMoveContext {
  const selected=contexts.get(intent);if(!selected)fail();return selected;
}
function checkIntent(value: unknown, selected: WorkspaceOperationOriginalMoveContext): WorkspaceOperationOriginalMoveIntentData {
  const captured=capture(value) as Row;
  const row=exact(captured,['version','batchId','planId','requestHash','actor','jobScope','compilerPlanProof','finalGraphProof','steps','parents','namespaceEffects','nativeBundle','namespaceState',
    ...(captured?.version===2?['currentWitness']:[])]);
  const plan=selected.plan;
  if(row.version!==(plan.planIdentityVersion===2?2:1)||row.batchId!==selected.batchId||row.planId!==plan.planId||row.requestHash!==selected.requestHash
    ||!equal(row.actor,selected.actor)||!equal(row.jobScope,scopeOf(plan))||row.compilerPlanProof!==plan.compilerPlanProof||row.finalGraphProof!==plan.finalGraphProof)changed();
  if(!Array.isArray(row.steps))fail();
  for(const step of row.steps) {
    exact(step,['stepKey','selectionIndex','originalProof','physical']);step.physical=decodePreparedWorkspacePathMoveOriginal(step.physical);
  }
  let sourceEvidence=plan.sourceEvidence;
  if(plan.planIdentityVersion===2) {
    try { sourceEvidence=decodeWorkspaceOperationNativeOriginalSourceWitness(plan.sourceEvidence,row.currentWitness); }
    catch { changed(); }
    row.currentWitness=sourceEvidence;
  }
  const valueTyped=row as WorkspaceOperationOriginalMoveIntentData;
  checkSteps(valueTyped.steps,plan,sourceEvidence);
  if(!equal(valueTyped.parents,parentPlans(valueTyped.steps))||!equal(valueTyped.namespaceEffects,namespaceEffects(plan)))changed();
  if(valueTyped.parents.length>L.parents)fail('ORIGINAL_MOVE_TOO_LARGE');
  if(valueTyped.namespaceEffects.length) {
    const stage=exact(valueTyped.namespaceState,['stageText','stageDigest']);
    if(digest(stage.stageDigest)!==sha(rawText(stage.stageText,1024**2)))changed();
    const decoded=decodeWorkspaceOperationOriginalMoveNamespaceStage(stage.stageText as string,selected);
    if(decoded.effectsProof!==nativeLinkJsonProof(valueTyped.namespaceEffects))changed();
  } else if(valueTyped.namespaceState!==null)changed();
  decodeNative(valueTyped.nativeBundle,selected,sourceEvidence);
  contexts.set(valueTyped,selected);
  try{assertWorkspaceOperationOriginalMovePreflightBudget(valueTyped);}catch(error){contexts.delete(valueTyped);throw error;}
  return freeze(valueTyped);
}
export function captureWorkspaceOperationOriginalMoveIntent(input: unknown, supplied: WorkspaceOperationOriginalMoveContext): WorkspaceOperationOriginalMoveIntentData {
  return checkIntent(input,context(supplied));
}
/** Derive deterministic steps, shared consumers and non-native effects. The
 * caller still supplies originals and an actual previously prepared bundle. */
export function createWorkspaceOperationOriginalMoveIntent(input: Readonly<{ physical: readonly PreparedWorkspacePathMoveOriginal[];
  nativeBundle: WorkspaceOperationOriginalMoveNativeBundleData|null; namespaceState: WorkspaceOperationOriginalMoveNamespaceState|null;
  currentWitness?: WorkspaceOperationNativeSourceEvidenceV2 }>, supplied: WorkspaceOperationOriginalMoveContext): WorkspaceOperationOriginalMoveIntentData {
  const selected=context(supplied), semantic=selected.plan.planIdentityVersion===2;
  const row=exact(capture(input),['physical','nativeBundle','namespaceState',...(semantic?['currentWitness']:[])]);
  if(!Array.isArray(row.physical)||row.physical.length>L.steps)fail();
  const steps=row.physical.map((physical,index)=>{const original=decodePreparedWorkspacePathMoveOriginal(physical);
    return {stepKey:stepName(index),selectionIndex:index,originalProof:preparedWorkspacePathMoveProof(original),physical:original};});
  return checkIntent({version:semantic?2:1,batchId:selected.batchId,planId:selected.plan.planId,requestHash:selected.requestHash,actor:selected.actor,
    jobScope:scopeOf(selected.plan),compilerPlanProof:selected.plan.compilerPlanProof,finalGraphProof:selected.plan.finalGraphProof,steps,
    parents:parentPlans(steps),namespaceEffects:namespaceEffects(selected.plan),nativeBundle:row.nativeBundle,namespaceState:row.namespaceState,
    ...(semantic?{currentWitness:row.currentWitness}:{})},selected);
}
/** Data validation only, before an original physical intent exists. Neither a
 * decoded bundle nor its source evidence grants a Claim or mutation authority. */
export function decodeWorkspaceOperationOriginalMoveNativeBundleData(data: WorkspaceOperationOriginalMoveNativeBundleData | null,
  supplied: WorkspaceOperationOriginalMoveContext, sourceEvidence?: WorkspaceOperationNativeSourceEvidence): NativeFileOperationBundle|null {
  return decodeNative(data,context(supplied),sourceEvidence);
}
export function readWorkspaceOperationOriginalMoveNativeBundle(intent: WorkspaceOperationOriginalMoveIntentData): NativeFileOperationBundle|null {
  return decodeNative(intent.nativeBundle,originalContext(intent),intent.version===2?intent.currentWitness:undefined);
}
function intentHash(intent: WorkspaceOperationOriginalMoveIntentData): string {
  originalContext(intent);let result=intentHashes.get(intent);if(!result){result=sha(canonical(intent));intentHashes.set(intent,result);}return result;
}
function parentTemplate(intent: WorkspaceOperationOriginalMoveIntentData, planned: WorkspaceOperationOriginalMoveParentPlan): WorkspaceOperationOriginalMoveParentReceiptData {
  const step=intent.steps.find(item=>item.stepKey===planned.producerStep)!;
  const identity:PreparedPathMoveIdentity={device:'9'.repeat(20),inode:'9'.repeat(20),mode:0xffffffff,uid:0xffffffff,gid:0xffffffff,
    linkCount:'9'.repeat(20),size:'9'.repeat(20),birthtimeNs:'-'+'9'.repeat(30),mtimeNs:'-'+'9'.repeat(30),ctimeNs:'-'+'9'.repeat(30)};
  return {version:1,batchId:intent.batchId,intentDigest:intentHash(intent),parentPath:planned.parentPath,producerStep:planned.producerStep,
    consumers:planned.consumers,birth:{version:1,originalProof:step.originalProof,relativePath:planned.parentPath,identity}};
}
function referenceList(intent: WorkspaceOperationOriginalMoveIntentData, step?: WorkspaceOperationOriginalMoveStep): WorkspaceOperationOriginalMoveParentReference[] {
  if(step?.physical.source.kind==='projection_absent')return [];
  return intent.parents.filter(parent=>!step||parent.consumers.some(item=>item.stepKey===step.stepKey))
    .map(parent=>({parentPath:parent.parentPath,receiptDigest:'0'.repeat(64)}));
}
/** Conservative exact JSON-token accounting of the largest possible receipts,
 * before FS. Physical hash/entry limits are cumulative over distinct roots. */
export function assertWorkspaceOperationOriginalMovePreflightBudget(intent: WorkspaceOperationOriginalMoveIntentData): void {
  const selected=originalContext(intent);let entries=0,hashBytes=BigInt(0),parentBytes=0,pathBytes=0;
  if(Buffer.byteLength(canonical(intent))>L.intentBytes)fail('ORIGINAL_MOVE_TOO_LARGE');
  const parentTemplates=new Map<string,WorkspaceOperationOriginalMoveParentReceiptData>();
  for(const planned of intent.parents) {
    const value=parentTemplate(intent,planned);parentTemplates.set(planned.parentPath,value);
    const payload=Buffer.byteLength(canonical(value))+Buffer.byteLength(canonical(planned.consumers));
    if(payload>L.parentReceiptBytes)fail('ORIGINAL_MOVE_TOO_LARGE');
    parentBytes+=payload+8192; // also reserve repository identifiers/row envelope
    if(parentBytes>L.totalParentReceiptBytes)fail('ORIGINAL_MOVE_TOO_LARGE');
  }
  for(const step of intent.steps) {
    const source=step.physical.source;
    if(source.kind==='regular_file'){entries++;hashBytes+=BigInt(source.identity.size);}
    if(source.kind==='directory')for(const entry of source.entries){entries++;if(entry.kind==='regular_file')hashBytes+=BigInt(entry.identity.size);}
    if(entries>L.entries||hashBytes>BigInt(L.hashBytes))fail('ORIGINAL_MOVE_TOO_LARGE');
    let observed=structuredClone(source);
    if(observed.kind==='regular_file')observed={...observed,identity:{...observed.identity,ctimeNs:'-'+'9'.repeat(30)}};
    else if(observed.kind==='directory') {
      const root=observed.entries[0];(observed.entries as Array<typeof root>)[0]={...root,identity:{...root.identity,ctimeNs:'-'+'9'.repeat(30)}};
    }
    const predicted:WorkspaceOperationOriginalMovePathReceiptData={version:1,batchId:intent.batchId,intentDigest:intentHash(intent),stepKey:step.stepKey,
      originalProof:step.originalProof,physical:{version:1,original:step.physical,
        createdParents:source.kind==='projection_absent'?[]:intent.parents.filter(parent=>parent.producerStep===step.stepKey).map(parent=>parentTemplates.get(parent.parentPath)!.birth),
        observation:observed.kind==='projection_absent'?{kind:'projection_absent'}:{kind:'moved',method:'rename-no-replace',source:observed}},
      parentReceipts:referenceList(intent,step)};
    const bytes=Buffer.byteLength(canonical(predicted));if(bytes>L.pathReceiptBytes)fail('ORIGINAL_MOVE_TOO_LARGE');
    pathBytes+=bytes+8192;if(pathBytes>L.pathReceiptBytes)fail('ORIGINAL_MOVE_TOO_LARGE');
  }
  const bundle=decodeNative(intent.nativeBundle,selected,intent.version===2?intent.currentWitness:undefined);
  const predicted:WorkspaceOperationOriginalMoveCompletionData={version:1,batchId:intent.batchId,intentDigest:intentHash(intent),planId:intent.planId,
    compilerPlanProof:intent.compilerPlanProof,finalGraphProof:intent.finalGraphProof,parentReceipts:referenceList(intent),
    pathReceipts:intent.steps.map(step=>({stepKey:step.stepKey,receiptDigest:'0'.repeat(64)})),native:bundle?{operationId:bundle.operationId,requestId:bundle.requestId,
      changesBundleProof:intent.nativeBundle!.changesBundleProof,receipts:bundle.mutations.map(mutation=>({mutationId:mutation.mutationId,receiptDigest:'0'.repeat(64)})),
      sideEffectReceiptDigest:bundle.mutations.some(mutation=>mutation.kind==='move')?'0'.repeat(64):null}:null,
    namespaceEffects:intent.namespaceEffects.length?{effectsProof:nativeLinkJsonProof(intent.namespaceEffects),receiptDigest:'0'.repeat(64),receiptText:'\\'.repeat(16*1024)}:null};
  if(Buffer.byteLength(canonical(predicted))+8192>L.completionBytes)fail('ORIGINAL_MOVE_TOO_LARGE');
}
export function parseWorkspaceOperationOriginalMoveIntent(row: WorkspaceOperationOriginalMoveIntent,supplied: WorkspaceOperationOriginalMoveContext): WorkspaceOperationOriginalMoveIntentData {
  exact(row,['batchId','planId','workspaceId','requestHash','intentText','intentDigest','createdAt']);count(row.createdAt);
  const selected=context(supplied);
  if(row.batchId!==selected.batchId||row.planId!==selected.plan.planId||row.workspaceId!==selected.plan.workspaceId||row.requestHash!==selected.requestHash
    ||digest(row.intentDigest)!==sha(rawText(row.intentText,L.intentBytes)))changed();
  return checkIntent(parse(row.intentText,L.intentBytes),selected);
}
function receiptRow(row: WorkspaceOperationOriginalMoveReceipt,intent: WorkspaceOperationOriginalMoveIntentData,maximum: number,extra: readonly string[]=[]): unknown {
  exact(row,['batchId','intentDigest','receiptText','receiptDigest','createdAt',...extra]);count(row.createdAt);
  if(row.batchId!==intent.batchId||row.intentDigest!==intentHash(intent)||digest(row.receiptDigest)!==sha(rawText(row.receiptText,maximum)))changed();
  return parse(row.receiptText,maximum);
}
export function decodeWorkspaceOperationOriginalMoveParentReceipt(row: WorkspaceOperationOriginalMoveParentReceipt,intent: WorkspaceOperationOriginalMoveIntentData): WorkspaceOperationOriginalMoveParentReceiptData {
  const data=exact(receiptRow(row,intent,L.parentReceiptBytes,['parentKey','parentPath','producerStep','consumerBindingsText','consumerBindingsDigest']),
    ['version','batchId','intentDigest','parentPath','producerStep','consumers','birth']);
  const expected=intent.parents.find(parent=>parent.parentPath===row.parentPath);
  if(!expected||row.parentKey!==sha(row.parentPath)||row.producerStep!==expected.producerStep
    ||row.consumerBindingsText!==canonical(expected.consumers)||row.consumerBindingsDigest!==sha(row.consumerBindingsText)
    ||Buffer.byteLength(row.receiptText)+Buffer.byteLength(row.consumerBindingsText)>L.parentReceiptBytes)changed();
  if(data.version!==1||data.batchId!==intent.batchId||data.intentDigest!==row.intentDigest||data.parentPath!==row.parentPath
    ||data.producerStep!==expected.producerStep||!equal(data.consumers,expected.consumers))changed();
  const step=intent.steps.find(item=>item.stepKey===expected.producerStep)!;
  const birth=exact(data.birth,['version','originalProof','relativePath','identity']);
  const names=step.physical.destinationPath.split('/').slice(0,-1),offset=step.physical.filesystem.destinationParents.directories.length;
  const index=names.findIndex((_,position)=>names.slice(0,position+1).join('/')===row.parentPath);
  if(index<offset||birth.originalProof!==step.originalProof||birth.relativePath!==row.parentPath||birth.version!==1)changed();
  const observed=identityShape(birth.identity),existing=[step.physical.filesystem.root,...step.physical.filesystem.destinationParents.directories];
  safeProfile(observed,'directory',step.physical.filesystem.root.identity.uid);
  if(observed.device!==existing[existing.length-1].identity.device
    ||existing.some(parent=>parent.identity.device===observed.device&&parent.identity.inode===observed.inode))changed();
  return freeze(data as WorkspaceOperationOriginalMoveParentReceiptData);
}
function parentSet(rows: readonly WorkspaceOperationOriginalMoveParentReceipt[],intent: WorkspaceOperationOriginalMoveIntentData): Map<string,{row:WorkspaceOperationOriginalMoveParentReceipt;data:WorkspaceOperationOriginalMoveParentReceiptData}> {
  rows=list(rows,L.parents);let bytes=0;
  for(const row of rows){exact(row,['batchId','intentDigest','receiptText','receiptDigest','createdAt','parentKey','parentPath','producerStep','consumerBindingsText','consumerBindingsDigest']);
    bytes+=Buffer.byteLength(rawText(row.receiptText,L.parentReceiptBytes))+Buffer.byteLength(rawText(row.consumerBindingsText,L.parentReceiptBytes))+8192;
    if(bytes>L.totalParentReceiptBytes)fail('ORIGINAL_MOVE_TOO_LARGE');}
  const result=new Map<string,{row:WorkspaceOperationOriginalMoveParentReceipt;data:WorkspaceOperationOriginalMoveParentReceiptData}>(),identities=new Set<string>();
  for(const row of rows){if(result.has(row.parentPath))changed();const data=decodeWorkspaceOperationOriginalMoveParentReceipt(row,intent),node=`${data.birth.identity.device}:${data.birth.identity.inode}`;
    if(identities.has(node))changed();identities.add(node);result.set(row.parentPath,{row,data});}return result;
}
function sameSource(actual: PreparedPathMoveSource,expected: PreparedPathMoveSource): boolean {
  if(actual.kind!==expected.kind)return false;
  if(actual.kind==='projection_absent')return true;
  if(actual.kind==='regular_file'&&expected.kind==='regular_file')return actual.sha256===expected.sha256&&sameIdentity(actual.identity,expected.identity,true);
  if(actual.kind==='directory'&&expected.kind==='directory')return actual.entries.length===expected.entries.length&&actual.entries.every((entry,index)=>{
    const original=expected.entries[index];return entry.kind===original.kind&&entry.relativePath===original.relativePath&&sameIdentity(entry.identity,original.identity,index===0)
      &&(entry.kind!=='regular_file'||original.kind==='regular_file'&&entry.sha256===original.sha256);});return false;
}
export function decodeWorkspaceOperationOriginalMovePathReceipt(row: WorkspaceOperationOriginalMovePathReceipt,intent: WorkspaceOperationOriginalMoveIntentData,
  parentRows: readonly WorkspaceOperationOriginalMoveParentReceipt[]): WorkspaceOperationOriginalMovePathReceiptData {
  return decodePathReceipt(row,intent,parentSet(parentRows,intent));
}
function decodePathReceipt(row:WorkspaceOperationOriginalMovePathReceipt,intent:WorkspaceOperationOriginalMoveIntentData,
  parents:ReturnType<typeof parentSet>):WorkspaceOperationOriginalMovePathReceiptData {
  const data=exact(receiptRow(row,intent,L.pathReceiptBytes,['stepKey']),['version','batchId','intentDigest','stepKey','originalProof','physical','parentReceipts']);
  const step=intent.steps.find(item=>item.stepKey===row.stepKey);
  if(!step||data.version!==1||data.batchId!==intent.batchId||data.intentDigest!==row.intentDigest||data.stepKey!==step.stepKey||data.originalProof!==step.originalProof)changed();
  const physical=exact(data.physical,['version','original','createdParents','observation']);
  if(physical.version!==1||!equal(physical.original,step.physical))changed();
  const own=intent.parents.filter(parent=>parent.producerStep===step.stepKey).map(parent=>parents.get(parent.parentPath));
  if(own.some(parent=>!parent))changed();
  const observation=physical.observation as Row;
  if(step.physical.source.kind==='projection_absent') {
    exact(observation,['kind']);if(observation.kind!=='projection_absent'||!equal(physical.createdParents,[]))changed();
  } else {
    exact(observation,['kind','method','source']);if(observation.kind!=='moved'||observation.method!=='rename-no-replace')changed();
    const candidate=decodePreparedWorkspacePathMoveOriginal({...step.physical,source:observation.source});
    if(!sameSource(candidate.source,step.physical.source)||!equal(physical.createdParents,own.map(parent=>parent!.data.birth)))changed();
  }
  const refs=intent.parents.filter(parent=>step.physical.source.kind!=='projection_absent'&&parent.consumers.some(consumer=>consumer.stepKey===step.stepKey)).map(parent=>{
    const actual=parents.get(parent.parentPath);if(!actual)changed();return {parentPath:parent.parentPath,receiptDigest:actual.row.receiptDigest};});
  if(!equal(data.parentReceipts,refs))changed();return freeze(data as WorkspaceOperationOriginalMovePathReceiptData);
}
export function decodeWorkspaceOperationOriginalMoveCompletion(row: WorkspaceOperationOriginalMoveReceipt,intent: WorkspaceOperationOriginalMoveIntentData,
  parentRows: readonly WorkspaceOperationOriginalMoveParentReceipt[],pathRows: readonly WorkspaceOperationOriginalMovePathReceipt[]): WorkspaceOperationOriginalMoveCompletionData {
  const parents=parentSet(parentRows,intent);pathRows=list(pathRows,L.steps);if(parents.size!==intent.parents.length||pathRows.length!==intent.steps.length)changed();
  let bytes=0;for(const path of pathRows){exact(path,['batchId','intentDigest','receiptText','receiptDigest','createdAt','stepKey']);
    bytes+=Buffer.byteLength(rawText(path.receiptText,L.pathReceiptBytes))+8192;if(bytes>L.pathReceiptBytes)fail('ORIGINAL_MOVE_TOO_LARGE');}
  const paths=new Map<string,WorkspaceOperationOriginalMovePathReceipt>();
  for(const path of pathRows){if(paths.has(path.stepKey))changed();decodePathReceipt(path,intent,parents);paths.set(path.stepKey,path);}
  const data=exact(receiptRow(row,intent,L.completionBytes),['version','batchId','intentDigest','planId','compilerPlanProof','finalGraphProof','parentReceipts','pathReceipts','native','namespaceEffects']);
  if(data.version!==1||data.batchId!==intent.batchId||data.intentDigest!==row.intentDigest||data.planId!==intent.planId
    ||data.compilerPlanProof!==intent.compilerPlanProof||data.finalGraphProof!==intent.finalGraphProof
    ||!equal(data.parentReceipts,intent.parents.map(parent=>({parentPath:parent.parentPath,receiptDigest:parents.get(parent.parentPath)!.row.receiptDigest})))
    ||!equal(data.pathReceipts,intent.steps.map(step=>({stepKey:step.stepKey,receiptDigest:paths.get(step.stepKey)?.receiptDigest}))))changed();
  const bundle=readWorkspaceOperationOriginalMoveNativeBundle(intent);
  if(!bundle){if(data.native!==null)changed();}else{
    const native=exact(data.native,['operationId','requestId','changesBundleProof','receipts','sideEffectReceiptDigest']);
    if(native.operationId!==bundle.operationId||native.requestId!==bundle.requestId||native.changesBundleProof!==intent.nativeBundle!.changesBundleProof
      ||!Array.isArray(native.receipts)||native.receipts.length!==bundle.mutations.length)changed();
    for(let index=0;index<bundle.mutations.length;index++){const receipt=exact(native.receipts[index],['mutationId','receiptDigest']);
      if(receipt.mutationId!==bundle.mutations[index].mutationId)changed();digest(receipt.receiptDigest);}
    if(bundle.mutations.some(mutation=>mutation.kind==='move'))digest(native.sideEffectReceiptDigest);else if(native.sideEffectReceiptDigest!==null)changed();
  }
  if(intent.namespaceEffects.length){const effect=exact(data.namespaceEffects,['effectsProof','receiptDigest','receiptText']);
    if(effect.effectsProof!==nativeLinkJsonProof(intent.namespaceEffects)||digest(effect.receiptDigest)!==sha(rawText(effect.receiptText,16*1024)))changed();
    decodeWorkspaceOperationOriginalMoveNamespaceReceipt(effect.receiptText as string,originalContext(intent),intent.namespaceState!);
  }else if(data.namespaceEffects!==null)changed();
  return freeze(data as WorkspaceOperationOriginalMoveCompletionData);
}
