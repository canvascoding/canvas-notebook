import { createHash } from 'node:crypto';
import { getSchema, type JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';

import { validateAgentBlockDocument } from '../../app/lib/collaboration/agent-block-structure';
import {
  createRichMarkdownYDoc,
  richMarkdownFromYDoc,
  richMarkdownSchemaExtensions,
  validateRichMarkdownYDoc,
  type RichMarkdownValidation,
} from '../../app/lib/collaboration/markdown-state';
import { BLOCK_TREE_KEY } from '../../app/lib/collaboration/block-tree';
import { readRichDocumentJson } from '../../app/lib/collaboration/rich-document';
import { equivalentRichDocument } from '../../app/lib/markdown/core/equivalence';

export const MAX_PRIVATE_YJS_SNAPSHOT_BYTES = 64 * 1024 * 1024;

type TextCounts = { utf16Units: number; tabs: number; carriageReturns: number; lineFeeds: number };
type ProjectionCode = RichMarkdownValidation['code'];

export type RichMarkdownProjectionDiagnosis = {
  version: 1;
  snapshot: { byteLength: number; sha256: string };
  decode: 'valid' | 'invalid' | 'size_limit';
  representation: 'tiptap_blocks' | 'tiptap_xml' | 'unsupported' | null;
  completeUpdate: boolean | null;
  schema: 'valid' | 'invalid' | 'not_checked';
  blockAdmission: 'valid' | 'schema_invalid' | 'limit_exceeded' | null;
  projection: 'available' | ProjectionCode | 'not_checked';
  serialization: 'ok' | 'failed' | 'not_checked';
  markdownFixedPoint: boolean | null;
  nativeEquivalent: boolean | null;
  nativeText: TextCounts | null;
  reparsedText: TextCounts | null;
  evidenceUnchanged: { inputBytes: boolean; hydratedState: boolean; stateVector: boolean } | null;
};

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function countNativeText(node: JSONContent): TextCounts {
  const result: TextCounts = { utf16Units: 0, tabs: 0, carriageReturns: 0, lineFeeds: 0 };
  const visit = (current: JSONContent) => {
    if (current.type === 'text') {
      const text = current.text ?? '';
      result.utf16Units += text.length;
      for (const character of text) {
        if (character === '\t') result.tabs++;
        else if (character === '\r') result.carriageReturns++;
        else if (character === '\n') result.lineFeeds++;
      }
    }
    for (const child of current.content ?? []) visit(child);
  };
  visit(node);
  return result;
}

/** Offline diagnosis only: never emits document text, IDs, metadata, or paths. */
export function diagnoseRichMarkdownSnapshot(snapshot: Uint8Array): RichMarkdownProjectionDiagnosis {
  const inputHash = sha256(snapshot);
  const result: RichMarkdownProjectionDiagnosis = {
    version: 1,
    snapshot: { byteLength: snapshot.byteLength, sha256: inputHash },
    decode: 'valid', representation: null, completeUpdate: null,
    schema: 'not_checked', blockAdmission: null, projection: 'not_checked',
    serialization: 'not_checked', markdownFixedPoint: null, nativeEquivalent: null,
    nativeText: null, reparsedText: null, evidenceUnchanged: null,
  };
  if (snapshot.byteLength > MAX_PRIVATE_YJS_SNAPSHOT_BYTES) {
    result.decode = 'size_limit';
    return result;
  }
  const doc = new Y.Doc({ gc: false });
  let roundtrip: Y.Doc | null = null;
  try {
    try {
      const decoder = decoding.createDecoder(snapshot);
      Y.readUpdate(decoder, doc);
      if (decoding.hasContent(decoder)) { result.decode = 'invalid'; return result; }
    }
    catch { result.decode = 'invalid'; return result; }
    const beforeState = sha256(Y.encodeStateAsUpdate(doc));
    const beforeVector = sha256(Y.encodeStateVector(doc));
    try {
      const blocks = doc.share.has(BLOCK_TREE_KEY);
      const xml = doc.share.has('body');
      result.representation = blocks === xml ? 'unsupported' : blocks ? 'tiptap_blocks' : 'tiptap_xml';
      result.completeUpdate = !doc.store.pendingStructs && !doc.store.pendingDs;
      if (result.representation === 'unsupported' || !result.completeUpdate) return result;
      if (blocks) result.blockAdmission = validateAgentBlockDocument(doc) ?? 'valid';
      let json: JSONContent;
      try {
        json = readRichDocumentJson(doc);
        const document = getSchema(richMarkdownSchemaExtensions()).nodeFromJSON(json);
        if (document.content.size > 0) document.check();
        result.schema = 'valid';
        result.nativeText = countNativeText(json);
      } catch { result.schema = 'invalid'; result.projection = 'schema_invalid'; return result; }
      const validation = validateRichMarkdownYDoc(doc);
      result.projection = validation.valid ? 'available' : validation.code ?? 'serialization_failed';
      let markdown: string;
      try { markdown = richMarkdownFromYDoc(doc); result.serialization = 'ok'; }
      catch { result.serialization = 'failed'; return result; }
      try {
        roundtrip = createRichMarkdownYDoc(markdown);
        const reparsed = readRichDocumentJson(roundtrip);
        result.markdownFixedPoint = richMarkdownFromYDoc(roundtrip) === markdown;
        result.nativeEquivalent = equivalentRichDocument(json, reparsed);
        result.reparsedText = countNativeText(reparsed);
      } catch { result.markdownFixedPoint = false; }
      return result;
    } finally {
      result.evidenceUnchanged = {
        inputBytes: sha256(snapshot) === inputHash,
        hydratedState: sha256(Y.encodeStateAsUpdate(doc)) === beforeState,
        stateVector: sha256(Y.encodeStateVector(doc)) === beforeVector,
      };
    }
  } finally { roundtrip?.destroy(); doc.destroy(); }
}
