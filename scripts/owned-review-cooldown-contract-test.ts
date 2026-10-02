import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import ts from 'typescript';
import { expect } from '@playwright/test';

import { prepareOwnedReviewCooldown, type ReviewSourceGeneration } from '../tests/helpers/owned-review-cooldown';

const execute = promisify(execFile);
const bindingHash = 'a'.repeat(64);
const source: ReviewSourceGeneration = { pid: process.pid, startedAt: Date.now() - 1000,
  processStartIdentity: `${process.getuid?.()} native contract source`, bindingHash };
const stateName = 'document-review-cooldown.json';
const leaseName = 'document-review-fixture.lock';
const nativeRequire = createRequire(import.meta.url);

async function capture(run: () => Promise<unknown>): Promise<{ failed: boolean; error?: unknown }> {
  try { await run(); return { failed: false }; } catch (error) { return { failed: true, error }; }
}

async function withLease<T>(directory: string, run: (input: Parameters<typeof prepareOwnedReviewCooldown>[0]) => Promise<T>): Promise<T> {
  const leasePath = path.join(directory, leaseName);
  const lease = await fs.open(leasePath, 'wx', 0o600);
  try {
    await lease.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID(), bindingHash }));
    await lease.sync();
    return await run({ directory, bindingHash, socketPath: '/native-contract/tools.sock', leasePath, lease });
  } finally {
    const held = await lease.stat();
    const current = await fs.lstat(leasePath);
    assert.equal(current.ino, held.ino);
    await fs.unlink(leasePath);
    await lease.close();
  }
}

function loadModule(filename: string, overrides: Record<string, unknown>, processOverride: unknown = process): Record<string, unknown> {
  const code = ts.transpileModule(nativeRequire('node:fs').readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', 'process', code)(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name), { exports }, exports, processOverride);
  return exports;
}

async function main(): Promise<void> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owned-review-cooldown-contract-')));
  await fs.chmod(directory, 0o700);
  const owned = await fs.lstat(directory);
  let passed = 0;
  const scenario = async (name: string, run: (root: string) => Promise<void>) => {
    const root = path.join(directory, `case-${++passed}`);
    await fs.mkdir(root, { mode: 0o700 });
    await run(root);
    console.log(`PASS ${name}`);
  };
  const publish = async (root: string) => withLease(root, async input => {
    const cooldown = await prepareOwnedReviewCooldown(input, { readSource: async () => source });
    await cooldown.markQuiescent();
  });
  try {
    await scenario('same-source cooldown survives a worker restart with a shared monotonic clock', async root => {
      await publish(root);
      const child = await execute(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
        path.resolve('scripts/owned-review-cooldown-contract-test.ts'), '--worker', root, JSON.stringify(source)],
      { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 15_000, maxBuffer: 4096 });
      const receipt = JSON.parse(child.stdout) as { waited: number };
      assert.ok(receipt.waited > 0 && receipt.waited <= 61_000);
    });
    await scenario('new Source generation skips the prior same-binding cooldown', async root => {
      await publish(root);
      let calls = 0;
      await withLease(root, async input => {
        const cooldown = await prepareOwnedReviewCooldown(input, {
          readSource: async () => ({ ...source, startedAt: source.startedAt + 1 }), wait: async () => { calls += 1; },
        });
        await cooldown.markQuiescent();
      });
      assert.equal(calls, 0);
    });
    await scenario('unsafe ownership modes and source bindings fail before publication', async root => {
      await publish(root);
      const before = await fs.readFile(path.join(root, stateName));
      await fs.chmod(path.join(root, stateName), 0o644);
      await withLease(root, async input => {
        await assert.rejects(prepareOwnedReviewCooldown(input, { readSource: async () => source }), /private file ownership/u);
      });
      await fs.chmod(path.join(root, stateName), 0o600);
      await withLease(root, async input => {
        await assert.rejects(prepareOwnedReviewCooldown(input, {
          readSource: async () => ({ ...source, bindingHash: 'b'.repeat(64) }),
        }), /current target binding/u);
        await assert.rejects(prepareOwnedReviewCooldown(input, {
          readSource: async () => ({ ...source, processStartIdentity: `${Number(process.getuid?.()) + 1} foreign native source` }),
        }), /source generation/u);
      });
      assert.deepEqual(await fs.readFile(path.join(root, stateName)), before);
    });
    await scenario('a real lease pathname replacement is preserved and cannot publish quiet', async root => {
      const leasePath = path.join(root, leaseName);
      const lease = await fs.open(leasePath, 'wx', 0o600);
      let replacement: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        const held = await lease.stat();
        const cooldown = await prepareOwnedReviewCooldown({ directory: root, bindingHash,
          socketPath: '/native-contract/tools.sock', leasePath, lease }, { readSource: async () => source });
        await fs.unlink(leasePath);
        replacement = await fs.open(leasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const bytes = Buffer.from('Native replacement lease: preserve this owner.');
        await replacement.writeFile(bytes);
        await replacement.sync();
        const current = await replacement.stat();
        assert.notEqual(current.ino, held.ino);
        await assert.rejects(cooldown.markQuiescent(), /exclusive lease ownership/u);
        assert.deepEqual(await fs.readFile(leasePath), bytes);
        await assert.rejects(fs.lstat(path.join(root, stateName)), { code: 'ENOENT' });
        assert.equal((await fs.lstat(leasePath)).ino, current.ino);
      } finally { await replacement?.close(); await lease.close(); }
    });
    await scenario('state changed while waiting is preserved and rejected by CAS', async root => {
      await publish(root);
      let clock = process.hrtime.bigint();
      const competing = Buffer.from(JSON.stringify({ version: 1, source, lastQuiescentNs: String(clock) }));
      await withLease(root, async input => {
        await assert.rejects(prepareOwnedReviewCooldown(input, { readSource: async () => source, now: () => clock,
          wait: async ms => { await fs.writeFile(path.join(root, stateName), competing); clock += BigInt(ms) * BigInt(1_000_000); },
        }), /CAS after wait/u);
      });
      assert.deepEqual(await fs.readFile(path.join(root, stateName)), competing);
    });
    await scenario('a changed Source during the quiet interval fails closed', async root => {
      await publish(root);
      const before = await fs.readFile(path.join(root, stateName));
      let clock = process.hrtime.bigint();
      let reads = 0;
      await withLease(root, async input => {
        await assert.rejects(prepareOwnedReviewCooldown(input, { now: () => clock,
          readSource: async () => (++reads === 1 ? source : { ...source, startedAt: source.startedAt + 1 }),
          wait: async ms => { clock += BigInt(ms) * BigInt(1_000_000); },
        }), /source unchanged after wait/u);
      });
      assert.deepEqual(await fs.readFile(path.join(root, stateName)), before);
    });
    for (const failure of ['partial-write', 'CAS-before-publish'] as const) {
      await scenario(`${failure} leaves the original receipt and removes only its temporary file`, async root => {
        await publish(root);
        const original = await fs.readFile(path.join(root, stateName));
        const competing = Buffer.from(JSON.stringify({ version: 1, source, lastQuiescentNs: '1' }));
        const sentinel = new Error('native partial publication failure');
        const prepare = loadModule(path.resolve('tests/helpers/owned-review-cooldown.ts'), {
          './ordinary-agent-tool': { requireOwnedQaAgentToolSocket: async () => { throw new Error('Unexpected live Source validation.'); } },
          'node:fs/promises': { ...fs, open: async (filename: string, flags: number, mode?: number) => {
            const handle = await fs.open(filename, flags, mode);
            if (!filename.endsWith('.tmp')) return handle;
            return new Proxy(handle, { get(target, name) {
              if (name === 'write' && failure === 'partial-write') return async (buffer: Buffer) => {
                await target.write(buffer, 0, Math.min(10, buffer.length), 0); throw sentinel;
              };
              if (name === 'sync' && failure === 'CAS-before-publish') return async () => {
                await target.sync(); await fs.writeFile(path.join(root, stateName), competing);
              };
              const value = Reflect.get(target, name);
              return typeof value === 'function' ? value.bind(target) : value;
            } });
          } },
        }).prepareOwnedReviewCooldown as typeof prepareOwnedReviewCooldown;
        await withLease(root, async input => {
          const cooldown = await prepare(input, { readSource: async () => ({ ...source, startedAt: source.startedAt + 1 }) });
          const rejected = await capture(() => cooldown.markQuiescent());
          assert.equal(rejected.failed, true);
          if (failure === 'partial-write') assert.equal(rejected.error, sentinel);
          else assert.match(String(rejected.error), /CAS before publication/u);
        });
        assert.deepEqual(await fs.readFile(path.join(root, stateName)), failure === 'partial-write' ? original : competing);
        assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
      });
    }

    for (const failure of ['none', 'context', 'dispose', 'restore', 'prepare', 'unacknowledged-enable', 'undefined-primary'] as const) {
      await scenario(`central fixture preserves primary and ownership (${failure})`, async root => {
        const primary = new Error('native body failure');
        const cleanupFailure = new Error(`native ${failure} cleanup failure`);
        const baseline = { close: async () => { throw new Error('Baseline context must remain untouched.'); } };
        const contexts: unknown[] = [baseline];
        let enabled = failure !== 'restore' && failure !== 'unacknowledged-enable';
        let updatedAt: string | null = null;
        let stamp = Date.now();
        let bodyRan = false;
        let patches = 0;
        let registrations: Record<string, unknown> | undefined;
        const authContext = { storageState: async () => ({ cookies: [], origins: [] }), close: async () => {
          contexts.splice(contexts.indexOf(authContext), 1);
        } };
        const api = { get: async (url: string) => ({ status: () => 200, json: async () => url === '/api/auth/get-session'
          ? { user: { role: 'admin', email: 'native-admin' } }
          : { success: true, data: url.includes('/bulk/') ? { studioBulkEnabled: true, updatedAt: null }
            : { documentReviewEnabled: enabled, updatedAt } } }),
        patch: async (_url: string, options: { data: { documentReviewEnabled: boolean } }) => {
          patches += 1;
          if (!options.data.documentReviewEnabled && failure === 'restore') throw cleanupFailure;
          enabled = options.data.documentReviewEnabled;
          updatedAt = new Date(++stamp).toISOString();
          if (failure === 'unacknowledged-enable') throw cleanupFailure;
          return { status: () => 200, json: async () => ({ success: true, data: { documentReviewEnabled: enabled,
            updatedAt, studioBulkEnabled: true, studioBulkUpdatedAt: null } }) };
        }, dispose: async () => { if (failure === 'dispose') throw cleanupFailure; } };
        const browser = { contexts: () => contexts };
        const exported = loadModule(path.resolve('tests/helpers/document-review-experimental.ts'), {
          '@playwright/test': { expect, request: { newContext: async () => api },
            test: { extend: (fixtures: Record<string, unknown>) => { registrations = fixtures; return {}; } } },
          './managed-test-context': { createAuthenticatedContext: async () => { contexts.push(authContext); return authContext; } },
          '../../scripts/lib/owned-collaboration-qa': { ownedCollaborationQaEnabled: () => true,
            requireOwnedCollaborationQaTarget: async () => ({ dataRoot: path.join(root, 'data'), bindingHash }) },
          './owned-review-cooldown': { prepareOwnedReviewCooldown: async (input: Parameters<typeof prepareOwnedReviewCooldown>[0]) => {
            if (failure === 'prepare') throw cleanupFailure;
            return prepareOwnedReviewCooldown(input, { readSource: async () => source });
          } },
        }, { ...process, env: { BASE_URL: 'http://127.0.0.1:4126', BOOTSTRAP_ADMIN_EMAIL: 'native-admin',
          COLLABORATION_E2E: '1', CANVAS_LOCAL_AGENT_TOOL_SOCKET: '/native-contract/tools.sock' } });
        const run = exported.withDocumentReviewEnabled as (browser: unknown, body: () => Promise<void>) => Promise<void>;
        const rejected = await capture(() => run(browser, async () => {
          bodyRan = true;
          const ownedContext = { close: async () => {
            if (failure === 'context') throw cleanupFailure;
            contexts.splice(contexts.indexOf(ownedContext), 1);
          } };
          contexts.push(ownedContext);
          if (failure === 'undefined-primary') throw undefined;
          throw primary;
        }));
        assert.equal(rejected.failed, true);
        assert.equal(contexts.includes(baseline), true);
        assert.equal((registrations?.documentReviewFlag as unknown[])[1] &&
          ((registrations?.documentReviewFlag as unknown[])[1] as { timeout: number }).timeout, 150_000);
        const state = await fs.readFile(path.join(root, stateName)).catch(error => {
          if (error.code === 'ENOENT') return undefined; throw error;
        });
        const lease = await fs.lstat(path.join(root, leaseName)).catch(error => {
          if (error.code === 'ENOENT') return undefined; throw error;
        });
        if (failure === 'none' || failure === 'undefined-primary') {
          assert.equal(rejected.error, failure === 'none' ? primary : undefined);
          assert.ok(state);
          assert.equal(lease, undefined);
        } else if (failure === 'prepare') {
          assert.equal(rejected.error, cleanupFailure);
          assert.equal(bodyRan, false);
          assert.equal(patches, 0);
          assert.equal(state, undefined);
          assert.equal(lease, undefined, 'Verified setup-only cleanup can release its lease without publishing quiet.');
        } else {
          assert.ok(rejected.error instanceof AggregateError);
          assert.equal(rejected.error.errors[0], failure === 'unacknowledged-enable' ? cleanupFailure : primary);
          assert.equal(state, undefined);
          assert.ok(lease, 'Unverified cleanup/restore retains its owned lease for diagnosis.');
          assert.equal(bodyRan, failure !== 'unacknowledged-enable');
        }
      });
    }
    console.log(`${passed} owned review cooldown contracts passed; no live Source, browser, or database used.`);
  } finally {
    const current = await fs.lstat(directory);
    assert.equal(current.uid, process.getuid?.());
    assert.equal(current.ino, owned.ino);
    assert.equal(current.dev, owned.dev);
    await fs.rm(directory, { recursive: true });
  }
}

async function worker(): Promise<void> {
  const root = process.argv[3];
  const inheritedSource = JSON.parse(process.argv[4]) as ReviewSourceGeneration;
  let clock = process.hrtime.bigint();
  let waited = 0;
  await withLease(root, async input => {
    await prepareOwnedReviewCooldown(input, { readSource: async () => inheritedSource, now: () => clock,
      wait: async milliseconds => { waited += milliseconds; clock += BigInt(milliseconds) * BigInt(1_000_000); } });
  });
  process.stdout.write(JSON.stringify({ waited }));
}

void (process.argv[2] === '--worker' ? worker() : main()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
