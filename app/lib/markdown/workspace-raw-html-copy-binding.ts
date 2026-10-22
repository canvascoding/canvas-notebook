import 'server-only';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { createHash } from 'node:crypto';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { decodeNativeCopyMarkdownBirthV1, type NativeCopyMarkdownBirthV1 } from '../collaboration/native-copy-markdown-birth-contract';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { inspectPersistedDocumentLinksV3, inspectPersistedDocumentLinksV4, nativeLinkJsonProof as proof,
  type NativeDocumentLinkInventoryV4 } from './workspace-native-link-inventory';
import { RawHtmlSourceBindingError } from './workspace-raw-html-source-binding';
import { Y } from '../collaboration/server-runtime';

/** Compact original journal commitment. History binds immutable Birth and
 * content-free Snapshot facts; fresh B1 separately inspects actual state. */
export type RawHtmlCopyNativeBindingV2 = Readonly<{ version: 2; birthProof: string; inventory4Proof: string; bindingProof: string }>;
function fail(): never { throw new RawHtmlSourceBindingError('RAW_HTML_BINDING_CHANGED'); }
export function captureRawHtmlCopyNativeBindingV2(birthInput: NativeCopyMarkdownBirthV1,
  state: PersistedCollaborationState): Readonly<{ certificate: RawHtmlCopyNativeBindingV2; inventory4: NativeDocumentLinkInventoryV4 }> {
  const birth = decodeNativeCopyMarkdownBirthV1(birthInput), target = birth.binding.receipt.target;
  const inventory3 = inspectPersistedDocumentLinksV3(state), inventory4 = inspectPersistedDocumentLinksV4(state);
  if (!equal(inventory3, birth.binding.nativeInventory) || !equal(inventory3.document, inventory4.document)
    || inventory4.parserVersion !== 4 || !inventory4.coverage.complete || inventory4.coverage.gaps.length
    || state.newlineStyle !== target.newlineStyle || state.hasBom !== target.hasBom
    || createHash('sha256').update(state.yjsState).digest('hex') !== birth.binding.nativeBinaryHash
    || createHash('sha256').update(state.stateVector).digest('hex') !== birth.binding.nativeVectorHash) fail();
  const { parserVersion: _three, ...three } = inventory3, { parserVersion: _four, ...four } = inventory4;
  if (!equal(three, four)) fail();
  const body = { version: 2 as const, birthProof: birth.birthProof, inventory4Proof: proof(inventory4) };
  return { certificate: Object.freeze({ ...body, bindingProof: proof(body) }), inventory4 };
}
/** The fixed owner/history reader compares the exact original commitment.
 * No digest authenticates a receipt or grants authority. */
export function assertRawHtmlCopyNativeBindingV2(input: unknown, expected: RawHtmlCopyNativeBindingV2): void {
  const value = captureWorkspaceOperationNativePlanData(input, fail, 4096);
  if (!equal(value, expected)) fail();
}

/** Data-only expected historical journal commitment, not a Native4 inventory
 * or authority. The fixed caller binds the immutable Parent/Birth/import
 * receipt and compares the exact original journal confirmation. Fresh B1 still
 * inspects actual state for Parser3/4 parity or Native4/HTML equality. */
export function nativeCopyMarkdownHtmlInitialCertificate(birthInput: NativeCopyMarkdownBirthV1,
  snapshotInput: Uint8Array, liveBinaryHash: unknown, liveVectorHash: unknown): RawHtmlCopyNativeBindingV2 {
  const birth = decodeNativeCopyMarkdownBirthV1(birthInput);
  if (liveBinaryHash !== birth.binding.nativeBinaryHash || liveVectorHash !== birth.binding.nativeVectorHash) fail();
  let snapshot: Buffer;
  try {
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    if (!snapshotInput || typeof snapshotInput !== 'object' || types.isProxy(snapshotInput) || !ArrayBuffer.isView(snapshotInput)
      || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(snapshotInput))
      || ['buffer','byteLength','byteOffset','constructor'].some(key => Object.hasOwn(snapshotInput,key))) fail();
    const size = Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!.call(snapshotInput) as number;
    const buffer = Object.getOwnPropertyDescriptor(typed,'buffer')!.get!.call(snapshotInput);
    if (!Number.isSafeInteger(size) || size < 1 || size > 8388608 || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) fail();
    snapshot = Buffer.alloc(size); Uint8Array.prototype.set.call(snapshot,snapshotInput);
  } catch { return fail(); }
  const encoded = birth.binding.nativeInventory.version.stateVector;
  if (typeof encoded !== 'string' || encoded.length < 1 || encoded.length > 1398104) fail();
  const vector = Buffer.from(encoded,'base64'), sha = (bytes:Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  if (vector.length < 1 || vector.length > 1048576 || vector.toString('base64') !== encoded
    || sha(vector) !== birth.binding.nativeVectorHash
    || 'yjs-snapshot-sha256-v1:'+sha(snapshot) !== birth.binding.receipt.target.initialStateProof) fail();
  try {
    // Snapshot retains only state-vector/delete-set facts. Empty imports are
    // valid; neither decoding nor history treats it as a document update.
    const decoded = Y.decodeSnapshot(snapshot);
    if (!Buffer.from(Y.encodeSnapshot(decoded)).equals(snapshot)
      || !Buffer.from(Y.encodeStateVector(decoded.sv)).equals(vector)) fail();
  } catch { return fail(); }
  // Expected digest only: fresh B1 already proved actual Parser3/4 body
  // parity before mutations. No historical Native4 inspection is fabricated.
  const body = { version:2 as const, birthProof:birth.birthProof,
    inventory4Proof:proof({...birth.binding.nativeInventory,parserVersion:4}) };
  return Object.freeze({...body,bindingProof:proof(body)});
}
