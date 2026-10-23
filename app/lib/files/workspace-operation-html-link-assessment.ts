import 'server-only';

import { types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { assessWorkspaceHtmlLink } from '../markdown/workspace-html-link-assessment';
import type { WorkspaceFileOperationPlanRequest } from '../markdown/workspace-file-operation-planner';
import type { WorkspaceFileOperationLinkAssessmentV1, WorkspaceFilePathMappingV1 } from '../markdown/workspace-link-contract-v1';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationSourceHtmlOccurrencesV5,
  type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';

function htmlAssessmentInvalid(): never {
  throw Object.assign(new Error('HTML operation assessment requires coherent source facts and path mappings.'),
    { code: 'WORKSPACE_HTML_ASSESSMENT_INVALID' });
}

function htmlAssessmentWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/** Facts only. Original coverage is retained by Evidence5; this result certifies
 * only HTML independence for this exact operation. Ordinary graph/coverage
 * guards remain separate. No Markdown export, I/O or mutation occurs here. */
export function assessWorkspaceOperationHtmlLinksV1(input: {
  request: Omit<WorkspaceFileOperationPlanRequest, 'snapshots'>;
  pathMappings: readonly WorkspaceFilePathMappingV1[];
  sourceEvidence: WorkspaceOperationMixedSourceEvidenceV5;
  destinationEvidence?: WorkspaceOperationMixedSourceEvidenceV5;
}): WorkspaceFileOperationLinkAssessmentV1 {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) htmlAssessmentInvalid();
  const keys = Reflect.ownKeys(input);
  const required = ['request', 'pathMappings', 'sourceEvidence'];
  if (keys.length < required.length || keys.length > required.length + 1
    || keys.some(key => typeof key !== 'string' || ![...required, 'destinationEvidence'].includes(key))) htmlAssessmentInvalid();
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) htmlAssessmentInvalid();
    captured[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(captured, key))) htmlAssessmentInvalid();
  const data = captureWorkspaceOperationNativePlanData({ request: captured.request, pathMappings: captured.pathMappings },
    htmlAssessmentInvalid, 16 * 1024 * 1024) as Pick<typeof input, 'request' | 'pathMappings'>;
  const { request, pathMappings } = data;
  const exact = (value: object, names: readonly string[]): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) htmlAssessmentInvalid();
  };
  const canonical = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096
    && Buffer.from(value).toString('utf8') === value && isCanonicalAdmissionPath(value);
  exact(request, ['kind', 'sourceWorkspaceId', 'destinationWorkspaceId', 'selections']);
  if (!['move', 'rename', 'delete', 'copy'].includes(request.kind) || !Array.isArray(request.selections)
    || !request.selections.length || request.selections.length > 10_000 || !Array.isArray(pathMappings)
    || pathMappings.length > 10_000) htmlAssessmentInvalid();
  const source = decodeWorkspaceOperationMixedSourceEvidenceV5(captured.sourceEvidence);
  if (request.sourceWorkspaceId !== source.workspaceScope.workspaceId) htmlAssessmentInvalid();
  const destination = captured.destinationEvidence === undefined ? source
    : decodeWorkspaceOperationMixedSourceEvidenceV5(captured.destinationEvidence);
  if (request.destinationWorkspaceId !== destination.workspaceScope.workspaceId
    || request.sourceWorkspaceId === request.destinationWorkspaceId && source.evidenceProof !== destination.evidenceProof
    || request.kind !== 'copy' && request.sourceWorkspaceId !== request.destinationWorkspaceId) htmlAssessmentInvalid();
  const sourceEntries = new Map(source.namespace.map(entry => [entry.path, entry]));
  const destinationEntries = new Map(destination.namespace.map(entry => [entry.path, entry]));
  const selections = new Map<string, typeof request.selections[number]>();
  for (const selection of request.selections) {
    exact(selection, ['sourcePath', 'destinationPath']);
    if (!canonical(selection.sourcePath) || !sourceEntries.has(selection.sourcePath) || selections.has(selection.sourcePath)
      || (request.kind === 'delete' ? selection.destinationPath !== '' : !canonical(selection.destinationPath))
      || request.kind !== 'delete' && request.sourceWorkspaceId === request.destinationWorkspaceId
        && htmlAssessmentWithin(selection.destinationPath, selection.sourcePath)) htmlAssessmentInvalid();
    selections.set(selection.sourcePath, selection);
  }
  for (const root of selections.keys()) {
    let parent = root;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      if (selections.has(parent)) htmlAssessmentInvalid();
    }
  }
  const expected = new Map<string, { destinationPath: string; identity: string }>();
  for (const entry of source.namespace) {
    let root = entry.path;
    while (!selections.has(root) && root.includes('/')) root = root.slice(0, root.lastIndexOf('/'));
    const selection = selections.get(root);
    if (selection) expected.set(entry.path, { identity: entry.identity,
      destinationPath: request.kind === 'delete' ? '' : selection.destinationPath + entry.path.slice(root.length) });
  }
  if (request.kind === 'delete' ? pathMappings.length !== 0 : pathMappings.length !== expected.size) htmlAssessmentInvalid();
  const mapped = new Set<string>(), destinations = new Set<string>();
  for (const mapping of pathMappings) {
    exact(mapping, ['sourceWorkspaceId', 'sourcePath', 'destinationWorkspaceId', 'destinationPath', 'sourceIdentity']);
    const entry = expected.get(mapping.sourcePath);
    if (!entry || mapping.sourceWorkspaceId !== request.sourceWorkspaceId
      || mapping.destinationWorkspaceId !== request.destinationWorkspaceId || mapping.sourceIdentity !== entry.identity
      || mapping.destinationPath !== entry.destinationPath || !canonical(mapping.destinationPath)
      || mapped.has(mapping.sourcePath) || destinations.has(mapping.destinationPath)) htmlAssessmentInvalid();
    mapped.add(mapping.sourcePath); destinations.add(mapping.destinationPath);
    if (destinationEntries.has(mapping.destinationPath)
      && !(request.kind !== 'copy' && expected.has(mapping.destinationPath))) htmlAssessmentInvalid();
    let parent = mapping.destinationPath;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      if (destinationEntries.get(parent)?.kind === 'file') htmlAssessmentInvalid();
    }
  }
  const mappedEntries = new Map(pathMappings.map(mapping => [mapping.destinationPath, sourceEntries.get(mapping.sourcePath)!]));
  for (const mapping of pathMappings) {
    let parent = mapping.destinationPath;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      if (mappedEntries.get(parent)?.kind === 'file') htmlAssessmentInvalid();
    }
  }
  const evidences = request.sourceWorkspaceId === request.destinationWorkspaceId ? [source] : [source, destination];
  const assessment: WorkspaceFileOperationLinkAssessmentV1 = { version: 1, complete: true, warnings: [], blockers: [] };
  for (const evidence of evidences) {
    const workspaceId = evidence.workspaceScope.workspaceId;
    const beforePaths = new Set(evidence.namespace.filter(entry => entry.kind === 'file').map(entry => entry.path));
    const afterPaths = new Set(beforePaths);
    if (workspaceId === request.sourceWorkspaceId && request.kind !== 'copy') {
      for (const selectedPath of expected.keys()) afterPaths.delete(selectedPath);
    }
    if (workspaceId === request.destinationWorkspaceId && request.kind !== 'delete') {
      for (const mapping of pathMappings) if (sourceEntries.get(mapping.sourcePath)?.kind === 'file') afterPaths.add(mapping.destinationPath);
    }
    const sourceScopes = request.kind === 'delete' ? [] : [
      ...(workspaceId === request.sourceWorkspaceId ? [...selections.keys()] : []),
      ...(workspaceId === request.destinationWorkspaceId ? request.selections.map(selection => selection.destinationPath) : []),
    ];
    const targetScopes = [
      ...(workspaceId === request.sourceWorkspaceId && request.kind !== 'copy' ? [...selections.keys()] : []),
      ...(workspaceId === request.destinationWorkspaceId && request.kind !== 'delete'
        ? request.selections.map(selection => selection.destinationPath) : []),
    ];
    for (const occurrence of workspaceOperationSourceHtmlOccurrencesV5(evidence)) {
      // A deleted source has no surviving outgoing reference. Other incomplete
      // sources are never omitted merely because their known targets look safe.
      if (workspaceId === request.sourceWorkspaceId && request.kind === 'delete' && expected.has(occurrence.sourcePath)) continue;
      if (!beforePaths.has(occurrence.sourcePath) || !Number.isSafeInteger(occurrence.line) || occurrence.line < 1) htmlAssessmentInvalid();
      if (occurrence.fullyInspected && occurrence.explicitLocalTargets.length === 0) continue;
      const html = occurrence.fullyInspected ? assessWorkspaceHtmlLink({ reason: 'html', sourcePath: occurrence.sourcePath,
        htmlTargets: [...occurrence.explicitLocalTargets] }, { beforePaths, afterPaths, sourceScopes, targetScopes }) : null;
      // The occurrence API contains decoded actual targets, not raw HTML. Never
      // invent raw/start facts or pass this DTO to the historical HTML decoder.
      const targetLiteral = occurrence.explicitLocalTargets.join(', ');
      if (html?.unaffected) assessment.warnings.push({ workspaceId, sourcePath: occurrence.sourcePath, targetLiteral,
        status: 'not-evaluated', reason: 'unaffected-explicit-html-link', htmlTargets: html.targets });
      else {
        assessment.complete = false;
        assessment.blockers.push({ workspaceId, sourcePath: occurrence.sourcePath, targetLiteral,
          status: 'not-evaluated', reason: html ? 'affected-html-link' : 'unevaluated-link',
          ...(html ? { htmlTargets: html.targets } : {}), line: occurrence.line });
      }
    }
  }
  for (const row of [...assessment.warnings, ...assessment.blockers]) {
    if (row.htmlTargets) Object.freeze(row.htmlTargets);
    Object.freeze(row);
  }
  Object.freeze(assessment.warnings); Object.freeze(assessment.blockers);
  return Object.freeze(assessment);
}
