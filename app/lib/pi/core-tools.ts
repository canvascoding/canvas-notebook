import { execFile } from 'child_process';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type { AgentEditFileInput } from '@/app/lib/pi/agent-file-operations';
import { agentEditFileParameters } from '@/app/lib/pi/agent-file-tool-schemas';
import { AgentShellSandboxError } from '@/app/lib/pi/agent-shell-sandbox';
import { ensureAgentRuntimeTempDir } from '@/app/lib/pi/agent-runtime-temp';
import {
  buildAgentBashEnvironment,
  executeAgentBashCommand,
  resolveAgentBashWorkingDirectory,
  resolveAgentBashSandboxMode,
  type AgentBashWorkingDirectory,
} from '@/app/lib/pi/agent-bash-runtime';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { readTextWindow } from '@/app/lib/pi/text-read-window';
import { formatTextReadResult } from '@/app/lib/pi/text-read-result';
import { TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS, TOOL_OUTPUT_READ_DEFAULT_CHARACTERS, TOOL_OUTPUT_READ_MAX_CHARACTERS } from '@/app/lib/pi/tool-output-policy';
import { createMcpProxyTool } from '@/app/lib/mcp/proxy-tool';
import { createBrowserGatewayTool } from '@/app/lib/pi/browser/tool';
import { createTranscribeAudioTool, createStudioListPresetsTool } from '@/app/lib/pi/studio-tools';
import { createWebSearchTool, createWebFetchTool, createRipgrepTool } from '@/app/lib/pi/web-tools';
import { createInspectDocumentRelationsTool } from '@/app/lib/pi/document-relations-tool';
import { createPdfTools } from '@/app/lib/pi/pdf-tools';
import { createOfficeDocumentTools } from '@/app/lib/pi/office-document-tools';
import {
  applyAgentFilePatch,
  asCommandExecutionError,
  assertAgentPathAllowed,
  assertBashCommandAllowed,
  BlockedBashCommandError,
  bufferLooksBinary,
  clampPositiveInteger,
  clampReadTextLimit,
  copyAgentPaths,
  DEFAULT_PDF_IMAGE_LIMIT,
  DEFAULT_PDF_TEXT_PAGE_LIMIT,
  DEFAULT_READ_TEXT_LIMIT,
  deleteAgentPaths,
  editAgentFile,
  editAgentExcalidrawScene,
  extractPdfTextForRead,
  formatImageReadText,
  getAgentWorkspaceRoot,
  getErrorMessage,
  getReadImagePreviewDetails,
  imageContentForBuffer,
  isAbortError,
  isPdfBuffer,
  isPdfPath,
  listAgentFileSnapshots,
  moveAgentPaths,
  readAgentCollaborativeTextFile,
  readAgentCollaborativeExcalidrawFile,
  resolveAgentPath,
  resolveReadToolPath,
  restoreAgentFileSnapshot,
  recordBashToolAudit,
  sha256Buffer,
  throwIfAborted,
  writeAgentTextFile,
  MAX_PDF_IMAGE_LIMIT,
  MAX_PDF_TEXT_PAGE_LIMIT,
  MAX_READ_TEXT_LIMIT,
  PDF_AUTO_IMAGE_MAX_BYTES,
  PDF_AUTO_IMAGE_MAX_PAGES,
  PDF_MAX_IN_MEMORY_BYTES,
} from '@/app/lib/pi/tool-runtime-helpers';
import {
  formatFileChangeResult,
  formatFileChangeResults,
  formatPathOperationResult,
  readPathList,
} from '@/app/lib/pi/tool-file-formatters';
import {
  asAgentFileToolError,
  asAgentFileToolSuccess,
} from '@/app/lib/pi/agent-file-tool-results';

function formatAgentStructureReadResult(
  snapshot: NonNullable<Awaited<ReturnType<typeof readAgentCollaborativeTextFile>>>,
  maxChars: number,
) {
  if (!snapshot.structure) throw new Error('Structured reads require an active block collaboration document.');
  const { offset, totalBlocks } = snapshot.structure;
  const metadata = {
    document: { documentId: snapshot.documentId, lifecycleGeneration: snapshot.lifecycleGeneration, schemaVersion: snapshot.schemaVersion },
    representation: snapshot.representation,
    structure: { blocks: [] as typeof snapshot.structure.blocks, offset, nextOffset: snapshot.structure.nextOffset, totalBlocks },
  };
  const serialize = (blocks: typeof snapshot.structure.blocks) => JSON.stringify({ ...metadata,
    structure: { ...metadata.structure, blocks, nextOffset: offset + blocks.length < totalBlocks ? offset + blocks.length : null } });
  let text = serialize([]);
  if (!snapshot.structure.blocks.length && text.length > maxChars) {
    throw new Error(`Structure metadata requires maxChars of at least ${text.length}. Increase maxChars and retry.`);
  }
  for (const block of snapshot.structure.blocks) {
    const next = [...metadata.structure.blocks, block];
    const complete = serialize(next);
    if (complete.length <= maxChars) {
      metadata.structure.blocks.push(block);
      text = complete;
      continue;
    }
    if (metadata.structure.blocks.length) break;
    const shortened = { ...block, text: '', textTruncated: true };
    const minimum = serialize([shortened]);
    if (minimum.length > maxChars) {
      throw new Error(`The first block's IDs, hashes and attributes require maxChars of at least ${minimum.length}. Increase maxChars and retry.`);
    }
    let low = 0;
    let high = block.text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = { ...shortened, text: readTextWindow(block.text, 0, middle).text };
      if (serialize([candidate]).length <= maxChars) low = middle;
      else high = middle - 1;
    }
    shortened.text = readTextWindow(block.text, 0, low).text;
    metadata.structure.blocks.push(shortened);
    text = serialize(metadata.structure.blocks);
    break;
  }
  metadata.structure.nextOffset = offset + metadata.structure.blocks.length < totalBlocks
    ? offset + metadata.structure.blocks.length : null;
  return { text, metadata };
}

export const piTools: AgentTool[] = [
  createMcpProxyTool(),
  createWebSearchTool(),
  createWebFetchTool(),
  createBrowserGatewayTool(),
  createRipgrepTool(),
  createTranscribeAudioTool(),
  createInspectDocumentRelationsTool(),
  ...createPdfTools(),
  ...createOfficeDocumentTools(),
  {
    name: 'ls',
    label: 'Listing directory',
    description: 'Lists files and directories in the active workspace. Prefer workspace-relative paths.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'The path to list. Workspace-relative. Defaults to the active workspace root.' })),
    }),
    execute: async (toolCallId, params) => {
      try {
        const { path: dirPath } = params as { path?: string };
        const effectiveDir = dirPath || '.';
        const fullPath = resolveAgentPath(effectiveDir);
        await assertAgentPathAllowed(fullPath);
        const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
        const files = await Promise.all(
          entries.map(async (entry) => {
            // Keep dynamic directory listings out of Turbopack's file tracing. `readdir`
            // guarantees that entry names are a single path segment.
            const entryFullPath = `${fullPath}${fullPath.endsWith(path.sep) ? '' : path.sep}${entry.name}`;
            const stats = await fsPromises.stat(entryFullPath);
            return {
              name: entry.name,
              path: effectiveDir === '.'
                ? entry.name
                : `${effectiveDir}${effectiveDir.endsWith(path.sep) ? '' : path.sep}${entry.name}`,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              modified: Math.floor(stats.mtimeMs / 1000),
            };
          })
        );
        const content = files.map(f => `${f.type === 'directory' ? '[DIR] ' : ''}${f.path}`).join('\n');
        return {
          content: [{ type: 'text', text: content || '(empty)' }],
          details: { files },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'read',
    label: 'Reading file',
    description: 'Reads the content of a file. For active Markdown/text or Excalidraw live-collaboration documents, returns the current authoritative collaboration state instead of a potentially older file checkpoint. Set includeStructure for a block collaboration document to read bounded JSON metadata with document identity, stable block IDs, hierarchy, attributes, text and local hashes required by structured edit_file operations. This mode returns structure metadata instead of Markdown; continue with structure.nextOffset. Excalidraw reads include sceneSequence and per-element version/versionNonce values required by edit_excalidraw_scene. After reading Markdown, use inspect_document_relations when direct links, backlinks, unresolved targets, or nearby notes would improve the task. Prefer workspace-relative paths. Trusted absolute Studio or upload paths returned by tools are validated server-side. For PDFs, extracts text and can include limited rendered page images for vision-capable models.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path, workspace-relative path, or tool-output:// reference returned by a tool.' }),
      offset: Type.Optional(Type.Number({ minimum: 0, description: 'For text, zero-based UTF-16 character offset. Continue with nextOffset returned by the previous read; SHA-256 always covers the complete text.' })),
      maxChars: Type.Optional(Type.Number({ description: `Maximum text characters to return. Default ${DEFAULT_READ_TEXT_LIMIT}, max ${MAX_READ_TEXT_LIMIT}. Stored tool outputs use ${TOOL_OUTPUT_READ_DEFAULT_CHARACTERS}/${TOOL_OUTPUT_READ_MAX_CHARACTERS}, reserving space for pagination metadata.` })),
      includeStructure: Type.Optional(Type.Boolean({ description: 'Return JSON structure metadata for a live block document instead of Markdown. Required before structured edits; cannot be combined with text offset.' })),
      structureOffset: Type.Optional(Type.Integer({ minimum: 0, description: 'Zero-based block offset for includeStructure. Continue with structure.nextOffset from the previous read.' })),
      structureLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Maximum blocks for includeStructure. Default 25, maximum 100. maxChars and the tool output budget may reduce the page further; block text is at most 2000 characters and may be shortened with textTruncated.' })),
      maxPdfTextPages: Type.Optional(Type.Number({ description: `For PDFs, maximum pages to parse for text when pdfTextPages is not provided. Default ${DEFAULT_PDF_TEXT_PAGE_LIMIT}, max ${MAX_PDF_TEXT_PAGE_LIMIT}.` })),
      pdfTextPages: Type.Optional(Type.Array(Type.Number(), { description: 'For PDFs, specific 1-based page numbers to parse for text. Use for large PDFs or targeted rereads.' })),
      includePdfImages: Type.Optional(Type.Boolean({ description: `For PDFs, include rendered page screenshots as image content for vision-capable models. Defaults to auto for PDFs up to ${PDF_AUTO_IMAGE_MAX_PAGES} pages and ${PDF_AUTO_IMAGE_MAX_BYTES} bytes.` })),
      pdfImagePages: Type.Optional(Type.Array(Type.Number(), { description: 'For PDFs, specific 1-based page numbers to render as images. Use with includePdfImages for targeted visual inspection.' })),
      maxPdfImages: Type.Optional(Type.Number({ description: `For PDFs, maximum rendered page images to include. Default ${DEFAULT_PDF_IMAGE_LIMIT}, max ${MAX_PDF_IMAGE_LIMIT}.` })),
    }),
    execute: async (toolCallId, params, signal) => {
      const {
        path: filePath,
        offset,
        maxChars,
        includeStructure,
        structureOffset,
        structureLimit,
        maxPdfTextPages,
        pdfTextPages,
        includePdfImages,
        pdfImagePages,
        maxPdfImages,
      } = params as {
        path: string;
        offset?: number;
        maxChars?: number;
        includeStructure?: boolean;
        structureOffset?: number;
        structureLimit?: number;
        maxPdfTextPages?: number;
        pdfTextPages?: number[];
        includePdfImages?: boolean;
        pdfImagePages?: number[];
        maxPdfImages?: number;
      };
      try {
        if (includeStructure && offset !== undefined) throw new Error('includeStructure cannot be combined with text offset. Use structureOffset instead.');
        if (!includeStructure && (structureOffset !== undefined || structureLimit !== undefined)) {
          throw new Error('structureOffset and structureLimit require includeStructure: true.');
        }
        const resolvedPath = await resolveReadToolPath(filePath);
        const fullPath = resolvedPath.fullPath;
        await assertAgentPathAllowed(fullPath);
        throwIfAborted(signal);
        const isStoredOutput = resolvedPath.source === 'tool-output';
        const readTextLimit = isStoredOutput
          ? clampPositiveInteger(maxChars, TOOL_OUTPUT_READ_DEFAULT_CHARACTERS - 400, TOOL_OUTPUT_READ_MAX_CHARACTERS - 400)
          : clampReadTextLimit(maxChars);
        const stats = await fsPromises.stat(fullPath);
        if (isPdfPath(fullPath) && stats.size > PDF_MAX_IN_MEMORY_BYTES) {
          return {
            content: [{
              type: 'text',
              text: `Error: PDF is too large for the read tool's in-memory parser (${stats.size} bytes, limit ${PDF_MAX_IN_MEMORY_BYTES}). Use a targeted PDF workflow, split the PDF, or inspect selected pages with an external PDF utility.`,
            }],
            details: { filePath, size: stats.size, type: 'pdf', error: 'pdf_too_large' },
          };
        }
        const collaborativeScene = !isStoredOutput && /\.excalidraw$/iu.test(fullPath)
          ? await readAgentCollaborativeExcalidrawFile(fullPath) : null;
        const collaborative = !isStoredOutput && !collaborativeScene && /\.(?:md|markdown|txt)$/iu.test(fullPath)
          ? await readAgentCollaborativeTextFile(fullPath, undefined, { includeStructure, structureOffset, structureLimit }) : null;
        if (includeStructure) {
          if (!collaborative) throw new Error('Structured reads require an active block collaboration document.');
          const details = {
            filePath, type: 'collaboration_structure', sha256: collaborative.sha256,
            collaboration: { documentId: collaborative.documentId, lifecycleGeneration: collaborative.lifecycleGeneration,
              schemaVersion: collaborative.schemaVersion, representation: collaborative.representation,
              documentSequence: collaborative.documentSequence, checkpointSequence: collaborative.checkpointSequence,
              stateVector: collaborative.stateVector, source: 'live_yjs' },
          };
          // Keep both JSON content and details below the existing generic output
          // threshold, which would otherwise replace this page with an excerpt.
          const structureBudget = Math.min(readTextLimit, TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS - JSON.stringify(details).length);
          const formatted = formatAgentStructureReadResult(collaborative, structureBudget);
          return {
            content: [{ type: 'text', text: formatted.text }],
            details: { ...details, ...formatted.metadata },
          };
        }
        const liveContent = collaborativeScene?.content ?? collaborative?.content;
        const buffer = liveContent === undefined
          ? await fsPromises.readFile(fullPath) : Buffer.from(liveContent, 'utf8');
        const sha256 = sha256Buffer(buffer);
        const image = liveContent === undefined ? await imageContentForBuffer(fullPath, buffer) : null;
        if (image) {
          return {
            content: [
              {
                type: 'text',
                text: formatImageReadText({
                  requestedPath: filePath,
                  displayPath: resolvedPath.displayPath,
                  mimeType: image.mimeType,
                  size: buffer.length,
                }) + `\nSHA-256: ${sha256}`,
              },
              image,
            ],
            details: {
              filePath: resolvedPath.displayPath,
              requestedPath: filePath,
              resolvedPath: fullPath,
              size: buffer.length,
              sha256,
              type: 'image',
              mimeType: image.mimeType,
              source: resolvedPath.source,
              ...getReadImagePreviewDetails(resolvedPath.displayPath),
            },
          };
        }
        if (liveContent === undefined && isPdfBuffer(filePath, buffer)) {
          if (offset !== undefined) throw new Error('offset applies to text files; use pdfTextPages for PDFs.');
          const pdfResult = await extractPdfTextForRead(filePath, buffer, {
            maxChars: readTextLimit,
            maxTextPages: clampPositiveInteger(maxPdfTextPages, DEFAULT_PDF_TEXT_PAGE_LIMIT, MAX_PDF_TEXT_PAGE_LIMIT),
            textPages: pdfTextPages,
            includeImages: includePdfImages,
            includeImagesExplicit: typeof includePdfImages === 'boolean',
            imagePages: pdfImagePages,
            maxImages: clampPositiveInteger(maxPdfImages, DEFAULT_PDF_IMAGE_LIMIT, MAX_PDF_IMAGE_LIMIT),
          }, signal);
          return {
            ...pdfResult,
            details: {
              ...pdfResult.details,
              requestedPath: filePath,
              resolvedPath: fullPath,
              sha256,
              source: resolvedPath.source,
            },
          };
        }
        if (liveContent === undefined && bufferLooksBinary(buffer)) {
          return {
            content: [{ type: 'text', text: 'Error: Unsupported binary file. The read tool can return text files, images, and PDFs with extractable text.' }],
            details: { filePath, size: buffer.length, type: 'binary' },
          };
        }
        const text = collaborativeScene?.content ?? collaborative?.content ?? buffer.toString('utf8');
        const textSha256 = collaborativeScene
          ? sha256Buffer(Buffer.from(collaborativeScene.content, 'utf8'))
          : collaborative?.sha256 ?? sha256;
        const window = readTextWindow(text, offset, Math.max(2, readTextLimit));
        const formatted = formatTextReadResult(window.text, window, textSha256,
          collaborativeScene ? '\nSource: live Excalidraw collaboration scene' : collaborative ? '\nSource: live Yjs collaboration state' : '');
        return {
          content: [{
            type: 'text',
            text: formatted.text,
          }],
          details: {
            filePath,
            size: Buffer.byteLength(text, 'utf8'),
            sha256: textSha256,
            type: 'text',
            textLength: text.length,
            truncated: window.truncated,
            offset: window.offset,
            nextOffset: window.nextOffset,
            eof: window.eof,
            totalChars: window.totalChars,
            toolOutputReadWindow: formatted.layout,
            ...(isStoredOutput ? { toolOutputRead: true, reference: filePath } : {}),
            collaboration: collaborativeScene
              ? {
                  documentId: collaborativeScene.documentId,
                  representation: 'excalidraw_scene',
                  sceneSequence: collaborativeScene.sceneSequence,
                  lifecycleGeneration: collaborativeScene.lifecycleGeneration,
                  canonicalHash: collaborativeScene.canonicalHash,
                  source: 'live_excalidraw',
                }
              : collaborative
              ? {
                  documentId: collaborative.documentId,
                  representation: collaborative.representation,
                  lifecycleGeneration: collaborative.lifecycleGeneration,
                  schemaVersion: collaborative.schemaVersion,
                  documentSequence: collaborative.documentSequence,
                  checkpointSequence: collaborative.checkpointSequence,
                  stateVector: collaborative.stateVector,
                  source: 'live_yjs',
                }
              : undefined,
          },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'write',
    label: 'Writing file',
    description: 'Writes text content to a file. Creates an undo snapshot, returns a diff, validates supported file types, and verifies the file after writing. Use for new files or an intentional full rewrite; use edit_file or apply_patch for existing-file edits when possible. Existing shared workspace files require expectedSha256 from a current read. A revision conflict requires a new read and is never auto-retried.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path or workspace-relative path.' }),
      content: Type.String({ description: 'The content to write.' }),
      expectedSha256: Type.Optional(Type.String({ description: 'Optional SHA-256 hash that must match the current file before writing.' })),
    }),
    execute: async (toolCallId, params) => {
      const { path: filePath, content, expectedSha256 } = params as { path: string; content: string; expectedSha256?: string };
      try {
        const result = await writeAgentTextFile({
          path: filePath,
          content,
          expectedSha256,
          operation: 'write',
        });
        return {
          content: [{ type: 'text', text: formatFileChangeResult(result) }],
          details: asAgentFileToolSuccess(result, 'write'),
        };
      } catch (error: unknown) {
        const details = asAgentFileToolError(error, 'write', filePath);
        return {
          content: [{ type: 'text', text: `Error: ${details.message}\nRecommended action: ${details.recommendedAction}.` }],
          details,
          isError: true,
        };
      }
    },
  },
  {
    name: 'edit_file',
    label: 'Editing file safely',
    description: 'Safely edits an existing file with either an exact oldText -> newText replacement or 1–32 structured operations. Read with includeStructure first for a live block document, then copy document and use stable IDs/local hashes to move, delete, insert, format or edit tables. For a text replacement inside one stable block, include blockId and document with oldText/newText. These operations act on the live Yjs document and allow unrelated user changes; expectedSha256 is optional as an extra whole-document guard. Ordinary exact edits of shared files require expectedSha256. For global text replacements set replaceAll, or specify expectedOccurrences; for several known ordinary replacements use apply_patch. Stable paragraph and supported block operations apply live, while structural or ambiguous Markdown replacements can create a persisted review with Accept/Reject actions in the editor. Results report applied or review required; never assume a review was applied. On uncertainty or conflict, read again. Use this instead of sed, perl -pi, tee, or shell redirects.',
    parameters: agentEditFileParameters,
    execute: async (toolCallId, params) => {
      const { path: filePath } = params as { path: string };
      try {
        if (!Value.Check(agentEditFileParameters, params)) {
          throw new Error('Supply either an exact oldText/newText edit or 1–32 structured operations with document from a current structure read. Include document when targeting blockId, and only the supported operation fields.');
        }
        const result = await editAgentFile({
          ...(params as AgentEditFileInput),
          idempotencyKey: toolCallId,
        });
        return {
          content: [{ type: 'text', text: formatFileChangeResult(result) }],
          details: asAgentFileToolSuccess(result, 'edit_file'),
        };
      } catch (error: unknown) {
        const details = asAgentFileToolError(error, 'edit_file', filePath);
        return {
          content: [{ type: 'text', text: `Error: ${details.message}\nRecommended action: ${details.recommendedAction}.` }],
          details,
          isError: true,
        };
      }
    },
  },
  {
    name: 'apply_patch',
    label: 'Applying safe patch',
    description: 'Safely applies multiple already-known exact text replacements across one or more existing files using files[].edits[]. Put all replacements for one path in that entry; each canonical path may appear once. All replacements are preflighted before any write, then revalidated at commit. Active live-collaboration documents use live Yjs transactions or persisted structural review operations instead of whole-file writes. Existing shared workspace files require expectedSha256 from a current read. On a conflict, read and re-plan; never auto-retry.',
    parameters: Type.Object({
      files: Type.Array(Type.Object({
        path: Type.String({ description: 'Absolute path or workspace-relative path.' }),
        expectedSha256: Type.Optional(Type.String({ description: 'Optional SHA-256 hash that must match this file before patching.' })),
        edits: Type.Array(Type.Object({
          oldText: Type.String({ description: 'Exact text to replace. Must occur exactly once by default, match expectedOccurrences, or use replaceAll.' }),
          newText: Type.String({ description: 'Replacement text.' }),
          expectedOccurrences: Type.Optional(Type.Number({ description: 'Exact number of expected oldText matches. Defaults to 1.' })),
          replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every matching non-overlapping occurrence. Cannot be combined with expectedOccurrences.' })),
        })),
      })),
    }),
    execute: async (toolCallId, params) => {
      try {
        const results = await applyAgentFilePatch({
          ...(params as { files: Parameters<typeof applyAgentFilePatch>[0]['files'] }),
          idempotencyKeyPrefix: toolCallId,
        });
        return {
          content: [{ type: 'text', text: formatFileChangeResults(results) }],
          details: {
            contractVersion: 1,
            kind: 'file_patch_batch',
            operation: 'apply_patch',
            outcome: results.some((result) => result.collaboration?.reviewRequired) ? 'review_required' : 'applied',
            category: results.some((result) => result.collaboration?.reviewRequired) ? 'review_required' : 'success',
            results: results.map((result) => asAgentFileToolSuccess(result, 'apply_patch')),
            recommendedAction: results.some((result) => result.collaboration?.reviewRequired) ? 'review_in_editor' : 'none',
            safeToAutoRetry: false,
          },
        };
      } catch (error: unknown) {
        const details = asAgentFileToolError(error, 'apply_patch');
        return {
          content: [{ type: 'text', text: `Error: ${details.message}\nRecommended action: ${details.recommendedAction}.` }],
          details,
          isError: true,
        };
      }
    },
  },
  {
    name: 'edit_excalidraw_scene',
    label: 'Editing Excalidraw scene safely',
    description: 'Creates, updates, or deletes elements in an active shared Excalidraw scene. Read the .excalidraw file immediately before calling this tool and pass its sceneSequence plus exact expectedVersion/expectedVersionNonce values for updates and deletes. Non-conflicting element changes apply live; a concurrently changed target becomes a persisted human Accept/Reject review instead of overwriting user work.',
    parameters: Type.Object({
      path: Type.String({ description: 'Workspace-relative path to the active .excalidraw file.' }),
      observedSceneSequence: Type.Number({ description: 'Authoritative sceneSequence returned by the latest read.' }),
      actions: Type.Array(Type.Union([
        Type.Object({
          type: Type.Literal('create'),
          element: Type.Record(Type.String(), Type.Unknown(), { description: 'Complete Excalidraw element JSON with a unique id.' }),
        }),
        Type.Object({
          type: Type.Literal('update'),
          elementId: Type.String(),
          expectedVersion: Type.Number(),
          expectedVersionNonce: Type.Number(),
          element: Type.Record(Type.String(), Type.Unknown(), { description: 'Complete replacement element JSON using the same id.' }),
        }),
        Type.Object({
          type: Type.Literal('delete'),
          elementId: Type.String(),
          expectedVersion: Type.Number(),
          expectedVersionNonce: Type.Number(),
        }),
      ]), { minItems: 1, maxItems: 500 }),
    }),
    execute: async (toolCallId, params) => {
      try {
        const input = params as Omit<Parameters<typeof editAgentExcalidrawScene>[0], 'idempotencyKey'>;
        const operation = await editAgentExcalidrawScene({
          ...input,
          idempotencyKey: toolCallId,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(operation, null, 2) }],
          details: operation,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'list_file_snapshots',
    label: 'Listing file snapshots',
    description: 'Lists recent undo snapshots created by agent file tools. Read-only. Use before restore_file_snapshot when the user asks to undo or inspect recent agent edits.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Optional absolute path or workspace-relative path to filter snapshots.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum snapshots to return. Default 20, max 100.' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, limit } = params as { path?: string; limit?: number };
      try {
        const snapshots = await listAgentFileSnapshots({ path: filePath, limit });
        return {
          content: [{ type: 'text', text: snapshots.length > 0 ? JSON.stringify(snapshots, null, 2) : '(no snapshots found)' }],
          details: { snapshots },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'restore_file_snapshot',
    label: 'Restoring file snapshot',
    description: 'Restores a file from an undo snapshot created by write, edit_file, apply_patch, or restore_file_snapshot. Creates a new snapshot of the current state before restoring.',
    parameters: Type.Object({
      snapshotId: Type.String({ description: 'Snapshot ID from list_file_snapshots or a previous file edit result.' }),
    }),
    execute: async (_toolCallId, params) => {
      const { snapshotId } = params as { snapshotId: string };
      try {
        const result = await restoreAgentFileSnapshot({ snapshotId });
        return {
          content: [{ type: 'text', text: formatFileChangeResult(result) }],
          details: result,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'copy_path',
    label: 'Copying file or directory',
    description: 'Copies one or more files/directories within allowed local paths. Supports directory copies without creating content snapshots, so it is suitable for bulk file operations. Prefer this over bash cp so the UI can show a clear file operation.',
    parameters: Type.Object({
      sourcePath: Type.Optional(Type.String({ description: 'Absolute path or workspace-relative source path.' })),
      sourcePaths: Type.Optional(Type.Array(Type.String({ description: 'Absolute path or workspace-relative source path.' }), { description: 'Multiple source paths. When provided, destinationPath is treated as a directory.' })),
      destinationPath: Type.String({ description: 'Absolute path or workspace-relative destination path. For multiple sources, this is the destination directory.' }),
      overwrite: Type.Optional(Type.Boolean({ description: 'Overwrite destination if it exists. Defaults to false.' })),
      recursive: Type.Optional(Type.Boolean({ description: 'Allow directory copy. Defaults to true.' })),
    }),
    execute: async (_toolCallId, params) => {
      const typedParams = params as {
        sourcePath?: string;
        sourcePaths?: string[];
        destinationPath: string;
        overwrite?: boolean;
        recursive?: boolean;
      };
      try {
        const sourcePaths = readPathList(typedParams as Record<string, unknown>, 'sourcePath', 'sourcePaths');
        const result = await copyAgentPaths({
          sourcePaths,
          destinationPath: typedParams.destinationPath,
          overwrite: typedParams.overwrite,
          recursive: typedParams.recursive ?? true,
        });
        return {
          content: [{ type: 'text', text: formatPathOperationResult(result) }],
          details: result,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'move_path',
    label: 'Moving file or directory',
    description: 'Moves, renames, or bulk-moves files/directories within allowed local paths. Does not create content snapshots. Prefer this over bash mv so the UI can show a clear file operation.',
    parameters: Type.Object({
      sourcePath: Type.Optional(Type.String({ description: 'Absolute path or workspace-relative source path.' })),
      sourcePaths: Type.Optional(Type.Array(Type.String({ description: 'Absolute path or workspace-relative source path.' }), { description: 'Multiple source paths. When provided, destinationPath is treated as a directory.' })),
      destinationPath: Type.String({ description: 'Absolute path or workspace-relative destination path. For multiple sources, this is the destination directory.' }),
      overwrite: Type.Optional(Type.Boolean({ description: 'Overwrite destination if it exists. Defaults to false.' })),
    }),
    execute: async (_toolCallId, params) => {
      const typedParams = params as {
        sourcePath?: string;
        sourcePaths?: string[];
        destinationPath: string;
        overwrite?: boolean;
      };
      try {
        const sourcePaths = readPathList(typedParams as Record<string, unknown>, 'sourcePath', 'sourcePaths');
        const result = await moveAgentPaths({
          sourcePaths,
          destinationPath: typedParams.destinationPath,
          overwrite: typedParams.overwrite,
        });
        return {
          content: [{ type: 'text', text: formatPathOperationResult(result) }],
          details: result,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'delete_path',
    label: 'Deleting file or directory',
    description: 'Deletes one or more files/directories within allowed local paths. Does not create content snapshots, so use carefully. Directories require recursive=true. Prefer this over bash rm so the UI can show a clear file operation.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Absolute path or workspace-relative path to delete.' })),
      paths: Type.Optional(Type.Array(Type.String({ description: 'Absolute path or workspace-relative path to delete.' }), { description: 'Multiple paths to delete.' })),
      recursive: Type.Optional(Type.Boolean({ description: 'Required for deleting directories.' })),
      ignoreMissing: Type.Optional(Type.Boolean({ description: 'Ignore paths that do not exist, similar to rm -f. Defaults to false.' })),
    }),
    execute: async (_toolCallId, params) => {
      const typedParams = params as { path?: string; paths?: string[]; recursive?: boolean; ignoreMissing?: boolean };
      try {
        const paths = readPathList(typedParams as Record<string, unknown>, 'path', 'paths');
        const result = await deleteAgentPaths({
          paths,
          recursive: typedParams.recursive,
          ignoreMissing: typedParams.ignoreMissing,
        });
        return {
          content: [{ type: 'text', text: formatPathOperationResult(result) }],
          details: result,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'bash',
    label: 'Executing command',
    description: 'Executes a command for inspection or code execution. Commands default to the private session temp directory; select workspace only for workspace-relative inspection. The workspace is read-only to the shell and all Python/Node subprocesses. Keep scripts, document working copies and intermediate output in CANVAS_AGENT_TEMP_DIR. Publish Word documents with checkout_docx/commit_docx; use write, edit_file, apply_patch, copy_path, move_path or delete_path for other workspace changes so permissions, revisions and audit logs are enforced.',
    parameters: Type.Object({
      command: Type.String({ description: 'The command to execute.' }),
      workingDirectory: Type.Optional(Type.Union([
        Type.Literal('temp'),
        Type.Literal('workspace'),
      ], { description: 'Execution directory. Defaults to the private session temp directory. Use workspace only for workspace-relative inspection.' })),
    }),
    execute: async (toolCallId, params, signal) => {
      const { command, workingDirectory: requestedWorkingDirectory } = params as {
        command: string;
        workingDirectory?: AgentBashWorkingDirectory;
      };
      const startedAt = Date.now();
      let workingDirectory: AgentBashWorkingDirectory | null = null;
      let cwd: string | null = null;
      let sandboxMode: 'landlock' | 'local-development' | null = null;
      try {
        throwIfAborted(signal);
        const executionContext = getAgentExecutionContext();
        workingDirectory = resolveAgentBashWorkingDirectory(
          requestedWorkingDirectory,
          Boolean(executionContext),
        );
        const workspaceDir = getAgentWorkspaceRoot();
        let tempDir: string | null = null;
        if (executionContext) {
          tempDir = await ensureAgentRuntimeTempDir(executionContext);
        }
        cwd = workingDirectory === 'temp' ? tempDir : workspaceDir;
        if (!cwd) {
          throw new Error('The private session temp directory is unavailable without an execution context.');
        }
        sandboxMode = resolveAgentBashSandboxMode(process.env);
        assertBashCommandAllowed(command, {
          workingDirectory,
          sandboxed: sandboxMode === 'landlock',
        });
        const safeEnv = buildAgentBashEnvironment({
          sourceEnv: process.env,
          workspaceDir,
          tempDir,
        });
        const execution = await executeAgentBashCommand({
          command,
          cwd,
          workspaceDir,
          tempDir,
          env: safeEnv,
          executionContext,
          signal,
        });
        const { stdout, stderr } = execution;
        sandboxMode = execution.sandboxMode;
        await recordBashToolAudit({
          command,
          status: 'success',
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          exitCode: 0,
          workingDirectory,
          cwd,
          sandboxMode,
        });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { stdout, stderr, workingDirectory, cwd, sandboxMode },
        };
      } catch (error: unknown) {
        if (isAbortError(error, signal)) {
          await recordBashToolAudit({
            command,
            status: 'error',
            durationMs: Date.now() - startedAt,
            error: 'Tool execution aborted.',
            workingDirectory,
            cwd,
            sandboxMode,
          });
          return {
            content: [{ type: 'text', text: 'Error: Tool execution aborted.' }],
            details: { error: 'Tool execution aborted.', workingDirectory, cwd, sandboxMode },
          };
        }
        const execError = asCommandExecutionError(error);
        const output = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join('\n');
        await recordBashToolAudit({
          command,
          status: error instanceof BlockedBashCommandError || error instanceof AgentShellSandboxError ? 'blocked' : 'failure',
          durationMs: Date.now() - startedAt,
          stdout: execError.stdout,
          stderr: execError.stderr,
          error: execError.message,
          exitCode: execError.code ?? null,
          workingDirectory,
          cwd,
          sandboxMode,
        });
        return {
          content: [{ type: 'text', text: output }],
          details: { error: execError.message, stdout: execError.stdout, stderr: execError.stderr, workingDirectory, cwd, sandboxMode },
        };
      }
    },
  },
  {
    name: 'grep',
    label: 'Searching files',
    description: 'Legacy text search alias. Prefer the dedicated `rg` tool for new searches.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'The regex pattern to search for.' }),
      path: Type.Optional(Type.String({ description: 'The directory or file to search in. Workspace-relative by default. Defaults to the active workspace.' })),
    }),
    execute: async (toolCallId, params, signal) => {
      const { pattern, path: searchPath } = params as { pattern: string; path?: string };
      try {
        throwIfAborted(signal);
        const targetPath = resolveAgentPath(searchPath || '.');
        await assertAgentPathAllowed(targetPath);
        // Use execFile to avoid shell injection via pattern or path
        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile('rg', ['-n', pattern, targetPath], { cwd: '/', signal }, (err, stdout, stderr) => {
            if (err && (err as NodeJS.ErrnoException & { code?: number }).code === 1) {
              resolve({ stdout: '', stderr: '' }); // no matches
            } else if (err) {
              reject(err);
            } else {
              resolve({ stdout, stderr });
            }
          });
        });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no matches found)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        if (isAbortError(error, signal)) {
          return {
            content: [{ type: 'text', text: 'Error: Tool execution aborted.' }],
            details: { error: 'Tool execution aborted.' },
          };
        }
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'glob',
    label: 'Finding files',
    description: 'Finds files by name pattern. Use this or bash+find for path-based file discovery.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'The glob pattern (e.g., "**/*.ts").' }),
      path: Type.Optional(Type.String({ description: 'The directory to search in. Workspace-relative by default. Defaults to the active workspace.' })),
    }),
    execute: async (toolCallId, params, signal) => {
      const { pattern, path: searchPath } = params as { pattern: string; path?: string };
      try {
        throwIfAborted(signal);
        const searchRoot = resolveAgentPath(searchPath || '.');
        await assertAgentPathAllowed(searchRoot);
        // Use execFile with argument array to avoid shell injection via pattern
        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile('rg', ['--files', '-g', pattern, searchRoot], { cwd: '/', signal }, (err, stdout, stderr) => {
            const errCode = (err as NodeJS.ErrnoException & { code?: number })?.code;
            if (errCode === 1) {
              resolve({ stdout: '', stderr: '' });
            } else if (err) {
              reject(err);
            } else {
              resolve({ stdout, stderr });
            }
          });
        });
        return {
          content: [{ type: 'text', text: stdout || '(no matches found)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        if (isAbortError(error, signal)) {
          return {
            content: [{ type: 'text', text: 'Error: Tool execution aborted.' }],
            details: { error: 'Tool execution aborted.' },
          };
        }
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  // Canvas Notebook Skills
  createStudioListPresetsTool(),
];

export type PiToolGroup = 'Core' | 'Studio' | 'Automation' | 'Audio' | 'Composio' | 'MCP' | 'Email' | 'Session' | 'Delegation' | 'Memory' | 'Browser' | 'Todo' | 'Web' | 'Security' | 'Skills' | 'Onboarding';
