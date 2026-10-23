import 'server-only';

import { isDeepStrictEqual as equal } from 'node:util';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { isCollaborationStateProof } from './state-proof';
import type { MarkdownFileImportReceipt } from './markdown-file-import-persistence';
import type { PhysicalNativeImportBindingV1 } from '../markdown/physical-native-import-binding';
import type { NativeLinkReference } from '../markdown/workspace-link-contract-v2';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from '../files/workspace-operation-copy-origin';

export const NATIVE_COPY_MARKDOWN_BIRTH_LIMIT = 16 * 1024 * 1024;
export type NativeCopyMarkdownBirthV1 = Readonly<{
  version: 1;
  parent: Readonly<{ operationId: string; planId: string; stageDigest: string; requestHash: string;
    requirementIndex: number; entityKey: string; requirementProof: string }>;
  origin: WorkspaceOperationCopyOrigin;
  binding: PhysicalNativeImportBindingV1;
  b1TransactionId: string;
  birthProof: string;
}>;
export class NativeCopyMarkdownBirthError extends Error {
  readonly code = 'NATIVE_COPY_MARKDOWN_BIRTH_CHANGED';
  readonly status = 409;
  constructor() { super('The original raw Markdown Copy birth is unavailable.'); this.name = 'NativeCopyMarkdownBirthError'; }
}
export function rejectNativeCopyMarkdownBirth(): never { throw new NativeCopyMarkdownBirthError(); }
const fail: () => never = rejectNativeCopyMarkdownBirth;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER - 1): v is number => typeof v === 'number'
  && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0 && v <= max;
const text = (v: unknown, max = 65536): v is string => typeof v === 'string' && v.length <= max
  && Buffer.from(v).toString('utf8') === v;
const id = (v: unknown): v is string => text(v, 256) && !!v && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v);
const nullableId = (v: unknown) => v === null || id(v);
const path = (v: unknown): v is string => text(v, 4096) && isCanonicalAdmissionPath(v);
function freeze<T>(value:T):T { if (value && typeof value==='object') {
  for (const child of Object.values(value)) freeze(child); Object.freeze(value);
} return value; }
function object(v: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype
    || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !keys.includes(k))
    || keys.some(k => !optional.includes(k) && !Object.hasOwn(v, k))) fail();
  return v as Record<string, unknown>;
}
function list(v: unknown, max = 20000): unknown[] { if (!Array.isArray(v) || v.length > max) fail(); return v; }
function anchor(v: unknown): boolean { return text(v, 65536) && v.length > 0
  && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(v)
  && Buffer.from(v, 'base64').toString('base64') === v; }
function textRef(v: unknown): void {
  const r = object(v, ['blockId','startAnchor','endAnchor']);
  if (!nullableId(r.blockId) || !anchor(r.startAnchor) || !anchor(r.endAnchor)) fail();
}
function reference(v: unknown): void {
  const kind = object(v, ['kind','text','expected','syntaxText','syntaxStart','syntaxEnd','targetStart','targetEnd','raw',
    'ownerBlockId','nodeId','attribute','membershipAnchor'], ['text','expected','syntaxText','syntaxStart','syntaxEnd','targetStart','targetEnd','raw',
    'ownerBlockId','nodeId','attribute','membershipAnchor']).kind;
  if (kind === 'node-attribute') {
    const r = object(v, ['kind','ownerBlockId','nodeId','attribute','expected','membershipAnchor']);
    if (!nullableId(r.ownerBlockId) || !id(r.nodeId) || !['target','src'].includes(String(r.attribute))
      || !text(r.expected) || r.membershipAnchor !== null && !anchor(r.membershipAnchor)) fail();
  } else if (kind === 'link-mark') {
    const r = object(v, ['kind','text','expected']); textRef(r.text);
    const attrs = r.expected;
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || Object.keys(attrs).length > 64
      || !text(Reflect.get(attrs, 'href')) || Object.entries(attrs).some(([k,x]) => !/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u.test(k)
        || !(x === null || typeof x === 'boolean' || text(x) || typeof x === 'number' && Number.isFinite(x)))) fail();
  } else if (kind === 'plain-target') {
    const r = object(v, ['kind','text','expected','syntaxText','syntaxStart','syntaxEnd','targetStart','targetEnd','raw']);
    textRef(r.text); textRef(r.syntaxText);
    if (!text(r.expected) || !text(r.raw) || !['syntaxStart','syntaxEnd','targetStart','targetEnd'].every(k => integer(r[k]))
      || Number(r.syntaxStart) > Number(r.targetStart) || Number(r.targetStart) >= Number(r.targetEnd)
      || Number(r.targetEnd) > Number(r.syntaxEnd)) fail();
  } else fail();
}
function receipt(v: unknown): MarkdownFileImportReceipt {
  const r = object(v, ['version','operationId','requestFingerprint','sourceHash','sourceBytes','target','checkpointRequired']);
  const t = object(r.target, ['documentId','workspaceId','organizationId','path','representation','schemaVersion','lifecycleGeneration',
    'newlineStyle','hasBom','lineageId','initialSequence','initialStateProof','persistedAt']);
  if (r.version !== 1 || !id(r.operationId) || !hash(r.requestFingerprint) || !hash(r.sourceHash)
    || !integer(r.sourceBytes, 8388608) || r.checkpointRequired !== true
    || !id(t.documentId) || !id(t.workspaceId) || !nullableId(t.organizationId) || !path(t.path)
    || !/\.(?:md|markdown)$/iu.test(t.path) || !['plain_text','tiptap_xml','tiptap_blocks'].includes(String(t.representation))
    || t.schemaVersion !== 1 || t.lifecycleGeneration !== 1 || !['lf','crlf'].includes(String(t.newlineStyle))
    || typeof t.hasBom !== 'boolean' || !id(t.lineageId) || t.initialSequence !== 0
    || !isCollaborationStateProof(t.initialStateProof) || !integer(t.persistedAt)) fail();
  return r as unknown as MarkdownFileImportReceipt;
}
/** Strict historical data decoder. It never reads/rebinds a later native state. */
export function decodeNativeCopyMarkdownBirthV1(input: unknown): NativeCopyMarkdownBirthV1 {
  const r = object(captureWorkspaceOperationNativePlanData(input, fail, NATIVE_COPY_MARKDOWN_BIRTH_LIMIT),
    ['version','parent','origin','binding','b1TransactionId','birthProof']);
  const p = object(r.parent, ['operationId','planId','stageDigest','requestHash','requirementIndex','entityKey','requirementProof']);
  if (r.version !== 1 || !id(p.operationId) || ![p.planId,p.stageDigest,p.requestHash,p.requirementProof].every(hash)
    || !integer(p.requirementIndex, 9999) || !text(p.entityKey, 4096) || !p.entityKey
    || !text(r.b1TransactionId, 32) || !/^[1-9][0-9]{0,31}$/u.test(r.b1TransactionId) || !hash(r.birthProof)) fail();
  const origin = decodeWorkspaceOperationCopyOrigin(r.origin);
  const b = object(r.binding, ['version','source','receipt','nativeInventory','nativeBinaryHash','nativeVectorHash','links','bindingProof']);
  const source = object(b.source, ['workspaceId','organizationId','path','physicalSourceProof','filesystemIdentity','sourceHash','sourceBytes']);
  const imported = receipt(b.receipt), target = imported.target;
  if (b.version !== 1 || source.workspaceId !== origin.sourceScope.workspaceId || source.organizationId !== origin.sourceScope.organizationId
    || !path(source.path) || !/\.(?:md|markdown)$/iu.test(source.path) || !hash(source.physicalSourceProof)
    || !text(source.filesystemIdentity, 1024) || !/^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+(?:\.[0-9]+)?:-?[0-9]+(?:\.[0-9]+)?$/u.test(source.filesystemIdentity)
    || source.sourceHash !== imported.sourceHash || source.sourceBytes !== imported.sourceBytes
    || target.workspaceId !== origin.destinationScope.workspaceId || target.organizationId !== origin.destinationScope.organizationId
    || ![b.nativeBinaryHash,b.nativeVectorHash,b.bindingProof].every(hash)) fail();
  const inv = object(b.nativeInventory, ['contractVersion','document','version','parserVersion','metadata','links','coverage']);
  const document = object(inv.document, ['documentId','workspaceId','organizationId','path','lifecycleGeneration','representation','schemaVersion']);
  const version = object(inv.version, ['stateVector','stateProof','documentSequence','persistedAt']);
  const coverage = object(inv.coverage, ['complete','gaps']);
  if (inv.contractVersion !== 2 || inv.parserVersion !== 3 || coverage.complete !== true || list(coverage.gaps).length
    || !Object.keys(document).every(k => document[k] === Reflect.get(target,k)) || !anchor(version.stateVector)
    || version.stateProof !== target.initialStateProof || version.documentSequence !== 0 || version.persistedAt !== target.persistedAt) fail();
  const meta = object(inv.metadata, ['path','aliases','blockIds','headings','hasExplicitTitle','tags','title'], ['hasExplicitTitle']);
  if (meta.path !== target.path || !text(meta.title) || meta.hasExplicitTitle !== undefined && typeof meta.hasExplicitTitle !== 'boolean') fail();
  for (const k of ['aliases','blockIds','tags']) if (list(meta[k]).some(x => !text(x))) fail();
  for (const x of list(meta.headings)) { const h=object(x,['depth','text']); if (!integer(h.depth,6) || h.depth===0 || !text(h.text)) fail(); }
  const native = new Map<string, Record<string, unknown>>();
  for (const x of list(inv.links)) {
    const link = object(x, ['id','kind','syntax','literal','targetPathText','fragment','alias','embed','classification','ref','cloneLocator']);
    const loc = object(link.cloneLocator, ['ownerBlockId','nodeId','ordinal']);
    if (!id(link.id) || native.has(link.id) || !['wiki','markdown'].includes(String(link.kind))
      || !['inline-link','inline-image','reference-link','reference-image','reference-definition','wiki-link','wiki-embed'].includes(String(link.syntax))
      || !text(link.literal) || !text(link.targetPathText) || link.fragment !== null && !text(link.fragment)
      || link.alias !== null && !text(link.alias) || typeof link.embed !== 'boolean'
      || !['local','external','anchor-only'].includes(String(link.classification)) || !nullableId(loc.ownerBlockId)
      || !nullableId(loc.nodeId) || !integer(loc.ordinal,20000)) fail();
    reference(link.ref); native.set(link.id,link);
  }
  const physical = new Set<string>(), pairedNative = new Set<string>();
  for (const x of list(b.links)) {
    const link=object(x,['physicalLinkId','nativeLinkId','reference','occurrenceProof']);
    if (!id(link.physicalLinkId) || !id(link.nativeLinkId) || physical.has(link.physicalLinkId) || pairedNative.has(link.nativeLinkId)
      || !hash(link.occurrenceProof) || !native.has(link.nativeLinkId) || !equal(native.get(link.nativeLinkId)!.ref,link.reference)) fail();
    reference(link.reference); physical.add(link.physicalLinkId); pairedNative.add(link.nativeLinkId);
  }
  const locals=[...native.values()].filter(link=>link.classification==='local' || link.classification==='anchor-only' && link.kind==='wiki');
  if (locals.length!==pairedNative.size || locals.some(link=>!pairedNative.has(String(link.id)))) fail();
  const { bindingProof: _bindingProof, ...bindingBody }=b;
  const { birthProof: _birthProof, ...body }=r;
  if (proof(bindingBody)!==b.bindingProof || proof(body)!==r.birthProof) fail();
  return freeze(r) as unknown as NativeCopyMarkdownBirthV1;
}
export function nativeCopyMarkdownImportIds(parentOperationId: string, stageDigest: string, requirementIndex: number) {
  if (!id(parentOperationId) || !hash(stageDigest) || !integer(requirementIndex,9999)) fail();
  const digest=proof({version:1,kind:'raw-copy-markdown-import',parentOperationId,stageDigest,requirementIndex});
  return Object.freeze({ operationId:`copy-import:${digest}`, requestId:`copy-import-request:${digest}` });
}
export function nativeCopyMarkdownBirthText(value: NativeCopyMarkdownBirthV1): string {
  const captured=decodeNativeCopyMarkdownBirthV1(value);
  const text=JSON.stringify(captured,(_key,entry:unknown)=>!entry || typeof entry!=='object' || Array.isArray(entry)
    ? entry : Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a<b?-1:a>b?1:0)));
  if (Buffer.byteLength(text)>NATIVE_COPY_MARKDOWN_BIRTH_LIMIT) fail();
  return text;
}
export type NativeCopyMarkdownBirthReference = NativeLinkReference;
