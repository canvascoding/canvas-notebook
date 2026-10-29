/** Explicit offline operator; does not initialize/migrate the application DB. */
import path from 'node:path';
import { Client } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { canonical, durablePrivateWrite, readPrivateRegularFile, type RecoveryExecutionProof } from '../app/lib/collaboration/recovery-operator';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { captureMissingStateRecoveryBundle, prepareMissingStateRecoverySelection, applyMissingStateRecoverySelection,
  type MissingStateRecoveryBundle, type MissingStateRecoverySelection } from '../app/lib/collaboration/recovery-missing-state';

async function connect(): Promise<SqlConnection> {
  if (!process.env.DATABASE_URL || !process.env.DATA) throw new Error('Explicit PostgreSQL and DATA required.');
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    application_name: 'canvas-missing-state-recovery-operator', connectionTimeoutMillis: 10_000 });
  await client.connect();
  return { get: async (sql, values) => (await client.query(sql, values)).rows[0],
    all: async (sql, values) => (await client.query(sql, values)).rows,
    run: async (sql, values) => await client.query(sql, values), close: async () => { await client.end(); } };
}
async function main() {
  const args = process.argv.slice(2), mode = args.shift(), flags = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!, value = args.shift();
    if (!value || !['--bundle','--document-ids','--output','--reviewed','--proof','--journal','--expect-selection-sha256'].includes(key)
      || flags.has(key)) throw new Error('Invalid operator arguments.');
    flags.set(key, value);
  }
  const required = (name: string) => { const value = flags.get(name); if (!value) throw new Error('Missing argument.'); return value; };
  const absolute = (name: string) => { const value = required(name); if (!path.isAbsolute(value)) throw new Error('Absolute path required.'); return value; };
  if (mode === 'capture' && flags.size === 2) {
    const database = await connect();
    try {
      await database.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const bundle = await captureMissingStateRecoveryBundle(database, required('--document-ids').split(','));
      await database.run('COMMIT');
      await durablePrivateWrite(absolute('--output'), bundle);
      console.log(JSON.stringify({ captured: true, documents: bundle.documents.length, bundleManifestHash: recoveryHash(canonical(bundle) + '\n') }));
    } finally { await database.close(); }
    return;
  }
  if (mode === 'hash' && flags.size === 1) {
    const selection = JSON.parse((await readPrivateRegularFile(absolute('--reviewed'))).toString('utf8'));
    console.log(JSON.stringify({ selectionHash: recoveryHash(canonical(selection)) })); return;
  }
  const bytes = await readPrivateRegularFile(absolute('--bundle')), bundle = JSON.parse(bytes.toString('utf8')) as MissingStateRecoveryBundle;
  const bundleManifestHash = recoveryHash(bytes);
  if (canonical(bundle) + '\n' !== bytes.toString('utf8')) throw new Error('Noncanonical bundle.');
  if (mode === 'prepare' && flags.size === 2) {
    const selection = prepareMissingStateRecoverySelection(bundle, bundleManifestHash);
    await durablePrivateWrite(absolute('--output'), selection);
    console.log(JSON.stringify({ prepared: true, operations: selection.operations.length, selected: 0 })); return;
  }
  if (mode !== 'apply' || flags.size !== 5) throw new Error('Use capture, prepare, hash, or apply with exact private paths.');
  const selection = JSON.parse((await readPrivateRegularFile(absolute('--reviewed'))).toString('utf8')) as MissingStateRecoverySelection;
  const proof = JSON.parse((await readPrivateRegularFile(absolute('--proof'))).toString('utf8')) as RecoveryExecutionProof;
  const results = await applyMissingStateRecoverySelection({ bundle, bundleManifestHash, selection, proof,
    selectionHash: required('--expect-selection-sha256'), journalDirectory: absolute('--journal'), openConnection: connect });
  console.log(JSON.stringify({ completed: true, applied: results.filter(row => row.disposition === 'applied').length,
    alreadyApplied: results.filter(row => row.disposition === 'already_applied').length }));
}
main().then(() => process.exit(0)).catch(() => {
  console.error('Missing-state recovery stopped. Preserve private evidence and journals before investigating.'); process.exit(1);
});
