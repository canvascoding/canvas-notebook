import 'server-only';

/** Public JSON metadata never contains the reserved private import provenance.
 * Strings (including package file contents/base64) retain their exact value.
 * The input and its nested objects are never mutated.
 */
export function toPublicCapabilityPackageMetadata<T>(value: T): T {
  const serialized = JSON.stringify(value, (key, item: unknown) => key === 'storeOrigin' ? undefined : item);
  return serialized === undefined ? value : JSON.parse(serialized) as T;
}
