import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import { types } from 'node:util';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { parseObsidianBlockIds } from './obsidian-flavored-markdown';
import { parseCanvasMarkdownDocument } from './obsidian-metadata';
import { evaluateWorkspaceHtmlLinks, inspectWorkspaceStaticHtmlLinks, type WorkspaceStaticHtmlLinkInspection } from './workspace-html-link-safety';
import { extractWorkspaceMarkdownHeadings, resolveWorkspaceWikiFileLink } from './workspace-link-index-core';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';
import { inspectWorkspaceMarkdownHtmlV4, parseWorkspaceLocalLinks, parseWorkspaceLocalLinksV3, parseWorkspaceLocalLinksV4, resolveExactWorkspaceLink,
  type ParsedWorkspaceLocalLink, type WorkspaceMarkdownHtmlInspectionV4 } from './workspace-local-link-parser';
import { nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry } from './workspace-link-contract-v2';
import type { WorkspaceLinkTargetRangeV1 } from './workspace-link-contract-v1';

export type PhysicalLinkSourceAuthority =
  | { kind: 'unregistered'; catalogueProof: string }
  | { kind: 'registered-never-initialized'; catalogueProof: string; registeredDocumentId: string; lineageId: string | null };
export type PhysicalSourceGap = { code: string; path: string; startUtf16?: number; htmlTargets?: string[] };
export type OriginalPhysicalLink = ParsedWorkspaceLocalLink & {
  physicalLinkId: string;
  syntaxRange: WorkspaceLinkTargetRangeV1;
  targetRange: WorkspaceLinkTargetRangeV1;
};
export type OriginalPhysicalLinkInventory = {
  physicalSourceVersion: 1;
  /** Omitted historical evidence and explicit 2 retain legacy parsing. */
  parserVersion?: 2 | 3;
  source: 'original-physical-bytes';
  workspaceId: string;
  organizationId: string | null;
  path: string;
  authority: PhysicalLinkSourceAuthority;
  physical: { filesystemIdentity: string; byteHash: string; byteLength: number };
  /** Private staged payload, never a public preview or a native Yjs snapshot. */
  originalBytes: Uint8Array;
  encoding: 'utf8';
  hasBom: boolean;
  lineEndings: { style: 'none' | 'lf' | 'crlf' | 'mixed' | 'bare-cr'; lf: number; crlf: number; bareCr: number };
  frontmatterPrefix: string;
  metadata: NativeDocumentLinkInventory['metadata'];
  links: OriginalPhysicalLink[];
  coverage: { complete: boolean; gaps: PhysicalSourceGap[] };
  applicability: 'requires-import-and-rebinding';
  executionReady: false;
  physicalSourceProof: string;
};
export type OriginalPhysicalLinkInventoryV4 = Omit<OriginalPhysicalLinkInventory, 'parserVersion'> & {
  parserVersion: 4;
  htmlInspection: WorkspaceMarkdownHtmlInspectionV4;
};
export type OriginalPhysicalHtmlInventoryV4 = Pick<OriginalPhysicalLinkInventory,
  'workspaceId' | 'organizationId' | 'path' | 'authority' | 'physical' | 'originalBytes' | 'encoding' | 'hasBom' | 'lineEndings'> & {
  htmlSourceVersion: 4;
  source: 'original-physical-html-bytes';
  htmlInspection: WorkspaceStaticHtmlLinkInspection;
  applicability: 'requires-operation-assessment';
  executionReady: false;
  htmlSourceProof: string;
};
export type WorkspaceSourceAuthorityStage = {
  stageVersion: 1;
  workspaceId: string;
  organizationId: string | null;
  catalogueProof: string | null;
  namespace: NativeNamespaceEntry[];
  sources: Array<{ kind: 'physical'; inventory: OriginalPhysicalLinkInventory }
    | { kind: 'native'; inventory: NativeDocumentLinkInventory }>;
  scope: { kind: 'visible-workspace' | 'document-index'; excludedPaths: string[] };
  coverage: { complete: boolean; gaps: PhysicalSourceGap[] };
  readiness: 'requires-import-and-rebinding' | 'native-coordinator-required' | 'blocked';
  executionReady: false;
  stageProof: string;
};

const proof = nativeLinkJsonProof;
export function originalPhysicalByteHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function originalPhysicalSourceProof(inventory: Omit<OriginalPhysicalLinkInventory, 'physicalSourceProof'> | OriginalPhysicalLinkInventory): string {
  const { originalBytes, ...body } = inventory;
  const { physicalSourceProof: _stored, ...withoutProof } = body as Omit<OriginalPhysicalLinkInventory, 'originalBytes'>;
  return proof({ ...withoutProof, observedOriginalByteHash: originalPhysicalByteHash(originalBytes) });
}
export function workspaceSourceAuthorityStageProof(stage: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> | WorkspaceSourceAuthorityStage): string {
  const { stageProof: _stored, ...body } = stage as WorkspaceSourceAuthorityStage;
  return proof({ ...body, sources: stage.sources.map((source) => source.kind === 'native' ? source
    : { kind: source.kind, claimedPhysicalSourceProof: source.inventory.physicalSourceProof,
      originalByteHash: originalPhysicalByteHash(source.inventory.originalBytes),
      physicalSourceProof: originalPhysicalSourceProof(source.inventory) }) });
}
function originalByteOffsets(text: string, links: ParsedWorkspaceLocalLink[]): Map<number, number> {
  const offsets = [...new Set(links.flatMap((link) => [link.start, link.end, link.targetStart, link.targetEnd]))].sort((a, b) => a - b);
  const bytes = new Map<number, number>(); let previous = 0; let byteOffset = 0;
  for (const offset of offsets) {
    const before = text.charCodeAt(offset - 1); const after = text.charCodeAt(offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
      || before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) throw new Error('Physical link range splits source Unicode.');
    byteOffset += Buffer.byteLength(text.slice(previous, offset), 'utf8'); bytes.set(offset, byteOffset); previous = offset;
  }
  return bytes;
}
function sourceRange(start: number, end: number, bytes: Map<number, number>): WorkspaceLinkTargetRangeV1 {
  const startUtf8Byte = bytes.get(start); const endUtf8Byte = bytes.get(end);
  if (startUtf8Byte === undefined || endUtf8Byte === undefined || end < start) throw new Error('Physical link range is invalid.');
  return { startUtf16: start, endUtf16: end, startUtf8Byte, endUtf8Byte };
}

/** Parses exact staged bytes. The supplied authority is evidence from the
 * fenced catalogue reader, not permission to initialize, import or write. */
export function inspectOriginalPhysicalLinks(input: {
  workspaceId: string; organizationId: string | null; path: string;
  authority: PhysicalLinkSourceAuthority; bytes: Uint8Array; filesystemIdentity: string; maxLinks?: number;
}): OriginalPhysicalLinkInventory {
  return inspectOriginalPhysicalLinksForParser(input, 2);
}

/** Read-only index profile. Invalid, structurally closed YAML cannot erase
 * otherwise readable body links. Its gap still forbids mutation certification. */
export function inspectOriginalPhysicalDocumentLinksForRead(input: Parameters<typeof inspectOriginalPhysicalLinks>[0]): OriginalPhysicalLinkInventory {
  return inspectOriginalPhysicalLinksForParser(input, 2, true);
}

/** Explicit parser-3 capture keeps source bytes and original UTF-16/UTF-8
 * ranges; historical parser-2 captures never enter this arm implicitly. */
export function inspectOriginalPhysicalLinksV3(input: Parameters<typeof inspectOriginalPhysicalLinks>[0]): OriginalPhysicalLinkInventory {
  return inspectOriginalPhysicalLinksForParser(input, 3);
}

/** New exact grammar only. HTML is a distinct source, never a Markdown import. */
export function inspectOriginalPhysicalLinksV4(input: Parameters<typeof inspectOriginalPhysicalLinks>[0]): OriginalPhysicalLinkInventoryV4 {
  if (!/\.(?:md|markdown)$/iu.test(input.path)) throw new Error('Physical parser 4 requires a Markdown source.');
  const bytes = copyBoundedPhysicalSourceBytesV4(input.bytes);
  const { physicalSourceProof: _baseProof, ...inventory } = inspectOriginalPhysicalLinksForParser({ ...input, bytes }, 4);
  const text = Buffer.from(inventory.originalBytes.buffer, inventory.originalBytes.byteOffset, inventory.originalBytes.byteLength).toString('utf8');
  const body = { ...inventory, htmlInspection: inspectWorkspaceMarkdownHtmlV4(text, input.path) };
  return { ...body, physicalSourceProof: originalPhysicalSourceProofV4(body) };
}

/** New captures use actual typed-array slots, never an overridden iterator or
 * apparent byteLength. Historical parser2/3 retain their original byte reader. */
function copyBoundedPhysicalSourceBytesV4(input: Uint8Array): Uint8Array {
  if (!input || types.isProxy(input) || !ArrayBuffer.isView(input)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))
    || ['byteLength', 'byteOffset', 'buffer', 'constructor'].some(key => Object.hasOwn(input, key))) {
    throw new TypeError('Physical source requires genuine byte-array storage.');
  }
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const size = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!.call(input) as number;
  const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!.call(input) as ArrayBuffer;
  if (!types.isArrayBuffer(buffer) || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) {
    throw new TypeError('Physical source requires private byte-array storage.');
  }
  if (size > MAX_INDEXED_MARKDOWN_BYTES) throw new RangeError('Physical source exceeds its byte limit.');
  const bytes = new Uint8Array(size);
  Uint8Array.prototype.set.call(bytes, input);
  return bytes;
}

function readOriginalPhysicalText(bytes: Uint8Array) {
  const originalBytes = Uint8Array.from(bytes);
  const originalBuffer = Buffer.from(originalBytes.buffer, originalBytes.byteOffset, originalBytes.byteLength);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes);
  if (!Buffer.from(text, 'utf8').equals(originalBuffer) || text.includes('\0')) throw new Error('Original Markdown bytes are not strict UTF-8 text.');
  const crlf = (text.match(/\r\n/gu) ?? []).length; const remainder = text.replace(/\r\n/gu, '');
  const lf = (remainder.match(/\n/gu) ?? []).length; const bareCr = (remainder.match(/\r/gu) ?? []).length;
  const style: OriginalPhysicalLinkInventory['lineEndings']['style'] = bareCr ? 'bare-cr' : lf && crlf ? 'mixed' : lf ? 'lf' : crlf ? 'crlf' : 'none';
  return { originalBytes, originalBuffer, text, lineEndings: { style, lf, crlf, bareCr } };
}

export function originalPhysicalSourceProofV4(inventory: Omit<OriginalPhysicalLinkInventoryV4, 'physicalSourceProof'> | OriginalPhysicalLinkInventoryV4): string {
  const { originalBytes, ...body } = inventory;
  const { physicalSourceProof: _stored, ...withoutProof } = body as Omit<OriginalPhysicalLinkInventoryV4, 'originalBytes'>;
  return proof({ ...withoutProof, observedOriginalByteHash: originalPhysicalByteHash(originalBytes) });
}

export function originalPhysicalHtmlSourceProofV4(inventory: Omit<OriginalPhysicalHtmlInventoryV4, 'htmlSourceProof'> | OriginalPhysicalHtmlInventoryV4): string {
  const { originalBytes, ...body } = inventory;
  const { htmlSourceProof: _stored, ...withoutProof } = body as Omit<OriginalPhysicalHtmlInventoryV4, 'originalBytes'>;
  return proof({ ...withoutProof, observedOriginalByteHash: originalPhysicalByteHash(originalBytes) });
}

/** Source facts only. This neither imports HTML nor permits a file operation. */
export function inspectOriginalPhysicalHtmlV4(input: Parameters<typeof inspectOriginalPhysicalLinks>[0]): OriginalPhysicalHtmlInventoryV4 {
  if (!/\.html?$/iu.test(input.path)) throw new Error('Physical HTML inspection requires an HTML source.');
  const { originalBytes, text, lineEndings } = readOriginalPhysicalText(copyBoundedPhysicalSourceBytesV4(input.bytes));
  const body: Omit<OriginalPhysicalHtmlInventoryV4, 'htmlSourceProof'> = { htmlSourceVersion: 4,
    source: 'original-physical-html-bytes', workspaceId: input.workspaceId, organizationId: input.organizationId,
    path: input.path, authority: structuredClone(input.authority),
    physical: { filesystemIdentity: input.filesystemIdentity, byteHash: originalPhysicalByteHash(originalBytes), byteLength: originalBytes.length },
    originalBytes, encoding: 'utf8', hasBom: text.charCodeAt(0) === 0xfeff, lineEndings,
    htmlInspection: inspectWorkspaceStaticHtmlLinks(text), applicability: 'requires-operation-assessment', executionReady: false };
  return { ...body, htmlSourceProof: originalPhysicalHtmlSourceProofV4(body) };
}

function inspectOriginalPhysicalLinksForParser<Parser extends 2 | 3 | 4>(input: Parameters<typeof inspectOriginalPhysicalLinks>[0],
  parserVersion: Parser, documentIndexRead = false): Omit<OriginalPhysicalLinkInventory, 'parserVersion'> & { parserVersion: Parser } {
  const { originalBytes, originalBuffer, text, lineEndings } = readOriginalPhysicalText(input.bytes);
  const gaps: PhysicalSourceGap[] = []; const links: OriginalPhysicalLink[] = [];
  const parsedDocument = parseCanvasMarkdownDocument(text);
  if (parsedDocument.error) gaps.push({ code: 'invalid-frontmatter', path: input.path });
  const readableBody = !parsedDocument.error || documentIndexRead && parsedDocument.frontmatter !== null;
  if (documentIndexRead && !readableBody) gaps.push({ code: 'uninspected-source', path: input.path });
  const metadataBody = parserVersion !== 2 && !parsedDocument.frontmatter && text.charCodeAt(0) === 0xfeff
    ? parsedDocument.body.slice(1) : parsedDocument.body;
  const headings = readableBody ? extractWorkspaceMarkdownHeadings(metadataBody) : [];
  const metadata = { path: input.path, aliases: parsedDocument.frontmatter?.aliases ?? [], tags: parsedDocument.frontmatter?.tags ?? [],
    title: parsedDocument.frontmatter?.title || headings[0]?.text || path.posix.basename(input.path).replace(/\.(?:md|markdown)$/iu, ''),
    hasExplicitTitle: Boolean(parsedDocument.frontmatter?.title), headings,
    blockIds: readableBody ? parseObsidianBlockIds(metadataBody).map((entry) => entry.id) : [] };
  const physical = { filesystemIdentity: input.filesystemIdentity, byteHash: originalPhysicalByteHash(originalBytes), byteLength: originalBytes.length };
  if (/\.mdx$/iu.test(input.path)) gaps.push({ code: 'unsupported-mdx-source', path: input.path });
  else if (/\.html?$/iu.test(input.path)) {
    const html = evaluateWorkspaceHtmlLinks(text);
    gaps.push({ code: 'uninspected-html', path: input.path, ...(html.explicitLocalTargets ? { htmlTargets: html.explicitLocalTargets } : {}) });
  } else if (!/\.(?:md|markdown)$/iu.test(input.path)) gaps.push({ code: 'unsupported-physical-source', path: input.path });
  else if (readableBody) {
    const parsed = (parserVersion === 4 ? parseWorkspaceLocalLinksV4 : parserVersion === 3 ? parseWorkspaceLocalLinksV3 : parseWorkspaceLocalLinks)(text, input.path, { notebookPaths: 'exact' });
    for (const unevaluated of parsed.unevaluated) gaps.push({ code: unevaluated.reason === 'html' ? 'uninspected-html' : `unevaluated-${unevaluated.reason}`,
      path: input.path, startUtf16: unevaluated.start, ...(unevaluated.htmlTargets ? { htmlTargets: unevaluated.htmlTargets } : {}) });
    const maxLinks = input.maxLinks ?? 20_000;
    if (!Number.isSafeInteger(maxLinks) || maxLinks < 0 || maxLinks > 20_000) throw new Error('Invalid physical source link bound.');
    if (parsed.links.length > maxLinks) gaps.push({ code: 'source-link-limit', path: input.path });
    const boundedLinks = parsed.links.length > maxLinks ? [] : parsed.links;
    const byteOffsets = originalByteOffsets(text, boundedLinks);
    for (const link of boundedLinks) {
      const syntaxRange = sourceRange(link.start, link.end, byteOffsets); const targetRange = sourceRange(link.targetStart, link.targetEnd, byteOffsets);
      if (text.slice(link.start, link.end) !== link.raw || text.slice(link.targetStart, link.targetEnd) !== link.targetLiteral
        || originalBuffer.subarray(targetRange.startUtf8Byte, targetRange.endUtf8Byte).toString('utf8') !== link.targetLiteral) throw new Error('Physical source span differs from original bytes.');
      links.push({ ...link, physicalLinkId: `physical:${proof({ workspaceId: input.workspaceId, path: input.path, authority: input.authority,
        physical, syntaxRange, targetRange, raw: link.raw })}`, syntaxRange, targetRange });
    }
  }
  const body = { physicalSourceVersion: 1 as const, parserVersion, source: 'original-physical-bytes' as const,
    workspaceId: input.workspaceId, organizationId: input.organizationId, path: input.path, authority: structuredClone(input.authority),
    physical, originalBytes, encoding: 'utf8' as const, hasBom: text.charCodeAt(0) === 0xfeff,
    lineEndings, frontmatterPrefix: parsedDocument.frontmatterPrefix, metadata, links,
    coverage: { complete: !gaps.length, gaps }, applicability: 'requires-import-and-rebinding' as const, executionReady: false as const };
  const { originalBytes: _private, ...facts } = body;
  return { ...body, physicalSourceProof: proof({ ...facts, observedOriginalByteHash: originalPhysicalByteHash(originalBytes) }) };
}

export type StagedWorkspaceLinkEffectPreview = {
  previewVersion: 1;
  stageProof: string;
  executionReady: false;
  readiness: WorkspaceSourceAuthorityStage['readiness'];
  coverage: WorkspaceSourceAuthorityStage['coverage'];
  /** Effects are descriptive; these spans are NEVER NativeLinkReference. */
  effects: Array<{ sourcePath: string; sourcePathAfter: string; targetPath: string;
    action: 'rewrite' | 'unlink'; nextTargetPath: string | null;
    sourceEvidence: { kind: 'physical'; physicalSourceProof: string; link: OriginalPhysicalLink }
      | { kind: 'native'; inventory: NativeDocumentLinkInventory; linkId: string } }>;
};

/** Read-only single-transition assessment for Root's mixed-source coordinator.
 * Every source participates in one namespace/alias lookup. An affected physical
 * span must be imported and freshly rebound before any native mutation. */
export function previewStagedWorkspaceLinkEffects(stage: WorkspaceSourceAuthorityStage, request: {
  kind: 'rename' | 'move' | 'delete'; sourcePath: string; destinationPath?: string;
}): StagedWorkspaceLinkEffectPreview {
  const gaps = structuredClone(stage.coverage.gaps); const effects: StagedWorkspaceLinkEffectPreview['effects'] = [];
  if (stage.scope.kind !== 'visible-workspace') {
    gaps.push({ code: 'read-only-source-scope', path: '' });
    return { previewVersion: 1, stageProof: stage.stageProof, executionReady: false, readiness: 'blocked',
      coverage: { complete: false, gaps }, effects };
  }
  for (const source of stage.sources) if (source.kind === 'native' ? source.inventory.parserVersion !== 2
    : source.inventory.parserVersion !== undefined && source.inventory.parserVersion !== 2 && source.inventory.parserVersion !== 3) gaps.push({ code: 'stale-source-parser',
    path: source.kind === 'physical' ? source.inventory.path : source.inventory.document.path });
  if (workspaceSourceAuthorityStageProof(stage) !== stage.stageProof) gaps.push({ code: 'stage-proof-mismatch', path: '' });
  if (!isCanonicalAdmissionPath(request.sourcePath) || request.kind !== 'delete' && !isCanonicalAdmissionPath(request.destinationPath)) gaps.push({ code: 'invalid-path', path: request.sourcePath });
  for (const source of stage.sources) if (source.kind === 'physical' && (originalPhysicalSourceProof(source.inventory) !== source.inventory.physicalSourceProof
    || originalPhysicalByteHash(source.inventory.originalBytes) !== source.inventory.physical.byteHash
    || source.inventory.originalBytes.length !== source.inventory.physical.byteLength)) gaps.push({ code: 'physical-proof-mismatch', path: source.inventory.path });
  if (gaps.some((gap) => ['stage-proof-mismatch', 'physical-proof-mismatch', 'invalid-path'].includes(gap.code))) {
    return { previewVersion: 1, stageProof: stage.stageProof, executionReady: false, readiness: 'blocked', coverage: { complete: false, gaps }, effects };
  }
  const selected = stage.namespace.filter((entry) => entry.path === request.sourcePath || entry.path.startsWith(`${request.sourcePath}/`));
  if (!selected.some((entry) => entry.path === request.sourcePath)) gaps.push({ code: 'missing-source', path: request.sourcePath });
  const selectedPaths = new Set(selected.map((entry) => entry.path));
  const mappedPath = (filePath: string) => selectedPaths.has(filePath) ? `${request.destinationPath}${filePath.slice(request.sourcePath.length)}` : filePath;
  if (request.kind !== 'delete') {
    if (request.sourcePath === request.destinationPath) gaps.push({ code: 'unchanged-source-path', path: request.sourcePath });
    if (request.destinationPath!.startsWith(`${request.sourcePath}/`)) gaps.push({ code: 'destination-inside-source', path: request.sourcePath });
    for (const entry of selected) {
      const destination = mappedPath(entry.path);
      if (stage.namespace.some((other) => other.path === destination && !selectedPaths.has(other.path))) gaps.push({ code: 'destination-collision', path: destination });
      if (stage.namespace.some((other) => other.kind === 'file' && !selectedPaths.has(other.path) && destination.startsWith(`${other.path}/`))) gaps.push({ code: 'destination-parent-is-file', path: destination });
    }
  }
  const paths = new Set(stage.namespace.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
  const aliases = stage.sources.map((source) => ({ path: source.kind === 'physical' ? source.inventory.path : source.inventory.document.path,
    aliases: source.inventory.metadata.aliases, type: 'file' as const,
    extension: (source.kind === 'physical' ? source.inventory.path : source.inventory.document.path).split('.').at(-1) }));
  const nativeTargetPaths = new Set(stage.sources.flatMap(source => source.kind === 'native' ? [source.inventory.document.path] : []));
  // These are semantic proposed paths only, never new native snapshots or IDs.
  const virtualFiles = stage.namespace.filter((entry) => entry.kind === 'file' && !(request.kind === 'delete' && selectedPaths.has(entry.path)))
    .map((entry) => ({ originPath: entry.path, path: request.kind === 'delete' ? entry.path : mappedPath(entry.path) }));
  const virtualPaths = new Set(virtualFiles.map((entry) => entry.path)); const originByVirtualPath = new Map(virtualFiles.map((entry) => [entry.path, entry.originPath]));
  const virtualAliases = aliases.filter((entry) => !(request.kind === 'delete' && selectedPaths.has(entry.path)))
    .map((entry) => ({ ...entry, path: request.kind === 'delete' ? entry.path : mappedPath(entry.path) }));
  const virtualNativeTargetPaths = new Set([...nativeTargetPaths].filter(filePath => !(request.kind === 'delete' && selectedPaths.has(filePath)))
    .map(filePath => request.kind === 'delete' ? filePath : mappedPath(filePath)));
  for (const source of stage.sources) {
    const sourcePath = source.kind === 'physical' ? source.inventory.path : source.inventory.document.path;
    const selectedSource = sourcePath === request.sourcePath || sourcePath.startsWith(`${request.sourcePath}/`);
    if (request.kind === 'delete' && selectedSource) continue;
    const sourcePathAfter = selectedSource && request.kind !== 'delete'
      ? `${request.destinationPath}${sourcePath.slice(request.sourcePath.length)}` : sourcePath;
    const links = source.kind === 'physical' ? source.inventory.links.map((link) => ({ link,
      sourceEvidence: { kind: 'physical' as const, physicalSourceProof: source.inventory.physicalSourceProof, link } }))
      : source.inventory.links.map((link) => ({ link, sourceEvidence: { kind: 'native' as const, inventory: source.inventory, linkId: link.id } }));
    for (const { link, sourceEvidence } of links) {
      const literal = 'targetLiteral' in link ? link.targetLiteral : link.literal;
      if ('classification' in link && link.classification !== 'local') continue;
      const resolution = link.kind === 'wiki'
        ? resolveWorkspaceWikiFileLink({ targetLiteral: literal, targetPathText: link.targetPathText }, sourcePath, paths, aliases, { nativeTargetPaths })
        : resolveExactWorkspaceLink(link.targetPathText, sourcePath, paths);
      if (resolution.status !== 'resolved' || !resolution.path) {
        if (selectedSource || resolution.candidates.some((candidate) => selected.some((entry) => entry.path === candidate))) gaps.push({ code: 'affected-unresolved-link', path: sourcePath });
        const after = link.kind === 'wiki'
          ? resolveWorkspaceWikiFileLink({ targetLiteral: literal, targetPathText: link.targetPathText }, sourcePathAfter, virtualPaths, virtualAliases, { nativeTargetPaths: virtualNativeTargetPaths })
          : resolveExactWorkspaceLink(link.targetPathText, sourcePathAfter, virtualPaths);
        if (resolution.status !== after.status || nativeLinkJsonProof(resolution.candidates.slice().sort()) !== nativeLinkJsonProof(after.candidates.map((candidate) => originByVirtualPath.get(candidate)).sort())) gaps.push({ code: 'resolution-changed', path: sourcePath });
        continue;
      }
      const selectedTarget = selected.some((entry) => entry.path === resolution.path);
      if (!selectedSource && !selectedTarget) {
        const after = link.kind === 'wiki'
          ? resolveWorkspaceWikiFileLink({ targetLiteral: literal, targetPathText: link.targetPathText }, sourcePathAfter, virtualPaths, virtualAliases, { nativeTargetPaths: virtualNativeTargetPaths })
          : resolveExactWorkspaceLink(link.targetPathText, sourcePathAfter, virtualPaths);
        if (after.status !== resolution.status || nativeLinkJsonProof(resolution.candidates.slice().sort()) !== nativeLinkJsonProof(after.candidates.map((candidate) => originByVirtualPath.get(candidate)).sort())) gaps.push({ code: 'resolution-changed', path: sourcePath });
        continue;
      }
      const action = request.kind === 'delete' ? 'unlink' : 'rewrite';
      if (action === 'unlink' && link.syntax.startsWith('reference-')) gaps.push({ code: 'unsupported-reference-unlink', path: sourcePath });
      effects.push({ sourcePath, sourcePathAfter, targetPath: resolution.path, action,
        nextTargetPath: action === 'unlink' ? null : selectedTarget ? `${request.destinationPath}${resolution.path.slice(request.sourcePath.length)}` : resolution.path,
        sourceEvidence });
    }
  }
  return { previewVersion: 1, stageProof: stage.stageProof, executionReady: false,
    readiness: gaps.length ? 'blocked' : stage.readiness, coverage: { complete: !gaps.length, gaps }, effects };
}
