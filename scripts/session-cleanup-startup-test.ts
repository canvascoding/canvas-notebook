import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluateIsolatedModule, sourceFunction } from './helpers/isolated-source-module';

async function main() {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  try {
    for (const provider of ['postgres', 'sqlite']) {
      for (const failure of ['none', 'query', 'close', 'acquire']) {
        let finishQuery!: (value: { changes: number }) => void;
        let failQuery!: (error: Error) => void;
        const query = new Promise<{ changes: number }>((resolve, reject) => { finishQuery = resolve; failQuery = reject; });
        let finishClose!: () => void;
        const close = new Promise<void>((resolve) => { finishClose = resolve; });
        const sql: string[] = [];
        const warnings: string[] = [];
        let opens = 0;
        let closes = 0;
        let first = true;
        let tick!: () => Promise<void>;
        const exported = evaluateIsolatedModule<{ scheduleExpiredSessionCleanup: () => void }>(sourceFunction('server.js', 'scheduleExpiredSessionCleanup'), {
          './app/lib/db/index': {
            getDatabaseProvider: () => provider,
            openDb: async () => {
              opens++;
              if (first && failure === 'acquire') throw new Error('private acquire failure');
              return {
                run: async (statement: string) => {
                  sql.push(statement);
                  if (first && statement.startsWith('DELETE')) return query;
                  return { changes: 0 };
                },
                close: async () => {
                  closes++;
                  if (first) { await close; if (failure === 'close') throw new Error('private close failure'); }
                },
              };
            },
          },
        }, {
          console: { log: () => {}, warn: (...args: unknown[]) => { warnings.push(args.join(' ')); } },
          setInterval: (callback: typeof tick, millis: number) => {
            tick = callback;
            assert.equal(millis, 15 * 60 * 1_000);
            return { unref() {} };
          },
        });
        exported.scheduleExpiredSessionCleanup();
        await delay(0);
        if (failure !== 'acquire') {
          await tick();
          assert.equal(opens, 1, 'do not overlap cleanup while a query is pending');
          assert.equal(closes, 0, 'do not release before query completion');
          if (failure === 'query') failQuery(new Error('private query failure'));
          else finishQuery({ changes: 2 });
          await delay(0);
          assert.equal(closes, 1);
          await tick();
          assert.equal(opens, 1, 'the guard includes asynchronous cleanup');
          finishClose();
          await delay(0);
        }
        assert.equal(warnings.length, failure === 'none' ? 0 : 1);
        assert.ok(warnings.every((warning) => !warning.includes('private')));
        if (failure === 'none') assert.equal(sql.some((statement) => statement === 'PRAGMA optimize'), provider === 'sqlite');
        first = false;
        await tick();
        assert.equal(opens, 2, 'the next tick must recover after either success or failure');
        assert.equal(closes, failure === 'acquire' ? 1 : 2);
        assert.deepEqual(unhandled, []);
      }
    }
    console.log('Session cleanup: awaited queries, finally release, overlap guard, SQLite compatibility and recovery passed.');
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
