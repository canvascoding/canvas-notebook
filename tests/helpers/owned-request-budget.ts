import assert from 'node:assert/strict';
import path from 'node:path';
import { assertOrigin, assertOwnedRoot, privateBytes, writePrivateJson,
  type OwnedYjsReceipt } from '../../scripts/lib/owned-yjs-authority-qa';

type Budget = 'files-create' | 'files-tree';
type Clock = { now: () => number; wait: (milliseconds: number) => Promise<void> };
type Binding = { nonce: string; rootDevice: string; rootInode: string; actorId: string; origin: string };
type Ledger = Binding & { version: 1; budget: Budget; notBefore: number; observedAt: number; requests: number[] };
const windowMs = 61_000;
const limits: Record<Budget, number> = { 'files-create': 19, 'files-tree': 59 };

export function ownedRequestBudgetEnabled(): boolean {
  const enabled = process.env.CANVAS_YJS_AUTHORITY_E2E === '1';
  if (enabled || process.env.CANVAS_YJS_QA_RECEIPT !== undefined) {
    assert(enabled && process.env.E2E_EXTERNAL_SERVER === '1', 'Owned request budgets require the explicit Yjs and external-server contracts.');
  }
  return enabled;
}

async function currentBinding() {
  assert.equal(process.env.CANVAS_YJS_AUTHORITY_E2E, '1'); assert.equal(process.env.E2E_EXTERNAL_SERVER, '1');
  const filename = process.env.CANVAS_YJS_QA_RECEIPT ?? '';
  assert(path.isAbsolute(filename) && path.basename(filename) === 'recovery.json', 'The current owned QA receipt is required.');
  const receipt = JSON.parse((await privateBytes(filename)).toString()) as OwnedYjsReceipt;
  assert.equal(filename, path.join(receipt.fixtureRoot, 'recovery.json'));
  await assertOwnedRoot(receipt);
  assert.equal(receipt.nonce, process.env.CANVAS_YJS_QA_NONCE);
  assert.equal(receipt.phase, 'browser');
  assert.equal(receipt.uncertain, false, 'Shutdown or uncertain ownership cannot reserve a request.');
  assert(typeof receipt.actorId === 'string' && receipt.actorId.length > 0 && receipt.actorId.length <= 256);
  const binding: Binding = { nonce: receipt.nonce, rootDevice: receipt.rootDevice, rootInode: receipt.rootInode,
    actorId: receipt.actorId, origin: assertOrigin(process.env.BASE_URL ?? '', receipt.port).origin };
  return { receipt, binding };
}

function validateLedger(value: unknown, binding: Binding, budget: Budget, now: number): Ledger {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid owned request budget.');
  const ledger = value as Ledger;
  assert.deepEqual(Object.keys(ledger).sort(), ['version','budget','nonce','rootDevice','rootInode','actorId','origin','notBefore','observedAt','requests'].sort());
  assert.equal(ledger.version, 1); assert.equal(ledger.budget, budget);
  for (const key of ['nonce','rootDevice','rootInode','actorId','origin'] as const) assert.equal(ledger[key], binding[key]);
  assert(Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(ledger.observedAt) && ledger.observedAt >= 0
    && ledger.observedAt <= now, 'An owned request clock cannot move backwards.');
  assert(Number.isSafeInteger(ledger.notBefore) && ledger.notBefore >= 0 && ledger.notBefore <= ledger.observedAt + windowMs);
  assert(Array.isArray(ledger.requests) && ledger.requests.length <= limits[budget]);
  ledger.requests.forEach((timestamp, index) => assert(Number.isSafeInteger(timestamp) && timestamp >= 0
    && timestamp <= ledger.observedAt && (index === 0 || timestamp >= ledger.requests[index - 1])));
  return ledger;
}

/** The owned supervisor runs one worker at a time. Durable private reservations
 * survive a new spec/failed-worker process; queues serialize requests in a worker.
 * This only waits before requests. It never changes or resets a server bucket. */
export function createOwnedRequestBudgetCoordinator(clock: Clock = {
  now: Date.now, wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  const queues = new Map<Budget, Promise<void>>();
  const coordinate = (budget: Budget, quiet: boolean): Promise<void> => {
    const previous = queues.get(budget) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const initial = await currentBinding();
      const filename = path.join(initial.receipt.fixtureRoot, `request-budget-${budget}.json`);
      while (true) {
        const actual = await currentBinding();
        assert.deepEqual(actual.binding, initial.binding);
        const now = clock.now();
        let ledger: Ledger;
        try { ledger = validateLedger(JSON.parse((await privateBytes(filename)).toString()), initial.binding, budget, now); }
        catch (error) {
          if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error;
          ledger = { version: 1, ...initial.binding, budget, notBefore: now + (budget === 'files-tree' ? windowMs : 0),
            observedAt: now, requests: [] };
          validateLedger(ledger, initial.binding, budget, now);
          await writePrivateJson(filename, ledger, true);
        }
        ledger.requests = ledger.requests.filter(timestamp => timestamp + windowMs > now);
        const readyAt = quiet && ledger.requests.length ? Math.max(ledger.notBefore, ledger.requests.at(-1)! + windowMs)
          : ledger.requests.length >= limits[budget] ? Math.max(ledger.notBefore, ledger.requests[0] + windowMs) : ledger.notBefore;
        if (readyAt > now) { await clock.wait(readyAt - now); continue; }
        ledger.observedAt = now;
        if (!quiet) ledger.requests.push(now);
        validateLedger(ledger, initial.binding, budget, now);
        await assertOwnedRoot(actual.receipt);
        await writePrivateJson(filename, ledger);
        await assertOwnedRoot(actual.receipt);
        return;
      }
    });
    // A rejected ownership/ledger check is never turned into a reservation.
    // Later calls still validate the original private evidence independently.
    queues.set(budget, pending.catch(() => undefined));
    return pending;
  };
  return { wait: (budget: Budget) => coordinate(budget, false), quiet: (budget: Budget) => coordinate(budget, true) };
}

export const ownedRequestBudget = createOwnedRequestBudgetCoordinator();
