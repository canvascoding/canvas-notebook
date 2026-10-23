import { types } from 'node:util';

const MAX_SELECTIONS = 1000;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonRecord = { [key: string]: Json };
type Budget = { bytes: number; nodes: number; maximum: number; maxNodes: number; maxArray: number;
  tooLarge: () => never; invalid: () => never; ancestors: WeakSet<object> };
function add(budget: Budget, bytes: number): void {
  budget.bytes += bytes; if (budget.bytes > budget.maximum) budget.tooLarge();
}
/** Exact escaped UTF-8 JSON cost; rejects lone surrogates without encoding them. */
function stringCost(value: string, budget: Budget): void {
  if (value.length > budget.maximum) budget.tooLarge(); add(budget, 2);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) budget.invalid(); add(budget, 4);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) budget.invalid();
    else if (unit === 0x22 || unit === 0x5c || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) add(budget, 2);
    else add(budget, unit < 0x20 ? 6 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3);
  }
}
/** Input may already be a JS object. No getter, Proxy trap, toJSON or array method
 * is invoked, and byte/node/array bounds precede copying a child or serializing. */
function capture(value: unknown, budget: Budget, depth = 0): Json {
  if (++budget.nodes > budget.maxNodes || depth > 12) return budget.tooLarge();
  if (value === null) { add(budget, 4); return null; }
  if (typeof value === 'string') { stringCost(value, budget); return value; }
  if (typeof value === 'boolean') { add(budget, value ? 4 : 5); return value; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return budget.invalid(); add(budget, String(value).length); return value === 0 ? 0 : value;
  }
  if (!value || typeof value !== 'object' || types.isProxy(value)) return budget.invalid();
  if (budget.ancestors.has(value)) return budget.invalid();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype) return budget.invalid();
  const length: unknown = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : undefined;
  if (array && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)) return budget.invalid();
  if (typeof length === 'number' && length > budget.maxArray) return budget.tooLarge();
  const names = Reflect.ownKeys(value);
  if (names.length > (array ? budget.maxArray + 1 : 24)) return budget.tooLarge();
  if (names.some(key => typeof key !== 'string') || array && names.length !== Number(length) + 1) return budget.invalid();
  budget.ancestors.add(value); add(budget, 2);
  try {
    if (array) {
      const result: Json[] = [];
      for (let index = 0; index < Number(length); index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return budget.invalid();
        if (index) add(budget, 1); result.push(capture(descriptor.value as unknown, budget, depth + 1));
      }
      return result;
    }
    const result: JsonRecord = {};
    for (const [index, key] of (names as string[]).entries()) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) return budget.invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return budget.invalid();
      if (index) add(budget, 1); stringCost(key, budget); add(budget, 1);
      Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
        value: capture(descriptor.value as unknown, budget, depth + 1) });
    }
    return result;
  } finally { budget.ancestors.delete(value); }
}
export function freezeMcpToolJson<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeMcpToolJson(child); Object.freeze(value); }
  return value;
}
export function captureBoundedMcpToolJson(value: unknown, maximum: number, invalid: () => never, tooLarge: () => never, request = false): Json {
  return capture(value, { maximum, bytes: 0, nodes: 0, maxNodes: request ? 4096 : 131_072,
    maxArray: request ? MAX_SELECTIONS : 100_000, invalid, tooLarge, ancestors: new WeakSet() });
}
