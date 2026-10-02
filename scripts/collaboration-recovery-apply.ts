/** Explicit offline operator. Preparation writes a proposal; applying requires its exact reviewed hash. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openDb } from '../app/lib/db';
import { readCollaborationRecoveryBundle, prepareCollaborationRecoverySelection, applyCollaborationRecoverySelection,
  collaborationRecoverySelectionHash, type RecoverySelection, type RecoveryExecutionProof } from '../app/lib/collaboration/recovery-operator';

async function main() {
  const args = process.argv.slice(2); const mode = args.shift(); const flags = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!; const value = args.shift();
    if (!key.startsWith('--') || !value || flags.has(key)) throw new Error('Invalid recovery arguments.');
    flags.set(key, value);
  }
  const required = (name: string) => { const value = flags.get(name); if (!value) throw new Error('Missing recovery argument.'); return value; };
  const absolute = (name: string) => { const value = required(name); if (!path.isAbsolute(value)) throw new Error('Absolute paths required.'); return value; };
  if (mode === 'hash' && flags.size === 1 && flags.has('--reviewed')) {
    const selection = JSON.parse(await fs.readFile(absolute('--reviewed'), 'utf8')) as RecoverySelection;
    console.log(JSON.stringify({ selectionHash: collaborationRecoverySelectionHash(selection) })); return;
  }
  const bundle = await readCollaborationRecoveryBundle(absolute('--bundle'));
  if (mode === 'prepare' && flags.size === 2 && flags.has('--output')) {
    const selection = prepareCollaborationRecoverySelection(bundle);
    await fs.writeFile(absolute('--output'), JSON.stringify(selection, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, operations: selection.operations.length, manual: selection.manual.length,
      selectionHash: collaborationRecoverySelectionHash(selection), selected: 0 }));
    return;
  }
  if (mode !== 'apply' || flags.size !== 5 || !process.env.DATABASE_URL || !process.env.DATA) {
    throw new Error('Usage: prepare --bundle /bundle --output /proposal.json; apply --bundle /bundle --reviewed /selection.json --expect-selection-sha256 HASH --proof /proof.json --journal /journal');
  }
  const selection = JSON.parse(await fs.readFile(absolute('--reviewed'), 'utf8')) as RecoverySelection;
  const proof = JSON.parse(await fs.readFile(absolute('--proof'), 'utf8')) as RecoveryExecutionProof;
  const results = await applyCollaborationRecoverySelection({ bundle, selection,
    selectionHash: required('--expect-selection-sha256'), proof, journalDirectory: absolute('--journal'), openConnection: openDb });
  console.log(JSON.stringify({ completed: true, operations: results.length,
    applied: results.filter(result => result.disposition === 'applied').length, resumed: results.filter(result => result.disposition === 'already_applied').length }));
}

main().then(() => process.exit(0)).catch(() => {
  // Private bundles/journals retain evidence; never print raw document data, IDs or connection errors.
  console.error('Recovery operator stopped. Keep its evidence and journal; inspect the private reports before resuming.');
  process.exit(1);
});
