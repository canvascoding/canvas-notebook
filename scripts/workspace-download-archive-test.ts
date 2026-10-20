import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

type ArchiveMethods = {
  storePreparedArchive(archive: { archivePath: string; tempDirectory: string; fileName: string }, owner: object): string;
  claimPreparedArchive(token: string, owner: object): { archivePath: string; tempDirectory: string };
};

async function main() {
  // This legacy entry retains the actual planner/writer contract through its
  // sole central owner. A fixed serial child keeps its node:test completion and
  // Date.now expiry oracles independent; no server, DB or suite selection here.
  const central = spawnSync(process.execPath, [
    path.resolve('scripts/run-document-read-tool-dispatch-test.mjs'),
    'scripts/native-workspace-download-archive-test.ts',
  ], { cwd: process.cwd(), stdio: 'inherit' });
  if (central.error) throw central.error;
  assert.equal(central.signal, null, 'Central native archive contract was interrupted.');
  assert.equal(central.status, 0, 'Central native archive contract failed.');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-download-contract-'));
  const requireDependency = createRequire(import.meta.url);
  const routePath = path.resolve('app/api/files/download/route.ts');
  // Tickets own an opaque already-materialized artifact. ZIP byte fidelity,
  // planning, source races and publication cleanup ran in the central suite.
  const archivePath = path.join(root, 'opaque-ticket-artifact');
  await fs.writeFile(archivePath, 'owned opaque ticket fixture');
  try {
    const javascript = ts.transpileModule(readFileSync(routePath, 'utf8')
      + '\nexport const archiveContractMethods = { storePreparedArchive, claimPreparedArchive };', {
      fileName: routePath,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const evaluated = { exports: {} as { archiveContractMethods: ArchiveMethods } };
    const load = (name: string) => {
      if (name.startsWith('@/')) return {};
      return requireDependency(name);
    };
    new Function('require', 'module', 'exports', javascript)(load, evaluated, evaluated.exports);
    const { storePreparedArchive, claimPreparedArchive } = evaluated.exports.archiveContractMethods;
    const archive = { archivePath, tempDirectory: root, fileName: 'fixture.zip' };
    const owner = { userId: 'owner', sessionId: 'session', workspaceId: 'workspace' };
    try {
      const token = storePreparedArchive(archive, owner);
      for (const other of [{ ...owner, userId: 'other' }, { ...owner, sessionId: 'other' }, { ...owner, workspaceId: 'other' }]) {
        assert.throws(() => claimPreparedArchive(token, other), (error: unknown) => (error as { status: number }).status === 403);
      }
      assert.equal(claimPreparedArchive(token, owner).archivePath, archive.archivePath);
      assert.throws(() => claimPreparedArchive(token, owner), (error: unknown) => (error as { status: number }).status === 410);
      const expired = storePreparedArchive(archive, owner);
      const now = Date.now;
      try {
        Date.now = () => now() + 301_000;
        assert.throws(() => claimPreparedArchive(expired, owner), (error: unknown) => (error as { status: number }).status === 410);
      } finally { Date.now = now; }
    } finally { await fs.rm(archive.tempDirectory, { recursive: true, force: true }); }
    console.log('PASS: prepared archives remain user/session/workspace bound, single-use and expiring; central native archive contract completed first.');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
