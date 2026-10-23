import 'server-only';

import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { prepareMarkdownFileImport } from '../collaboration/markdown-file-import';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { parseObsidianWikiTarget } from '../markdown/obsidian-flavored-markdown';
import { getCanvasNotebookExactLinkTarget } from '../markdown/obsidian-link-resolver';
import { buildWorkspaceMixedHtmlLinkGraphV5 } from '../markdown/workspace-native-link-graph';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { createWorkspaceMixedHtmlFileOperationPlanV5 } from '../markdown/workspace-native-file-operation-planner';
import type { MixedReadResolvedLinkV3 } from '../markdown/workspace-link-contract-v3';
import type { FilePlanV5 } from '../markdown/workspace-link-contract-v5';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { workspaceOperationMixedSourceSnapshotV5 } from './workspace-operation-mixed-source-evidence-v5';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationMixedSourceEvidenceV5, decodeWorkspaceOperationMixedSourceEvidenceV5,
  type WorkspaceOperationMixedSourceEvidenceV5, type WorkspaceOperationMixedSourceSnapshotV5,
  type PhysicalMarkdownSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { captureRawHtmlSourceBindingV1, decodeRawHtmlSourceBindingV1,
  type RawHtmlSourceBindingV1 } from '../markdown/workspace-raw-html-source-binding';
import { WorkspacePathImportPreparationPlanError, type WorkspacePathImportPreparationV1,
  type WorkspacePathImportRequirementV1, type WorkspacePathPhysicalLinkIntentV1 } from './workspace-path-import-preparation-plan';

type Kind = 'move' | 'rename' | 'delete';
type Selection = Readonly<{ sourcePath: string; destinationPath?: string }>;
type Issue = FilePlanV5['issues'][number];
export type WorkspacePathHtmlImportPreparationPlanV4 = Readonly<{
  version: 4; kind: 'native-path-import-preparation'; executionReady: false;
  readiness: 'requires-import-rebinding' | 'native-ready' | 'blocked';
  scope: WorkspaceOperationJobScope; request: Readonly<{ kind: Kind; selections: readonly Selection[] }>;
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5; pathMappings: FilePlanV5['pathMappings'];
  importRequirements: readonly WorkspacePathImportRequirementV1[];
  sourceBindings: readonly RawHtmlSourceBindingV1[];
  physicalLinkIntents: readonly WorkspacePathPhysicalLinkIntentV1[];
  issues: readonly Issue[]; coverage: WorkspaceOperationMixedSourceEvidenceV5['coverage'];
  linkAssessment: FilePlanV5['htmlAssessment'];
  graphProofs: Readonly<{ version: 4; before: string; after: string }>;
  planId: string; integrityProof: string;
}>;
type MutableSnapshot = Omit<WorkspaceOperationMixedSourceSnapshotV5, 'namespace' | 'documents' | 'physicalSources'> & {
  namespace: Array<WorkspaceOperationMixedSourceSnapshotV5['namespace'][number]>;
  documents: Array<WorkspaceOperationMixedSourceSnapshotV5['documents'][number]>;
  physicalSources: Array<Omit<PhysicalMarkdownSourceEvidenceV5, 'links'> & { links: PhysicalMarkdownSourceEvidenceV5['links'] }>;
};
const fail = (code: WorkspacePathImportPreparationPlanError['code'] = 'PATH_IMPORT_PREPARATION_INVALID'): never => {
  throw new WorkspacePathImportPreparationPlanError(code);
};
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'PATH_IMPORT_PREPARATION_TOO_LARGE' : 'PATH_IMPORT_PREPARATION_INVALID'), 16 * 1024 * 1024);
}
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail(); return descriptor.value;
}
function exact(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Reflect.ownKeys(input).length !== keys.length) return fail();
  for (const key of keys) field(input, key);
}
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') { for (const child of Object.values(input)) freeze(child); Object.freeze(input); } return input;
}
function request(input: unknown): WorkspacePathHtmlImportPreparationPlanV4['request'] {
  const value = capture(input); exact(value, ['kind', 'selections']);
  const kind = field(value, 'kind'); if (typeof kind !== 'string' || !['move', 'rename', 'delete'].includes(kind)) return fail();
  const selections = field(value, 'selections');
  if (!Array.isArray(selections) || !selections.length || selections.length > 1000) return fail();
  for (const selection of selections) {
    exact(selection, kind === 'delete' ? ['sourcePath'] : ['sourcePath', 'destinationPath']);
    for (const key of kind === 'delete' ? ['sourcePath'] : ['sourcePath', 'destinationPath']) {
      const value = field(selection, key);
      if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value
        || !isCanonicalAdmissionPath(value) || Buffer.byteLength(value) > 4096 || value.split('/').length > 33) return fail();
    }
  }
  return value as WorkspacePathHtmlImportPreparationPlanV4['request'];
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function preparation(input: unknown, original: PhysicalMarkdownSourceEvidenceV5): WorkspacePathImportPreparationV1 {
  exact(input, ['version', 'representation', 'newlineStyle', 'hasBom', 'sourceHash', 'sourceBytes', 'canonicalHash']);
  const value = input as WorkspacePathImportPreparationV1;
  if (value.version !== 1 || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(value.representation)
    || !['lf', 'crlf'].includes(value.newlineStyle) || typeof value.hasBom !== 'boolean' || value.hasBom !== original.hasBom
    || value.sourceHash !== original.physical.byteHash || value.sourceBytes !== original.physical.byteLength || !digest(value.canonicalHash)
    || ['mixed', 'bare-cr'].includes(original.lineEndings.style)
    || value.newlineStyle !== (original.lineEndings.style === 'crlf' ? 'crlf' : 'lf')) return fail();
  return value;
}
function resolution(edge: MixedReadResolvedLinkV3): unknown {
  return { status: edge.resolution.status, target: edge.resolution.target?.identity ?? null,
    candidates: edge.resolution.candidates.map(candidate => candidate.identity).sort() };
}
/** Complete original identities remain in the hypothetical namespace. Physical
 * link values here are semantic rehearsal facts, never rewritten source spans,
 * native references, import confirmations or persistence authority. */
function build(scope: WorkspaceOperationJobScope, selected: WorkspacePathHtmlImportPreparationPlanV4['request'],
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5,
  profile: (source: PhysicalMarkdownSourceEvidenceV5) => { preparation: WorkspacePathImportPreparationV1; binding: RawHtmlSourceBindingV1 }): WorkspacePathHtmlImportPreparationPlanV4 {
  if (!equal(scope, sourceEvidence.workspaceScope)) return fail();
  const snapshot = workspaceOperationMixedSourceSnapshotV5(sourceEvidence), before = buildWorkspaceMixedHtmlLinkGraphV5(snapshot);
  const legacy = createWorkspaceMixedHtmlFileOperationPlanV5({ kind: selected.kind, sourceWorkspaceId: scope.workspaceId,
    destinationWorkspaceId: scope.workspaceId, selections: selected.selections.map(value => ({ ...value })), sourceEvidence });
  const mappings = new Map(legacy.pathMappings.map(mapping => [mapping.source.path, mapping]));
  const isDeleted = (file: string) => selected.kind === 'delete' && mappings.has(file);
  const afterPath = (file: string) => mappings.get(file)?.destinationPath || file;
  const virtual = structuredClone(snapshot) as MutableSnapshot;
  virtual.namespace = virtual.namespace.filter(value => !isDeleted(value.path)).map(value => ({ ...value, path: afterPath(value.path) }));
  virtual.documents = virtual.documents.filter(value => !isDeleted(value.document.path)).map(value => ({ ...value,
    document: { ...value.document, path: afterPath(value.document.path) }, metadata: { ...value.metadata, path: afterPath(value.document.path) },
    links: value.links.flatMap(link => {
      const recipe = legacy.mutations.find(recipe => recipe.source.documentId === value.document.documentId && recipe.linkId === link.id);
      if (!recipe) return [link]; if (recipe.action === 'unlink') return [];
      const next = recipe.nextValue!, wiki = link.kind === 'wiki' ? parseObsidianWikiTarget(next) : null, hash = next.indexOf('#');
      return [{ ...link, literal: wiki?.target ?? next,
        targetPathText: wiki?.path ?? decodeURIComponent(hash < 0 ? next : next.slice(0, hash)) }];
    }) }));
  virtual.physicalSources = virtual.physicalSources.filter(value => !isDeleted(value.path)).map(value => ({ ...value,
    path: afterPath(value.path), metadata: { ...value.metadata, path: afterPath(value.path) },
    links: value.links.map(link => ({ ...link, sourcePath: afterPath(value.path) })) }));
  const physicalLinkIntents: WorkspacePathPhysicalLinkIntentV1[] = [], extraIssues: Issue[] = [];
  const reasons = new Map<string, Set<'selected' | 'link-change'>>();
  const addReason = (file: string, reason: 'selected' | 'link-change') => {
    const values = reasons.get(file) ?? new Set<'selected' | 'link-change'>(); values.add(reason); reasons.set(file, values);
  };
  for (const source of snapshot.physicalSources) if (mappings.has(source.path)) addReason(source.path, 'selected');
  const baseline = buildWorkspaceMixedHtmlLinkGraphV5(virtual);
  for (const edge of before.edges) {
    if (edge.sourceKind !== 'physical-read' || isDeleted(edge.source.path)) continue;
    const sourceMapping = mappings.get(edge.source.path), targetMapping = edge.resolution.target && mappings.get(edge.resolution.target.path);
    const after = baseline.edges.find(value => value.sourceKind === 'physical-read' && value.id === edge.id && value.source.path === afterPath(edge.source.path));
    if (edge.resolution.status !== 'resolved' || !edge.resolution.target) {
      if (sourceMapping && selected.kind !== 'delete') extraIssues.push({ code: 'unresolved-selected-source-link', workspaceId: scope.workspaceId, path: edge.source.path, linkId: edge.id });
      continue;
    }
    if (!sourceMapping && !targetMapping) continue;
    const unchanged = after && equal(resolution(edge), resolution(after));
    const action = selected.kind === 'delete' ? 'unlink' as const : 'rewrite' as const;
    const targetPath = targetMapping?.destinationPath || edge.resolution.target.path;
    // After import, a moved source enters the native formatter even when this
    // occurrence still resolves unchanged. Reject its known format limits now.
    // An unselected stable physical alias remains read-only and needs no import.
    if ((sourceMapping || !unchanged) && (action === 'unlink' && edge.syntax.startsWith('reference-')
      || action === 'rewrite' && (edge.kind === 'wiki' && /[#|\]\\]/u.test(targetPath) || getCanvasNotebookExactLinkTarget(edge.literal)))) {
      extraIssues.push({ code: 'unsupported-target-format', workspaceId: scope.workspaceId, path: edge.source.path, linkId: edge.id }); continue;
    }
    if (unchanged) continue;
    const intent: WorkspacePathPhysicalLinkIntentV1 = { sourcePath: edge.source.path, sourcePathAfter: afterPath(edge.source.path),
      physicalSourceProof: edge.physicalSourceProof, physicalLinkId: edge.id, action, expectedSourceLiteral: edge.literal,
      expectedTargetPathText: edge.targetPathText, expectedTargetIdentity: edge.resolution.target.identity,
      expectedTargetPath: edge.resolution.target.path, targetPathAfter: action === 'unlink' ? null : targetPath,
      fragment: edge.fragment, alias: edge.alias, embed: edge.embed };
    physicalLinkIntents.push(intent); addReason(edge.source.path, 'link-change');
    const owner = virtual.physicalSources.find(source => source.path === intent.sourcePathAfter)!;
    owner.links = owner.links.flatMap(link => {
      if (link.physicalLinkId !== intent.physicalLinkId) return [link]; if (intent.action === 'unlink') return [];
      const targetPathText = edge.kind === 'wiki' || edge.targetPathText.startsWith('/') ? `/${targetPath}`
        : path.posix.relative(path.posix.dirname(intent.sourcePathAfter), targetPath) || path.posix.basename(targetPath);
      return [{ ...link, targetPathText, targetLiteral: `${targetPathText}${edge.fragment === null ? '' : `#${edge.fragment}`}` }];
    });
  }
  const final = buildWorkspaceMixedHtmlLinkGraphV5(virtual), justified = new Set<string>();
  for (const intent of physicalLinkIntents) {
    const actual = final.edges.find(edge => edge.sourceKind === 'physical-read' && edge.id === intent.physicalLinkId && edge.source.path === intent.sourcePathAfter);
    const original = before.edges.find(edge => edge.sourceKind === 'physical-read' && edge.id === intent.physicalLinkId && edge.source.path === intent.sourcePath)!;
    if (intent.action === 'unlink' ? !actual : actual && equal(resolution(original), resolution(actual))) justified.add(JSON.stringify([intent.sourcePath, intent.physicalLinkId]));
  }
  const issues: Issue[] = legacy.issues.filter(issue => {
    if (issue.code === 'physical-source-import-required' && !issue.linkId
      && reasons.get(issue.path)?.has('selected') && snapshot.physicalSources.some(value => value.path === issue.path)) return false;
    return !(['physical-source-import-required', 'resolution-changed'].includes(issue.code) && issue.linkId
      && justified.has(JSON.stringify([issue.path, issue.linkId])));
  });
  for (const source of snapshot.physicalHtmlSources) if (mappings.has(source.path)) extraIssues.push({
    code: 'selected-html-path-import-unsupported', workspaceId: scope.workspaceId, path: source.path });
  for (const entry of snapshot.namespace) if (entry.provider === 'excalidraw' && mappings.has(entry.path)) extraIssues.push({
    code: 'selected-scene-path-import-unsupported', workspaceId: scope.workspaceId, path: entry.path });
  issues.push(...extraIssues);
  for (const edge of before.edges) {
    if (isDeleted(edge.source.path)) continue;
    if (edge.sourceKind === 'native') {
      const documentId = edge.source.documentId;
      if (legacy.mutations.some(recipe => recipe.source.documentId === documentId && recipe.linkId === edge.id && recipe.action === 'unlink')) continue;
    }
    const intent = edge.sourceKind === 'physical-read' && physicalLinkIntents.find(value => value.sourcePath === edge.source.path && value.physicalLinkId === edge.id);
    if (intent && intent.action === 'unlink' && justified.has(JSON.stringify([intent.sourcePath, intent.physicalLinkId]))) continue;
    const actual = final.edges.find(value => value.sourceKind === edge.sourceKind && value.id === edge.id && value.source.path === afterPath(edge.source.path));
    if (!actual || !equal(resolution(edge), resolution(actual))) issues.push({ code: 'resolution-changed', workspaceId: scope.workspaceId, path: edge.source.path, linkId: edge.id });
  }
  // C2 remains an explicit no-effect cohort. Its parser3 binding cannot be
  // invented from a parser4 HTML assessment, even when the HTML is unrelated.
  const unsupportedHtmlImports = new Set([...reasons.keys()].filter(file => {
    const source = snapshot.physicalSources.find(value => value.path === file);
    return !source || source.htmlInspection.occurrences.length > 0;
  }));
  for (const file of unsupportedHtmlImports) issues.push({ code: 'raw-markdown-html-import-unsupported',
    workspaceId: scope.workspaceId, path: file });
  const uniqueIssues = [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  physicalLinkIntents.sort((a, b) => JSON.stringify([a.sourcePath, a.physicalLinkId]).localeCompare(JSON.stringify([b.sourcePath, b.physicalLinkId])));
  const sourceBindings: RawHtmlSourceBindingV1[] = [];
  const importRequirements: WorkspacePathImportRequirementV1[] = [...reasons].filter(([file]) => !unsupportedHtmlImports.has(file))
    .sort(([a], [b]) => a.localeCompare(b)).map(([file, why]) => {
    const original = snapshot.physicalSources.find(value => value.path === file)!;
    const derived = profile(original), binding = decodeRawHtmlSourceBindingV1(derived.binding, original);
    sourceBindings.push(binding);
    return { workspaceId: scope.workspaceId, path: file, reasons: (['selected', 'link-change'] as const).filter(reason => why.has(reason)),
      physicalSourceProof: binding.original3.physicalSourceProof, physical: { ...original.physical },
      importPolicy: { version: 1, initialRepresentation: 'auto', parserVersion: 3 }, preparation: preparation(derived.preparation, original) };
  });
  const body = { version: 4 as const, kind: 'native-path-import-preparation' as const, executionReady: false as const,
    readiness: uniqueIssues.length ? 'blocked' as const : importRequirements.length ? 'requires-import-rebinding' as const : 'native-ready' as const,
    scope, request: selected, sourceEvidence, pathMappings: legacy.pathMappings, importRequirements, sourceBindings, physicalLinkIntents,
    issues: uniqueIssues, coverage: sourceEvidence.coverage, linkAssessment: legacy.htmlAssessment,
    // A zero-link move still changes the virtual namespace. Resolver edge hashes
    // alone retain the original snapshot pin and cannot certify that change.
    graphProofs: { version: 4 as const,
      before: proof({ version: 4, workspaceId: scope.workspaceId, namespace: before.namespace, edges: before.edges, coverage: before.coverage }),
      after: proof({ version: 4, workspaceId: scope.workspaceId, namespace: final.namespace, edges: final.edges, coverage: final.coverage }) } };
  const bounded = capture(body) as typeof body;
  const planId = proof({ ...bounded, sourceEvidence: sourceEvidence.semanticProof });
  return freeze(capture({ ...bounded, planId, integrityProof: proof({ ...bounded, planId }) }) as WorkspacePathHtmlImportPreparationPlanV4);
}

/** Pure preparation only. Current owner/rights/FD guards and explicit original
 * imports are separate writes. Every final native action needs a fresh plan. */
export function createWorkspacePathHtmlImportPreparationPlanV4(input: { scope: WorkspaceOperationJobScope; kind: Kind;
  selections: Array<{ sourcePath: string; destinationPath?: string }>; observation: WorkspaceLinkSourceAuthorityObservation }): WorkspacePathHtmlImportPreparationPlanV4 {
  exact(input, ['scope', 'kind', 'selections', 'observation']);
  const scope = parseWorkspaceOperationJobScope(capture(field(input, 'scope'))), selected = request({ kind: field(input, 'kind'), selections: field(input, 'selections') });
  const observation = field(input, 'observation') as WorkspaceLinkSourceAuthorityObservation;
  const evidence = captureWorkspaceOperationMixedSourceEvidenceV5(scope, observation);
  return build(scope, selected, evidence, source => {
    const stage = field(observation, 'stage'), sources = field(stage, 'sources');
    if (!Array.isArray(sources) || types.isProxy(sources)) return fail();
    let bytes: unknown, sourceInventory: import('../markdown/workspace-physical-link-inventory').OriginalPhysicalLinkInventory | undefined;
    for (let index = 0; index < sources.length; index++) {
      const item = Object.getOwnPropertyDescriptor(sources, String(index)); if (!item?.enumerable || !Object.hasOwn(item, 'value')) return fail();
      if (field(item.value, 'kind') !== 'physical') continue;
      const inventory = field(item.value, 'inventory'); if (field(inventory, 'path') !== source.path) continue;
      sourceInventory = inventory as import('../markdown/workspace-physical-link-inventory').OriginalPhysicalLinkInventory;
      bytes = field(inventory, 'originalBytes'); break;
    }
    if (!bytes || typeof bytes !== 'object' || types.isProxy(bytes) || !ArrayBuffer.isView(bytes)
      || ![Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(bytes))) return fail();
    const typed = Object.getPrototypeOf(Uint8Array.prototype), length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(bytes) as number;
    if (length !== source.physical.byteLength || length > 4 * 1024 * 1024) return fail('PATH_IMPORT_PREPARATION_TOO_LARGE');
    const copy = Buffer.alloc(length); Uint8Array.prototype.set.call(copy, bytes as Uint8Array);
    try {
      const prepared = prepareMarkdownFileImport(copy, { representation: 'auto' });
      const binding = captureRawHtmlSourceBindingV1({ original: sourceInventory!, source4: source });
      return { binding, preparation: { version: 1, representation: prepared.representation, newlineStyle: prepared.newlineStyle, hasBom: prepared.hasBom,
        sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes,
        canonicalHash: createHash('sha256').update(prepared.canonical, 'utf8').digest('hex') } };
    } catch { return fail('PATH_IMPORT_PREPARATION_UNSUPPORTED'); }
  });
}

/** Historical bounded facts only. Recompute the whole semantic proof, not a
 * caller-supplied import list. Import profile truth is repeated by Current. */
export function decodeWorkspacePathHtmlImportPreparationPlanV4(input: unknown): WorkspacePathHtmlImportPreparationPlanV4 {
  const value = capture(input) as WorkspacePathHtmlImportPreparationPlanV4;
  exact(value, ['version', 'kind', 'executionReady', 'readiness', 'scope', 'request', 'sourceEvidence', 'pathMappings',
    'importRequirements', 'sourceBindings', 'physicalLinkIntents', 'issues', 'coverage', 'linkAssessment', 'graphProofs', 'planId', 'integrityProof']);
  if (value.version !== 4 || value.kind !== 'native-path-import-preparation' || value.executionReady !== false
    || !Array.isArray(value.importRequirements) || value.importRequirements.length > 10000 || !digest(value.planId) || !digest(value.integrityProof)) return fail();
  const scope = parseWorkspaceOperationJobScope(value.scope), selected = request(value.request), evidence = decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence);
  const wanted = new Map<string, WorkspacePathImportRequirementV1>();
  for (const item of value.importRequirements) {
    exact(item, ['workspaceId', 'path', 'reasons', 'physicalSourceProof', 'physical', 'importPolicy', 'preparation']);
    if (wanted.has(item.path)) return fail(); wanted.set(item.path, item);
  }
  if (!Array.isArray(value.sourceBindings) || value.sourceBindings.length !== value.importRequirements.length) return fail();
  const sourceBindings = new Map(value.sourceBindings.map(binding => [binding.sourcePath, binding]));
  if (sourceBindings.size !== value.sourceBindings.length) return fail();
  const rebuilt = build(scope, selected, evidence, source => { const supplied = wanted.get(source.path), binding = sourceBindings.get(source.path);
    if (!supplied || !binding) return fail(); return { preparation: supplied.preparation, binding }; });
  if (!equal(value, rebuilt)) return fail(); return rebuilt;
}

export function assertWorkspacePathHtmlImportPreparationPlanV4Current(plan: WorkspacePathHtmlImportPreparationPlanV4,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  const original = decodeWorkspacePathHtmlImportPreparationPlanV4(plan);
  const current = createWorkspacePathHtmlImportPreparationPlanV4({ scope, kind: original.request.kind,
    selections: original.request.selections.map(value => ({ ...value })), observation });
  if (original.planId !== current.planId) fail('PATH_IMPORT_PREPARATION_CHANGED');
}
