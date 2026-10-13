import 'server-only';

import type { NativeCopyReceipt } from './native-copy-persistence';

const receipts = new WeakMap<object, NativeCopyReceipt>();

/** Private identity evidence stays outside enumerable/JSON response fields. */
export function bindNativeCopyReceipt<T extends object>(result: T, receipt: NativeCopyReceipt): T {
  receipts.set(result, structuredClone(receipt));
  return result;
}

/** Only an explicitly wired internal journal may consume this copy result's private receipt. */
export function readNativeCopyReceipt(result: object): NativeCopyReceipt | null {
  const receipt = receipts.get(result);
  return receipt ? structuredClone(receipt) : null;
}
