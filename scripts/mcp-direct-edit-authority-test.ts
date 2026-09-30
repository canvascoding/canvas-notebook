import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

type Scope = {
  userId: string; clientId: string; sessionId: string; actorId: string;
  workspaceId: string; documentId: string; path: string; lifecycleGeneration: number;
};
type Authority = { scope: Scope; verifyCurrent(): Promise<unknown>; assertUnexpired(): void };
type Exports = {
  createDirectMcpEditAuthority(input: { token: string; scope: Scope }): Promise<Authority>;
  isDirectMcpEditAuthority(value: unknown): boolean;
};

function compileAuthority(dependencies: Record<string, unknown>): Exports {
  const source = ts.createSourceFile('direct-edit-authority.ts',
    readFileSync('app/lib/mcp/server/direct-edit-authority.ts', 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = source.statements.filter(statement => {
    if (ts.isClassDeclaration(statement)) return statement.name?.text === 'DirectMcpEditAuthorityError';
    if (ts.isFunctionDeclaration(statement)) return ['isDirectMcpEditAuthority', 'createDirectMcpEditAuthority']
      .includes(statement.name?.text ?? '');
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && ['registryKey', 'runtime', 'authorities'].includes(declaration.name.text));
    return false;
  });
  const javascript = ts.transpileModule(selected.map(statement => statement.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('exports', ...Object.keys(dependencies), `${javascript}\nreturn {
    createDirectMcpEditAuthority, isDirectMcpEditAuthority
  };`)({}, ...Object.values(dependencies)) as Exports;
}

const scope: Scope = {
  userId: 'user', clientId: 'client', sessionId: 'session',
  actorId: `direct-mcp:${createHash('sha256').update('client').digest('hex').slice(0, 32)}`,
  workspaceId: 'workspace', documentId: 'document', path: 'notes.md', lifecycleGeneration: 1,
};

test('MCP authority is bearer backed, cross-bundle trusted, and rechecks revocation and workspace access', async () => {
  let now = 1_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    let revoked = false;
    let enabled = true;
    let canWrite = true;
    let allowed = true;
    let tokenChecks = 0;
    const dependencies = {
      createHash,
      verifyDirectMcpAccessToken: async (token: string, scopes: string[]) => {
        tokenChecks++;
        assert.equal(token, 'real-bearer');
        assert.deepEqual(scopes, ['knowledge:write']);
        if (revoked) throw new Error('revoked');
        return { userId: 'user', clientId: 'client', sessionId: 'session', expiresAt: 1_010 };
      },
      getDirectMcpRuntimeSettings: async () => ({ enabled, tools: ['edit_knowledge_source'] }),
      loadDirectMcpWorkspaceListingForUser: async () => ({ workspaces: [{ workspaceId: 'workspace',
        permissions: { canRead: true, canWrite, canRunAgent: true } }] }),
      listDirectMcpAllowedWorkspaceIds: async () => allowed ? new Set(['workspace']) : new Set<string>(),
      listDirectMcpEnabledWorkspaceIds: async () => new Set(['workspace']),
      isDirectMcpReadableWorkspace: () => true,
    };
    // Separate evaluations emulate the Next and standalone collaboration server bundles.
    const client = compileAuthority(dependencies);
    const room = compileAuthority(dependencies);
    await assert.rejects(client.createDirectMcpEditAuthority({ token: 'real-bearer',
      scope: { ...scope, actorId: 'forged' } }), /MCP editing authority changed/u);
    const authority = await client.createDirectMcpEditAuthority({ token: 'real-bearer', scope });
    assert.equal(room.isDirectMcpEditAuthority(authority), true);
    assert.equal(room.isDirectMcpEditAuthority({ ...authority }), false,
      'a serialized or copied shape cannot carry trusted authority');
    assert.equal(tokenChecks, 1);
    await authority.verifyCurrent();
    assert.equal(tokenChecks, 2);
    allowed = false;
    await assert.rejects(authority.verifyCurrent(), /MCP editing authority changed/u);
    allowed = true;
    revoked = true;
    await assert.rejects(authority.verifyCurrent(), /MCP editing authority changed/u);
    revoked = false;
    enabled = false;
    await assert.rejects(authority.verifyCurrent(), /MCP editing authority changed/u);
    enabled = true;
    canWrite = false;
    await assert.rejects(authority.verifyCurrent(), /MCP editing authority changed/u);
    canWrite = true;
    await authority.verifyCurrent();
    now = 1_010_000;
    assert.throws(() => authority.assertUnexpired(), /MCP editing authority changed/u);
  } finally {
    Date.now = originalNow;
  }
});
