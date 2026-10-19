import 'server-only';

import { types } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '../api/route-helpers';
import { MarkdownFileImportError } from '../collaboration/markdown-file-import';
import { persistExplicitOriginalMarkdownFileForWrite, readExplicitOriginalMarkdownImportStatusForWrite,
  type MarkdownFileImportReceipt } from '../collaboration/markdown-file-import-persistence';
import { decodeMarkdownOriginalImportSelectionV1 } from '../collaboration/markdown-original-import-contract';
import { LicenseEntitlementError } from '../license/entitlements';
import { SeatLimitGuardError } from '../license/seat-limit';
import { WorkspaceRequestPrincipalError } from '../workspaces/request-principal';

const responseHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const MAXIMUM_BODY_BYTES = 32 * 1024;

type ImportStatusSelectionV1 = Readonly<{ apiVersion: 1; workspaceId: string; operationId: string }>;
type ImportDocumentAtImportV1 = Readonly<{
  workspaceId: string; organizationId: string | null; documentId: string; lineageId: string; path: string;
  representation: MarkdownFileImportReceipt['target']['representation']; lifecycleGeneration: number;
  schemaVersion: number; documentSequence: number; stateProof: string; persistedAt: number;
}>;
export type MarkdownOriginalImportResultV1 = Readonly<{
  apiVersion: 1; operationId: string; status: 'confirmed'; outcome: 'imported' | 'already_imported';
  documentAtImport: ImportDocumentAtImportV1; source: Readonly<{ sha256: string; bytes: number }>;
  requiresFreshFileActionPreview: true;
} | { apiVersion: 1; operationId: string; status: 'not_found'; requiresFreshFileActionPreview: true }>;

function invalid(): never { throw new MarkdownFileImportError('MARKDOWN_IMPORT_INVALID_INPUT'); }

/** A status lookup selects stored facts; no serialized permission, identity or
 * receipt from the caller can become authority for the import coordinator. */
export function decodeMarkdownOriginalImportStatusV1(value: unknown): ImportStatusSelectionV1 {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(properties);
  if (keys.length !== 3 || !['apiVersion', 'workspaceId', 'operationId'].every(key =>
    properties[key]?.enumerable && Object.hasOwn(properties[key], 'value'))) return invalid();
  const apiVersion: unknown = properties.apiVersion.value;
  const workspaceId: unknown = properties.workspaceId.value;
  const operationId: unknown = properties.operationId.value;
  if (apiVersion !== 1 || typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256
    || workspaceId !== workspaceId.trim() || /[\u0000-\u001f\u007f]/u.test(workspaceId)
    || Buffer.from(workspaceId, 'utf8').toString('utf8') !== workspaceId
    || typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(operationId)) return invalid();
  return Object.freeze({ apiVersion: 1, workspaceId, operationId });
}

/** Only immutable import facts cross HTTP. The initial persisted Yjs state is
 * confirmed here; neither the current document location nor its checkpoint is. */
export function encodeMarkdownOriginalImportResultV1(operationId: string, receipt: MarkdownFileImportReceipt | null,
  outcome: 'imported' | 'already_imported' = 'already_imported'): MarkdownOriginalImportResultV1 {
  if (!receipt) return Object.freeze({ apiVersion: 1, operationId, status: 'not_found', requiresFreshFileActionPreview: true });
  const target = receipt.target;
  return Object.freeze({ apiVersion: 1, operationId, status: 'confirmed', outcome,
    documentAtImport: Object.freeze({ workspaceId: target.workspaceId, organizationId: target.organizationId,
      documentId: target.documentId, lineageId: target.lineageId, path: target.path, representation: target.representation,
      lifecycleGeneration: target.lifecycleGeneration, schemaVersion: target.schemaVersion,
      documentSequence: target.initialSequence, stateProof: target.initialStateProof, persistedAt: target.persistedAt }),
    source: Object.freeze({ sha256: receipt.sourceHash, bytes: receipt.sourceBytes }), requiresFreshFileActionPreview: true });
}

/** Retain at most 32 KiB of the incoming stream before text decoding or JSON
 * allocation. This API selects an existing file; it never accepts file bytes. */
async function readMarkdownOriginalImportJsonBody(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAXIMUM_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* The invalid body remains rejected if cancellation fails. */ }
        return invalid();
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
    catch { return invalid(); }
  } finally { reader.releaseLock(); }
}

/** Known failures expose a stable code only. No SQL, filesystem path, native
 * payload, stored principal, credential or error message is serialized. */
export function markdownOriginalImportFailureV1(error: unknown): Readonly<{
  body: Readonly<{ apiVersion: 1; success: false; code: string }>; status: number;
}> {
  let code = 'IMPORT_UNAVAILABLE', status = 503;
  if (error && typeof error === 'object' && types.isProxy(error)) {
    return Object.freeze({ body: Object.freeze({ apiVersion: 1, success: false, code }), status });
  }
  if (error instanceof MarkdownFileImportError) {
    code = error.code;
    status = error.code === 'MARKDOWN_IMPORT_INVALID_INPUT' ? 400
      : error.code === 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED' || error.code === 'MARKDOWN_IMPORT_RICH_UNAVAILABLE' ? 422
        : error.code === 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED' ? 503 : 409;
  } else if (error instanceof WorkspaceRequestPrincipalError) {
    if (error.code === 'PRINCIPAL_AUTH_REVOKED' || error.code === 'PRINCIPAL_REQUIRED') {
      code = 'IMPORT_AUTHENTICATION_REQUIRED'; status = 401;
    } else if (error.code === 'PRINCIPAL_ACCESS_DENIED') {
      code = 'IMPORT_ACCESS_DENIED'; status = 403;
    }
  } else if (error instanceof LicenseEntitlementError) {
    if (error.statusCode === 402) { code = error.code; status = 402; }
    else if (error.statusCode === 403) { code = 'IMPORT_ACCESS_DENIED'; status = 403; }
  } else if (error instanceof SeatLimitGuardError && error.status === 403) {
    code = 'IMPORT_ACCESS_DENIED'; status = 403;
  }
  return Object.freeze({ body: Object.freeze({ apiVersion: 1, success: false, code }), status });
}

/** Both routes retain the genuine current Request headers before yielding.
 * Status reads stored receipts and cannot reconcile, checkpoint or import. */
export async function handleMarkdownOriginalImportHttp(request: NextRequest, action: 'import' | 'status'): Promise<NextResponse> {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const limited = applyRateLimit(request, { limit: action === 'import' ? 60 : 120, windowMs: 60_000,
    keyPrefix: `documents-import-existing-${action}-v1` });
  if (limited) {
    for (const [name, value] of Object.entries(responseHeaders)) limited.headers.set(name, value);
    return limited;
  }
  try {
    const value = await readMarkdownOriginalImportJsonBody(request);
    let result: MarkdownOriginalImportResultV1;
    if (action === 'import') {
      const selection = decodeMarkdownOriginalImportSelectionV1(value);
      const imported = await persistExplicitOriginalMarkdownFileForWrite(original, selection);
      result = encodeMarkdownOriginalImportResultV1(selection.operationId, imported.receipt,
        imported.disposition === 'applied' ? 'imported' : 'already_imported');
    } else {
      const selection = decodeMarkdownOriginalImportStatusV1(value);
      const receipt = await readExplicitOriginalMarkdownImportStatusForWrite(original, selection);
      result = encodeMarkdownOriginalImportResultV1(selection.operationId, receipt);
    }
    return NextResponse.json(result, { headers: responseHeaders });
  } catch (error) {
    const failure = markdownOriginalImportFailureV1(error);
    return NextResponse.json(failure.body, { status: failure.status, headers: responseHeaders });
  }
}
