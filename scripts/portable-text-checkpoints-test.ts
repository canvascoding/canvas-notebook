import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function main() {
  const rows = [
    { id: 'a', workspace_id: 'selected', root_relative_path: 'workspaces/organization/org/shared/files' },
    { id: 'b', workspace_id: 'private', root_relative_path: 'workspaces/personal/other/files' },
  ];
  const projected: string[] = [];
  let closed = 0;
  let supersede = true;
  let fail = false;
  class Superseded extends Error {}
  const source = ts.transpileModule(readFileSync('app/lib/exports/text-checkpoints.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const evaluated = { exports: {} as { ensurePortableTextCheckpointsCurrent(options: object): Promise<void> } };
  const load = (name: string) => {
    if (name === 'server-only') return {};
    if (name.endsWith('/db')) return { openDb: async () => ({
      all: async (_query: string, args: unknown[]) => args[0] === '' ? rows : [], close: async () => { closed++; },
    }) };
    if (name.endsWith('/path-guard')) return { normalizeWorkspaceRelativePath: (value: string) => value };
    if (name.endsWith('/checkpoint-worker')) return { resolveExcalidrawCheckpointWorkspace: async (workspaceId: string) => ({ workspaceId }) };
    if (name.endsWith('/persistence')) return { loadCollaborationState: async (id: string) => ({
      documentId: id, status: 'active', workspaceId: rows.find(row => row.id === id)!.workspace_id,
    }) };
    if (name.endsWith('/checkpoint')) return { CollaborationCheckpointSupersededError: Superseded,
      materializeCollaborationCheckpoint: async ({ state }: { state: { documentId: string } }) => {
        if (fail) throw new Error('quarantined fixture');
        if (supersede) { supersede = false; throw new Superseded(); }
        projected.push(state.documentId);
      } };
    throw new Error('Unexpected dependency: ' + name);
  };
  new Function('require', 'module', 'exports', source)(load, evaluated, evaluated.exports);
  await evaluated.exports.ensurePortableTextCheckpointsCurrent({ rootRelativePaths: ['workspaces/organization'] });
  assert.deepEqual(projected, ['a'], 'Never materialize excluded personal data.');
  assert.equal(closed, 2, 'Every paginated database handle is released.');
  fail = true;
  await assert.rejects(() => evaluated.exports.ensurePortableTextCheckpointsCurrent({}),
    (error: unknown) => (error as { code?: string }).code === 'COLLABORATION_EXPORT_CHECKPOINT_UNAVAILABLE');
  console.log('PASS: scoped text checkpoints retry superseded states, paginate, close connections and block unsafe exports.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
