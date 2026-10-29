import assert from 'node:assert/strict';

/** Explicit, bounded fixture sizing; never reads or changes a product setting. */
export function documentBaselineSize(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  assert(raw === undefined || /^(?:[1-9][0-9]*)$/u.test(raw));
  assert(Number.isSafeInteger(value) && value >= 2 && value <= 200);
  return value;
}

/** All effects are supplied by the already owned fixture. Additional Editor /
 * path-operation sources use its real upload service; reader fixtures retain
 * their explicit native SQL seeding. Neither is production-data acceptance. */
export async function fillDocumentBaselineFixture(input: {
  target: number;
  count: () => Promise<number>;
  seed: (index: number) => Promise<unknown>;
}): Promise<number> {
  const before = await input.count();
  assert(Number.isSafeInteger(input.target) && input.target >= 2 && input.target <= 200);
  assert(Number.isSafeInteger(before) && before >= 1 && before <= input.target);
  for (let index = before; index < input.target; index++) await input.seed(index);
  const after = await input.count(); assert.equal(after, input.target);
  return after;
}
