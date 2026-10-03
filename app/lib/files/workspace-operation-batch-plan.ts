import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

import { buildWorkspacePlannerSnapshot } from '@/app/lib/markdown/workspace-file-operation-preview';
import { createWorkspaceFileOperationPlan, computeWorkspaceFileOperationPlanId,
  type WorkspacePlannerSnapshot } from '@/app/lib/markdown/workspace-file-operation-planner';
import { buildWorkspaceLinkIndexFromDocuments, type WorkspaceLinkEdge } from '@/app/lib/markdown/workspace-link-index-core';
import { parseCanvasMarkdownDocument } from '@/app/lib/markdown/obsidian-metadata';
import { getWorkspaceLinkLogicalTarget } from '@/app/lib/markdown/workspace-file-operation-link-semantics';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import type { WorkspaceOperationBatchAction, WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every((part) => part && part !== '.' && part !== '..') && !isProtectedAppOutputFolder(value);

type Replacement = { start: number; end: number; text: string };
/** mdast establishes node boundaries; the label scan only extracts bytes inside a parsed node. */
function visibleLabel(content: string, node: Nodes): string {
  const start = node.position!.start.offset!;
  const end = node.position!.end.offset!;
  let cursor = start + (node.type === 'image' || node.type === 'imageReference' ? 2 : 1);
  const labelStart = cursor;
  let depth = 1;
  while (cursor < end) {
    if (content[cursor] === '\\') { cursor += 2; continue; }
    if (content[cursor] === '[') depth += 1;
    if (content[cursor] === ']') depth -= 1;
    if (depth === 0) return content.slice(labelStart, cursor);
    cursor += 1;
  }
  throw new Error('UNSUPPORTED_DELETE_LINK_LABEL');
}

function deleteLinkReplacements(content: string, edges: WorkspaceLinkEdge[]): Replacement[] {
  const replacements: Replacement[] = [];
  const markdownEdges = new Map(edges.filter((edge) => edge.kind === 'markdown').map((edge) => [edge.start, edge]));
  const affectedDefinitions = new Set<string>();
  const parsed = parseCanvasMarkdownDocument(content);
  const visible = parsed.frontmatter ? parsed.frontmatterPrefix.replace(/[^\r\n]/gu, ' ') + parsed.body : content;
  const tree = fromMarkdown(visible);
  const definitions = (node: Nodes): void => {
    if (node.type === 'definition' && markdownEdges.has(node.position!.start.offset!)) affectedDefinitions.add(node.identifier);
    if ('children' in node) node.children.forEach(definitions);
  };
  definitions(tree);
  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || node.type === 'code' || node.type === 'inlineCode') return;
    if ((node.type === 'link' || node.type === 'image') && markdownEdges.has(start)
      || (node.type === 'linkReference' || node.type === 'imageReference') && affectedDefinitions.has(node.identifier)) {
      replacements.push({ start, end, text: visibleLabel(content, node) });
      return;
    }
    if (node.type === 'definition' && affectedDefinitions.has(node.identifier)) {
      replacements.push({ start, end, text: '' });
      return;
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  for (const edge of edges.filter((item) => item.kind === 'wiki')) {
    replacements.push({ start: edge.start, end: edge.end, text: edge.alias ?? edge.targetText });
  }
  return replacements.sort((a, b) => a.start - b.start);
}

function originalOffset(cleanedOffset: number, replacements: Replacement[]): number {
  let delta = 0;
  for (const replacement of replacements) {
    const cleanedStart = replacement.start + delta;
    const cleanedEnd = cleanedStart + replacement.text.length;
    if (cleanedOffset < cleanedStart) break;
    if (cleanedOffset > cleanedStart && cleanedOffset < cleanedEnd) throw new Error('UNSUPPORTED_NESTED_DELETE_LINK');
    if (cleanedOffset >= cleanedEnd) delta += replacement.text.length - (replacement.end - replacement.start);
  }
  return cleanedOffset - delta;
}

/** Mutation identity excludes unrelated diagnostic noise; full safety is still re-evaluated on every first apply. */
export function computeWorkspaceOperationBatchPlanId(plan: Omit<WorkspaceOperationBatchPlan, 'planId' | 'linkPlan'>): string {
  return sha(JSON.stringify({ version: plan.version, workspaceId: plan.workspaceId, actions: plan.actions,
    pathMappings: plan.pathMappings, deletedPaths: plan.deletedPaths, pathSteps: plan.pathSteps,
    linkEdits: plan.linkEdits, originalDocuments: plan.originalDocuments, previewContents: plan.previewContents,
    deletedDocuments: plan.deletedDocuments, expectedPathState: plan.expectedPathState }));
}

/** Pure combined final-state plan. Actions always refer to the same initial workspace snapshot. */
export function createWorkspaceOperationBatchPlan(input: {
  snapshot: WorkspacePlannerSnapshot; actions: WorkspaceOperationBatchAction[];
}): WorkspaceOperationBatchPlan {
  const { snapshot } = input;
  const actions = input.actions.map((action) => ({ ...action, selections: action.selections.map((selection) => ({ ...selection })) }));
  const issues: WorkspaceOperationBatchPlan['issues'] = [];
  const issue = (code: string, path: string, detail: string, reviewId?: string) => issues.push({ code, path, detail, ...(reviewId ? { reviewId } : {}) });
  const roots: Array<WorkspaceOperationBatchPlan['pathSteps'][number]> = [];
  if (!actions.length || actions.length > 1000) issue('action-limit', '.', 'Select between one and 1000 actions.');
  const reviewIds = new Set<string>();
  for (const action of actions) {
    if (!action.reviewId || reviewIds.has(action.reviewId)) issue('duplicate-review', '.', 'Review identifiers must be unique.');
    reviewIds.add(action.reviewId);
    if (!['move', 'rename', 'delete'].includes(action.kind)) { issue('unsupported-action', '.', 'Copy must be reviewed separately.', action.reviewId); continue; }
    if (action.ignoreMissing && action.kind !== 'delete') issue('invalid-action', '.', 'Only delete can ignore absent paths.', action.reviewId);
    if (!action.selections.length) issue('missing-selection', '.', 'An action needs at least one source.', action.reviewId);
    for (const selection of action.selections) {
      if (!validPath(selection.sourcePath) || action.kind !== 'delete' && !validPath(selection.destinationPath)
        || action.kind === 'delete' && selection.destinationPath !== undefined) {
        issue('invalid-path', selection.sourcePath, 'Canonical supported workspace paths are required.', action.reviewId); continue;
      }
      if (!snapshot.entries.some((entry) => entry.path === selection.sourcePath)) {
        if (action.kind === 'delete' && action.ignoreMissing) continue;
        issue('missing-source', selection.sourcePath, 'Selected path is absent.', action.reviewId);
      }
      if (roots.some((root) => within(selection.sourcePath, root.sourcePath) || within(root.sourcePath, selection.sourcePath))) {
        issue('overlapping-selection', selection.sourcePath, 'Selected sources overlap; choose one action for each path.', action.reviewId);
      }
      roots.push({ reviewId: action.reviewId, kind: action.kind, ...selection });
    }
  }
  const deleteRoots = roots.filter((root) => root.kind === 'delete');
  const deleted = (source: string) => deleteRoots.some((root) => within(source, root.sourcePath));
  const deletedPaths = snapshot.entries.filter((entry) => deleted(entry.path)).map((entry) => ({ path: entry.path, kind: entry.kind, identity: entry.identity }));
  if (deletedPaths.length > 1000 || roots.length > 1000) issue('path-limit', '.', 'Too many paths for one batch.');
  const sources = snapshot.entries.filter((entry) => entry.markdownContent !== undefined)
    .map((entry) => ({ path: entry.path, content: entry.markdownContent! }));
  const omitted = snapshot.entries.filter((entry) => entry.omissionReason || entry.kind === 'file'
    && /\.(?:md|markdown)$/iu.test(entry.path) && entry.markdownContent === undefined)
    .map((entry) => ({ path: entry.path, reason: entry.omissionReason === 'source-too-large' ? 'too-large' as const : 'unreadable' as const }));
  const beforeIndex = buildWorkspaceLinkIndexFromDocuments(sources, new Date(0), snapshot.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path), omitted);
  const cleanups = new Map<string, Replacement[]>();
  const cleanedContents = new Map(sources.map((source) => [source.path, source.content]));
  for (const source of sources.filter((item) => !deleted(item.path))) {
    const edges = beforeIndex.edges.filter((edge) => edge.sourcePath === source.path && (
      edge.status === 'resolved' && edge.targetPath && deleted(edge.targetPath)
      || edge.status === 'missing' && (() => {
        const exact = getWorkspaceLinkLogicalTarget(edge);
        return exact !== null && deleteRoots.some((root) => snapshot.entries.some((entry) => entry.path === root.sourcePath && entry.kind === 'directory')
          && exact.startsWith(`${root.sourcePath}/`));
      })()));
    if (!edges.length) continue;
    try {
      const replacements = deleteLinkReplacements(source.content, edges);
      for (let index = 1; index < replacements.length; index += 1) {
        if (replacements[index].start < replacements[index - 1].end) throw new Error('OVERLAPPING_DELETE_LINK_SPANS');
      }
      let content = source.content;
      for (const replacement of [...replacements].reverse()) content = content.slice(0, replacement.start) + replacement.text + content.slice(replacement.end);
      cleanups.set(source.path, replacements);
      cleanedContents.set(source.path, content);
    } catch (error) { issue('unsupported-delete-link', source.path, error instanceof Error ? error.message : 'Cannot safely remove link markup.'); }
  }
  const moveRoots = roots.filter((root) => root.kind !== 'delete');
  const movePlan = createWorkspaceFileOperationPlan({ kind: 'move', sourceWorkspaceId: snapshot.workspaceId,
    destinationWorkspaceId: snapshot.workspaceId, selections: moveRoots.map((root) => ({ sourcePath: root.sourcePath, destinationPath: root.destinationPath! })),
    snapshots: [{ workspaceId: snapshot.workspaceId, entries: snapshot.entries.filter((entry) => !deleted(entry.path))
      .map((entry) => cleanedContents.has(entry.path) ? { ...entry, markdownContent: cleanedContents.get(entry.path), contentHash: undefined } : entry) }] });
  issues.push(...movePlan.issues);
  for (const edge of beforeIndex.edges.filter((candidate) => !deleted(candidate.sourcePath)
    && candidate.status !== 'resolved' && candidate.candidates.some(deleted))) {
    issue('affected-unresolved-link', edge.sourcePath, `Ambiguous link includes a deleted candidate: ${edge.targetLiteral}`);
  }
  // Unreadable deleted Markdown may hide incoming Wiki aliases. Unevaluated
  // outgoing links disappear with the document; surviving sources remain strict.
  for (const omittedSource of omitted.filter((entry) => deleted(entry.path))) issue('incomplete-index', omittedSource.path, 'Unreadable deleted Markdown may contain unknown Wiki aliases.');
  const pathMappings = movePlan.pathMappings.map((mapping) => ({ ...mapping,
    sourceKind: snapshot.entries.find((entry) => entry.path === mapping.sourcePath)!.kind }));
  const moveBySource = new Map(pathMappings.map((mapping) => [mapping.sourcePath, mapping]));
  const linkEdits: WorkspaceOperationBatchPlan['linkEdits'] = [];
  const makeEdit = (sourcePath: string, replacement: Replacement, changeKind: 'rewrite' | 'unlink'): void => {
    const content = snapshot.entries.find((entry) => entry.path === sourcePath)!.markdownContent!;
    const before = content.slice(replacement.start, replacement.end);
    linkEdits.push({ sourceWorkspaceId: snapshot.workspaceId, destinationWorkspaceId: snapshot.workspaceId,
      sourcePathBefore: sourcePath, sourcePathAfter: moveBySource.get(sourcePath)?.destinationPath ?? sourcePath,
      expectedContentHash: sha(content), previousTargetLiteral: before, nextTargetLiteral: replacement.text,
      targetRange: { startUtf16: replacement.start, endUtf16: replacement.end,
        startUtf8Byte: Buffer.byteLength(content.slice(0, replacement.start)), endUtf8Byte: Buffer.byteLength(content.slice(0, replacement.end)) },
      changeKind, snippet: { before, after: replacement.text } });
  };
  for (const [sourcePath, replacements] of cleanups) for (const replacement of replacements) makeEdit(sourcePath, replacement, 'unlink');
  for (const edit of movePlan.linkEdits) {
    try {
      const replacements = cleanups.get(edit.sourcePathBefore) ?? [];
      makeEdit(edit.sourcePathBefore, { start: originalOffset(edit.targetRange.startUtf16, replacements),
        end: originalOffset(edit.targetRange.endUtf16, replacements), text: edit.nextTargetLiteral }, 'rewrite');
    } catch (error) { issue('unsupported-overlap', edit.sourcePathBefore, error instanceof Error ? error.message : 'Link edits overlap.'); }
  }
  linkEdits.sort((a, b) => a.sourcePathBefore.localeCompare(b.sourcePathBefore) || a.targetRange.startUtf16 - b.targetRange.startUtf16);
  const originalDocuments: WorkspaceOperationBatchPlan['originalDocuments'] = [];
  const previewContents: WorkspaceOperationBatchPlan['previewContents'] = [];
  for (const sourcePath of new Set(linkEdits.map((edit) => edit.sourcePathBefore))) {
    const original = snapshot.entries.find((entry) => entry.path === sourcePath)!.markdownContent!;
    const edits = linkEdits.filter((edit) => edit.sourcePathBefore === sourcePath).sort((a, b) => b.targetRange.startUtf16 - a.targetRange.startUtf16);
    let final = original;
    let right = original.length;
    for (const edit of edits) {
      if (edit.targetRange.endUtf16 > right || original.slice(edit.targetRange.startUtf16, edit.targetRange.endUtf16) !== edit.previousTargetLiteral) {
        issue('overlapping-edits', sourcePath, 'Combined link spans could not be proven.'); break;
      }
      right = edit.targetRange.startUtf16;
      final = final.slice(0, right) + edit.nextTargetLiteral + final.slice(edit.targetRange.endUtf16);
    }
    originalDocuments.push({ workspaceId: snapshot.workspaceId, path: sourcePath, content: original });
    previewContents.push({ workspaceId: snapshot.workspaceId, path: moveBySource.get(sourcePath)?.destinationPath ?? sourcePath, content: final });
  }
  if (previewContents.length > 256 || previewContents.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) > 64 * 1024 * 1024) {
    issue('content-limit', '.', 'Batch link changes exceed the secure staging limit.');
  }
  // Repaired links may require no literal rewrite. Retain their original graph
  // privately so Undo can restore the recorded missing state, with exact fences.
  for (const restored of movePlan.linkAssessment?.restoredLinks ?? []) {
    if (originalDocuments.some((document) => document.path === restored.sourcePath)) continue;
    const content = snapshot.entries.find((entry) => entry.path === restored.sourcePath)?.markdownContent;
    if (content !== undefined) originalDocuments.push({ workspaceId: snapshot.workspaceId, path: restored.sourcePath, content });
  }
  const pathSteps = [...deleteRoots];
  const pending = [...moveRoots];
  while (pending.length) {
    const index = pending.findIndex((candidate) => !pending.some((other) => other !== candidate && within(candidate.destinationPath!, other.sourcePath)));
    if (index < 0) { issue('dependency-cycle', '.', 'Move destinations form a cycle; use an intermediate reviewed location.'); break; }
    pathSteps.push(pending.splice(index, 1)[0]);
  }
  const expected = new Map(movePlan.expectedPathState.map((entry) => [entry.path, entry]));
  for (const entry of snapshot.entries.filter((candidate) => deleted(candidate.path) || linkEdits.some((edit) => edit.sourcePathBefore === candidate.path))) {
    expected.set(entry.path, { workspaceId: snapshot.workspaceId, path: entry.path, identity: entry.identity,
      contentHash: entry.markdownContent === undefined ? entry.contentHash ?? null : sha(entry.markdownContent) });
  }
  // A destination may be occupied initially by a path explicitly removed in this same batch.
  for (const mapping of pathMappings) {
    const entry = snapshot.entries.find((candidate) => candidate.path === mapping.destinationPath);
    if (entry && deleted(entry.path)) expected.set(entry.path, { workspaceId: snapshot.workspaceId, path: entry.path,
      identity: entry.identity, contentHash: entry.markdownContent === undefined ? entry.contentHash ?? null : sha(entry.markdownContent) });
  }
  const linkAssessment = { ...movePlan.linkAssessment!,
    complete: movePlan.linkAssessment!.complete && omitted.length === 0,
    warnings: [...movePlan.linkAssessment!.warnings], blockers: [...movePlan.linkAssessment!.blockers] };
  for (const edge of beforeIndex.edges.filter((candidate) => !deleted(candidate.sourcePath)
    && candidate.status !== 'resolved' && candidate.candidates.some(deleted))) {
    linkAssessment.blockers.push({ workspaceId: snapshot.workspaceId, sourcePath: edge.sourcePath,
      targetLiteral: edge.targetLiteral, status: edge.status, reason: 'affected-unresolved-link' });
    linkAssessment.warnings = linkAssessment.warnings.filter((warning) => warning.sourcePath !== edge.sourcePath || warning.targetLiteral !== edge.targetLiteral);
  }
  const deletedDocuments = sources.filter((source) => deleted(source.path)).map((source) => ({ workspaceId: snapshot.workspaceId, ...source }));
  const body = { version: 1 as const, workspaceId: snapshot.workspaceId, actions, pathMappings, deletedPaths, pathSteps,
    linkEdits, originalDocuments, previewContents, expectedPathState: [...expected.values()].sort((a, b) => a.path.localeCompare(b.path)),
    deletedDocuments, coverage: beforeIndex.coverage, linkAssessment, issues,
    readiness: issues.length ? 'blocked' as const : 'ready' as const };
  const planId = computeWorkspaceOperationBatchPlanId(body);
  // Self mappings provide scopes/identity for delete-only document writes without inventing a physical move.
  const writeMappings = pathMappings.length ? pathMappings : originalDocuments.map((document) => ({
    sourceWorkspaceId: snapshot.workspaceId, destinationWorkspaceId: snapshot.workspaceId,
    sourcePath: document.path, destinationPath: document.path,
    sourceIdentity: snapshot.entries.find((entry) => entry.path === document.path)!.identity,
  }));
  const rawLinkPlan = { ...movePlan, pathMappings: writeMappings, linkEdits: linkEdits.map(({ changeKind: _kind, snippet: _snippet, ...edit }) => edit),
    expectedPathState: body.expectedPathState, previewContents, issues: [], readiness: body.readiness,
    coverage: movePlan.coverage, linkAssessment: movePlan.linkAssessment };
  const linkPlan = { ...rawLinkPlan, planId: computeWorkspaceFileOperationPlanId(rawLinkPlan) };
  return { ...body, planId, linkPlan };
}

export async function buildWorkspaceOperationBatchPlan(input: {
  scope: WorkspaceOperationBatchScope; actions: WorkspaceOperationBatchAction[];
}): Promise<WorkspaceOperationBatchPlan> {
  if (!input.scope.workspace.permissions.canRead) throw Object.assign(new Error('Workspace read permission is required.'), { status: 403 });
  const snapshot = await buildWorkspacePlannerSnapshot(input.scope.workspace.workspaceId, input.scope.fileOptions);
  return createWorkspaceOperationBatchPlan({ snapshot, actions: input.actions });
}

export function workspaceOperationBatchPublicPreview(plan: WorkspaceOperationBatchPlan) {
  const { originalDocuments: _originals, deletedDocuments: _deleted, previewContents: _contents, linkPlan: _links, ...publicPlan } = plan;
  return publicPlan;
}
