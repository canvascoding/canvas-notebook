import 'server-only';

import { types } from 'node:util';
import { decodeNativeCopyMarkdownBirthV1, nativeCopyMarkdownBirthText, rejectNativeCopyMarkdownBirth,
  type NativeCopyMarkdownBirthV1 } from './native-copy-markdown-birth-contract';
import { decodeNativeCopyMarkdownBirthV2, nativeCopyMarkdownBirthV2Text,
  type NativeCopyMarkdownBirthV2 } from './native-copy-markdown-birth-v2-contract';

export type NativeCopyMarkdownBirth = NativeCopyMarkdownBirthV1 | NativeCopyMarkdownBirthV2;
/** Disjoint historical decoding. A version descriptor selects a strict original
 * decoder; no profile is reinterpreted and no declared facts grant authority. */
export function decodeNativeCopyMarkdownBirth(input: unknown): NativeCopyMarkdownBirth {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    return rejectNativeCopyMarkdownBirth();
  }
  const version = Object.getOwnPropertyDescriptor(input, 'version');
  if (!version?.enumerable || !Object.hasOwn(version, 'value')) return rejectNativeCopyMarkdownBirth();
  if (version.value === 1) return decodeNativeCopyMarkdownBirthV1(input);
  if (version.value === 2) return decodeNativeCopyMarkdownBirthV2(input);
  return rejectNativeCopyMarkdownBirth();
}
export function nativeCopyMarkdownBirthAnyText(input: NativeCopyMarkdownBirth): string {
  const birth = decodeNativeCopyMarkdownBirth(input);
  return birth.version === 1 ? nativeCopyMarkdownBirthText(birth) : nativeCopyMarkdownBirthV2Text(birth);
}
