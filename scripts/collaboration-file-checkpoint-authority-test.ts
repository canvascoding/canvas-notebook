import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function compileCheckpoint(dependencies: Record<string, unknown>): (input: Record<string, unknown>) => Promise<unknown> {
  const source = ts.createSourceFile('agent-file-checkpoint.ts',
    readFileSync('app/lib/collaboration/agent-file-checkpoint.ts', 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = source.statements.filter(statement =>
    (ts.isClassDeclaration(statement) && statement.name?.text === 'CollaborationFileCheckpointUnavailableError')
    || (ts.isFunctionDeclaration(statement) && statement.name?.text === 'confirmCollaborativeFileCheckpoint'));
  assert.equal(selected.length, 2);
  const javascript = ts.transpileModule(selected.map(statement => statement.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('exports', ...Object.keys(dependencies),
    `${javascript}\nreturn confirmCollaborativeFileCheckpoint;`)({}, ...Object.values(dependencies)) as
    (input: Record<string, unknown>) => Promise<unknown>;
}

test('MCP revocation immediately stops physical Markdown materialization', async () => {
  let materializations = 0;
  const state = {
    status: 'active', workspaceId: 'workspace', path: 'notes.md', lifecycleGeneration: 1,
    schemaVersion: 1, representation: 'plain_text', documentSequence: 1, checkpointSequence: 0,
  };
  class Superseded extends Error {}
  const confirm = compileCheckpoint({
    loadCollaborationState: async () => state,
    readFileCollaborationState: async () => { throw new Error('unexpected projection'); },
    sha256Buffer: () => 'hash',
    fs: { readFile: async () => Buffer.from('notes') },
    materializeCollaborationCheckpoint: async () => { materializations++; },
    CollaborationCheckpointSupersededError: Superseded,
  });
  let checks = 0;
  const error = Object.assign(new Error('revoked'), { code: 'MCP_DIRECT_EDIT_AUTHORITY_CHANGED' });
  await assert.rejects(confirm({
    path: 'notes.md', fullPath: '/workspace/notes.md', documentId: 'document',
    workspace: { workspaceId: 'workspace' },
    snapshot: { ...state, path: 'notes.md' },
    beforeMaterialize: async () => { checks++; throw error; },
  }), candidate => candidate === error);
  assert.equal(checks, 1, 'revocation is reported at the write boundary without checkpoint polling');
  assert.equal(materializations, 0, 'the physical file must not be written after revocation');
});
