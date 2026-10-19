import 'server-only';

import { createHash } from 'node:crypto';
import type { NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';

/** Exact existing historical formula, independent of Phase/Read imports. */
export function nativeCopyLinkReceiptProof(receipt: NativeLinkMutationReceipt): string {
  return proof({ contractVersion: receipt.contractVersion, operationId: receipt.operationId, source: receipt.source,
    binding: receipt.binding, before: receipt.before, after: receipt.after,
    afterSnapshotHash: createHash('sha256').update(receipt.afterStateSnapshot).digest('hex'), inverseProof: proof(receipt.inverseRecipes) });
}
