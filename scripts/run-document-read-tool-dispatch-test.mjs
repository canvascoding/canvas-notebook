/** Run a bounded document-authority integration suite as one real-source ESM graph. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const entryPoint = process.argv[2] ?? 'scripts/document-read-tool-dispatch-postgres-test.ts';
const criticalInputsByEntryPoint = {
  'scripts/document-create-mutation-result-contracts-test.ts': [entryPoint,
    'app/lib/documents/create-mutation-result.ts', 'app/lib/documents/create-mutation-result-json-schema.ts',
    'app/lib/documents/contracts.ts', 'app/lib/documents/read-version.ts', 'app/lib/documents/read-json-schema.ts',
    'app/lib/collaboration/state-proof.ts', 'app/lib/workspaces/path-identity.ts', 'app/lib/files/display-name.ts'],
  'scripts/direct-mcp-native-markdown-create-postgres-test.ts': [entryPoint,
    'app/lib/documents/create-mutation-result.ts',
    'app/lib/documents/contracts.ts', 'app/lib/documents/read-version.ts',
    'scripts/helpers/document-read-tool-dispatch-fixture.ts', 'app/lib/collaboration/markdown-file-import-persistence.ts',
    'app/lib/mcp/server/ingest-tools.ts', 'app/lib/mcp/server/file-ingest.ts', 'app/lib/mcp/server/ingest-authority.ts',
    'app/lib/mcp/server/ingest-validation.ts', 'app/lib/mcp/server/streamable-http.ts', 'app/lib/mcp/server/direct-server.ts',
    'app/lib/mcp/server/ingest-download.ts', 'app/lib/security/safe-external-fetch.ts', 'app/lib/document-review-availability.ts',
    'app/lib/mcp/server/document-read-principal.ts', 'app/lib/files/markdown-create-birth.ts',
    'app/lib/documents/service.ts', 'app/lib/documents/read-json-schema.ts', 'app/lib/file-version-center/history-service.ts',
    'app/lib/files/workspace-file-lifecycle-guard.ts', 'app/lib/secrets/file-mutation-lock.ts',
    'app/lib/db/index.ts', 'scripts/run-yjs-authority-e2e.ts'],
  'scripts/manual-markdown-create-birth-entry-test.ts': [entryPoint,
    'app/lib/files/markdown-create-birth.ts', 'app/lib/collaboration/markdown-file-import-persistence.ts'],
  'scripts/authenticated-markdown-first-projection-postgres-test.ts': [entryPoint,
    'app/lib/files/markdown-create-birth.ts', 'app/lib/collaboration/markdown-file-import-persistence.ts', 'app/lib/db/index.ts'],
  'scripts/authenticated-manual-markdown-create-postgres-test.ts': [entryPoint,
    'app/lib/files/markdown-create-birth.ts', 'app/lib/collaboration/markdown-file-import-persistence.ts', 'app/lib/db/index.ts'],
  'scripts/direct-mcp-document-create-principal-postgres-test.ts': [entryPoint,
    'scripts/helpers/document-read-tool-dispatch-fixture.ts', 'app/lib/mcp/server/document-read-principal.ts',
    'app/lib/mcp/server/access-token-verifier.ts', 'app/lib/mcp/server/runtime-settings.ts',
    'app/lib/mcp/server/config.ts', 'app/lib/workspaces/postgres-runtime.ts', 'app/lib/workspaces/permissions.ts',
    'app/lib/license/seat-limit.ts', 'app/lib/db/index.ts'],
  'scripts/direct-mcp-document-read-principal-postgres-test.ts': [entryPoint,
    'app/lib/mcp/server/document-read-principal.ts', 'app/lib/mcp/server/access-token-verifier.ts',
    'app/lib/mcp/server/runtime-settings.ts', 'app/lib/workspaces/postgres-runtime.ts', 'app/lib/db/index.ts'],
  'scripts/public-share-create-postgres-test.ts': [entryPoint, 'app/lib/public-sharing/writer.ts',
    'app/lib/public-sharing/public-file-shares.ts', 'app/lib/public-sharing/tool-policy.ts',
    'app/lib/workspaces/request-principal.ts', 'app/lib/pi/agent-tool-invocation.ts',
    'app/api/security/public-shares/route.ts', 'app/api/mobile/v1/files/shares/route.ts', 'app/lib/db/index.ts'],
  'scripts/public-share-revocation-postgres-test.ts': [entryPoint, 'app/lib/public-sharing/writer.ts',
    'app/lib/public-sharing/public-file-shares.ts', 'app/lib/public-sharing/tool-policy.ts',
    'app/lib/workspaces/request-principal.ts', 'app/lib/pi/agent-tool-invocation.ts',
    'app/lib/files/workspace-side-effect-writer-fence.ts', 'app/api/security/public-shares/[id]/route.ts', 'app/lib/db/index.ts'],
  'scripts/collaboration-native-snapshot-test.ts': [entryPoint, 'app/lib/collaboration/checkpoint.ts',
    'app/lib/collaboration/document-access.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/collaboration/native-search-budget.ts', 'app/lib/collaboration/markdown-state.ts'],
  'scripts/workspace-native-search-test.ts': [entryPoint, 'app/lib/collaboration/workspace-search-reader.ts',
    'app/lib/collaboration/native-search-budget.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/collaboration/workspace-document-catalogue.ts'],
  'scripts/collaboration-search-room-census-test.ts': [entryPoint, 'app/lib/collaboration/search-room-census.ts'],
  'scripts/native-document-read-postgres-test.ts': [entryPoint, 'app/lib/collaboration/native-document-read.ts',
    'app/lib/collaboration/native-search-budget.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/workspaces/request-principal.ts', 'app/lib/db/index.ts'],
  'scripts/document-read-service-postgres-test.ts': [entryPoint, 'app/api/documents/read/route.ts',
    'app/lib/documents/service.ts', 'app/lib/collaboration/native-document-read.ts',
    'app/lib/collaboration/native-search-budget.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/collaboration/workspace-search-reader.ts', 'app/lib/workspaces/request-principal.ts', 'app/lib/db/index.ts'],
  'scripts/mcp-native-search-routing-test.ts': [entryPoint, 'app/lib/collaboration/workspace-search-reader.ts',
    'app/lib/collaboration/native-search-budget.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/mcp/server/file-links.ts', 'app/lib/mcp/server/document-search-tool-contract.ts',
    'app/lib/documents/search-contract.ts'],
  'scripts/native-document-search-contract-test.ts': [entryPoint, 'app/lib/documents/search-contract.ts',
    'app/lib/collaboration/native-search-budget.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/collaboration/workspace-search-reader.ts'],
  'scripts/native-document-search-service-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/api/documents/search/route.ts', 'app/lib/documents/service.ts', 'app/lib/documents/search-contract.ts',
    'app/lib/documents/search-json-schema.ts', 'app/lib/collaboration/native-document-search.ts',
    'app/lib/collaboration/native-search-budget.ts', 'app/lib/collaboration/native-document-read.ts',
    'app/lib/collaboration/document-snapshot.ts', 'app/lib/collaboration/workspace-search-reader.ts',
    'app/lib/collaboration/workspace-document-catalogue.ts', 'app/lib/collaboration/search-room-census.ts',
    'app/lib/workspaces/request-principal.ts', 'app/lib/db/index.ts'],
  'scripts/native-document-search-room-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'server/collaboration-server.ts', 'app/lib/collaboration/room-owner.ts', 'app/lib/collaboration/room-owner-runtime.ts',
    'app/lib/collaboration/search-room-census.ts', 'app/lib/documents/service.ts', 'app/lib/documents/search-contract.ts',
    'app/lib/collaboration/native-document-search.ts', 'app/lib/collaboration/native-search-budget.ts',
    'app/lib/collaboration/native-document-read.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/collaboration/workspace-search-reader.ts', 'app/lib/collaboration/workspace-document-catalogue.ts',
    'app/lib/workspaces/request-principal.ts', 'app/lib/db/index.ts'],
  'scripts/document-search-tool-dispatch-postgres-test.ts': [entryPoint, 'scripts/helpers/document-read-tool-dispatch-fixture.ts',
    'app/lib/documents/service.ts', 'app/lib/documents/search-contract.ts', 'app/lib/documents/search-json-schema.ts',
    'app/lib/collaboration/native-document-search.ts', 'app/lib/collaboration/native-search-budget.ts',
    'app/lib/collaboration/native-document-read.ts', 'app/lib/collaboration/document-snapshot.ts',
    'app/lib/collaboration/workspace-search-reader.ts', 'app/lib/collaboration/search-room-census.ts',
    'app/lib/collaboration/workspace-document-catalogue.ts',
    'app/lib/pi/document-search-tool.ts', 'app/lib/pi/document-search-tool-contract.ts', 'app/lib/pi/core-tools.ts',
    'app/lib/pi/tool-registry.ts', 'app/lib/pi/tool-runtime-helpers.ts', 'app/lib/pi/agent-tool-invocation.ts',
    'app/lib/pi/toolsets.ts', 'app/lib/pi/planning-mode.ts', 'app/lib/public-sharing/tool-policy.ts',
    'app/lib/workspaces/request-principal.ts', 'app/lib/mcp/server/streamable-http.ts', 'app/lib/mcp/server/direct-server.ts',
    'app/lib/mcp/server/workspace-tools.ts', 'app/lib/mcp/server/document-search-tool-contract.ts',
    'app/lib/mcp/server/document-read-principal.ts', 'app/lib/db/index.ts'],
  'scripts/file-collaboration-strict-cleanup-test.ts': [entryPoint,
    'app/lib/files/collaboration-repository/transaction.ts', 'app/lib/files/workspace-file-lifecycle-guard.ts',
    'app/lib/excalidraw-collaboration/lifecycle-availability.ts'],
  'scripts/excalidraw-read-admission-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/excalidraw-collaboration/scene-service.ts', 'app/lib/excalidraw-collaboration/lifecycle-availability.ts',
    'app/lib/excalidraw-collaboration/portable-import.ts', 'app/lib/files/workspace-file-lifecycle-guard.ts',
    'app/lib/files/collaboration-repository/transaction.ts', 'app/lib/collaboration/room-admission-contract.ts',
    'app/lib/workspaces/postgres-runtime.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-document-tree-test.ts': [entryPoint, 'app/lib/files/workspace-document-tree.ts',
    'app/lib/collaboration/workspace-native-file-read.ts', 'app/lib/collaboration/workspace-document-catalogue.ts',
    'app/lib/collaboration/workspace-scene-catalogue.ts'],
  'scripts/workspace-native-file-read-test.ts': [entryPoint, 'app/lib/collaboration/workspace-native-file-read.ts',
    'app/lib/collaboration/workspace-document-catalogue.ts'],
  'scripts/native-file-event-test.ts': [entryPoint, 'app/lib/collaboration/workspace-native-file-read.ts',
    'app/lib/collaboration/workspace-document-catalogue.ts', 'app/lib/filesystem/native-file-event.ts'],
  'scripts/native-docx-file-read-postgres-test.ts': [entryPoint, 'app/lib/collaboration/workspace-native-file-read.ts',
    'app/lib/files/collaboration-repository/index.ts', 'app/lib/office/document-service.ts',
    'app/lib/filesystem/workspace-files.ts', 'app/lib/db/index.ts'],
  'scripts/document-read-tool-dispatch-postgres-test.ts': [entryPoint, 'scripts/helpers/document-read-tool-dispatch-fixture.ts',
    'app/lib/pi/tool-registry.ts', 'app/lib/pi/agent-tool-invocation.ts',
    'app/lib/documents/service.ts', 'app/lib/mcp/server/streamable-http.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-scene-catalogue-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/collaboration/workspace-scene-catalogue.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-scene-tree-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/collaboration/workspace-native-file-read.ts', 'app/lib/collaboration/workspace-document-catalogue.ts',
    'app/lib/collaboration/workspace-scene-catalogue.ts', 'app/lib/files/workspace-document-tree.ts', 'app/lib/db/index.ts'],
  'scripts/excalidraw-lifecycle-availability-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/excalidraw-collaboration/lifecycle-availability.ts', 'app/lib/excalidraw-collaboration/scene-service.ts',
    'app/lib/excalidraw-collaboration/portable-import.ts', 'app/lib/files/workspace-file-lifecycle-guard.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-scene-snapshot-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/excalidraw-collaboration/workspace-scene-snapshot.ts',
    'app/lib/excalidraw-collaboration/readonly-assets.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-managed-copy-plan-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-managed-copy-plan.ts', 'app/lib/files/workspace-operation-copy-source-evidence.ts',
    'app/lib/files/workspace-operation-copy-source-observation.ts',
    'app/lib/excalidraw-collaboration/workspace-scene-snapshot.ts', 'app/lib/excalidraw-collaboration/readonly-assets.ts',
    'app/lib/markdown/workspace-native-mixed-batch-compiler.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-managed-copy-stage-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/excalidraw-collaboration/portable-serialization.ts', 'app/lib/excalidraw-collaboration/readonly-assets.ts',
    'app/lib/filesystem/prepared-workspace-path-copy.ts', 'app/lib/filesystem/prepared-workspace-path-copy-contract.ts',
    'app/lib/files/workspace-operation-native-copy-metadata.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-managed-copy-assets-owner-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-phase.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/excalidraw-collaboration/copy-domain.ts',
    'app/lib/excalidraw-collaboration/copy-asset-publication.ts', 'app/lib/db/excalidraw-copy-migration.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-managed-copy-shared-parent-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-managed-copy-scene-only-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/files/workspace-operation-native-copy-phase.ts', 'app/lib/files/workspace-operation-native-copy-phase-contract.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/excalidraw-collaboration/copy-domain.ts',
    'app/lib/excalidraw-collaboration/copy-asset-publication.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-managed-copy-owner-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-phase.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-native-copy-phase-read.ts',
    'app/lib/excalidraw-collaboration/copy-domain.ts', 'app/lib/excalidraw-collaboration/copy-history.ts',
    'app/lib/excalidraw-collaboration/copy-asset-publication.ts', 'app/lib/db/excalidraw-copy-migration.ts',
    'app/lib/collaboration/native-copy-persistence.ts', 'app/lib/filesystem/prepared-workspace-path-copy.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-operation-native-copy-views-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-phase.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-copy-view-finalizer.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/excalidraw-collaboration/copy-domain.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-operation-native-copy-owner-postgres-test.ts': [entryPoint,
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-phase.ts',
    'app/lib/files/workspace-operation-staging.ts', 'app/lib/files/workspace-operation-native-copy-stage.ts',
    'app/lib/collaboration/native-copy-persistence.ts', 'app/lib/filesystem/prepared-workspace-path-copy.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-operation-native-copy-metadata-owner-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-metadata.ts',
    'app/lib/files/workspace-operation-staging.ts', 'app/lib/files/workspace-operation-native-copy-stage.ts', 'app/lib/db/index.ts'],
  'scripts/workspace-native-copy-reader-contention-postgres-test.ts': [entryPoint, 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-file-operation-service.ts', 'app/lib/files/workspace-operation-native-copy-owner.ts',
    'app/lib/collaboration/workspace-native-file-read.ts', 'app/lib/db/index.ts'],
};
assert(Object.hasOwn(criticalInputsByEntryPoint, entryPoint), 'Unknown document-authority integration suite.');
const criticalInputs = criticalInputsByEntryPoint[entryPoint];
let stage = 'preflight';
let temporaryDirectory;
let temporaryIdentity;
let canonicalTemporaryDirectory;
let modulesIdentity;
let canonicalModulesTarget;
let esbuild;
let compilerStopped = false;
let outcome;
let primaryFailure;
let cleanupFailure;

function diagnostic(error) {
  return { stage, name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : null };
}

async function removeOwnTemporaryDirectory() {
  const current = await fs.lstat(temporaryDirectory);
  assert(current.isDirectory() && !current.isSymbolicLink());
  assert.equal(current.dev, temporaryIdentity.dev);
  assert.equal(current.ino, temporaryIdentity.ino);
  assert.equal(current.uid, temporaryIdentity.uid);
  if (process.getuid) assert.equal(current.uid, process.getuid());
  assert.equal(current.mode & 0o777, 0o700);
  assert.equal(await fs.realpath(temporaryDirectory), canonicalTemporaryDirectory);
  const modules = path.join(temporaryDirectory, 'node_modules');
  if (modulesIdentity) {
    const link = await fs.lstat(modules);
    assert(link.isSymbolicLink());
    assert.equal(link.dev, modulesIdentity.dev);
    assert.equal(link.ino, modulesIdentity.ino);
    assert.equal(link.uid, temporaryIdentity.uid);
    assert.equal(await fs.readlink(modules), path.join(root, 'node_modules'));
    assert.equal(await fs.realpath(modules), canonicalModulesTarget);
    await fs.unlink(modules);
  }
  const ownedFiles = new Set(['dispatch.mjs', 'dispatch.mjs.map', 'bundle-meta.json']);
  for (const name of await fs.readdir(temporaryDirectory)) {
    assert(ownedFiles.has(name), 'Unexpected entry in the owned integration bundle directory.');
    const file = await fs.lstat(path.join(temporaryDirectory, name));
    assert(file.isFile() && !file.isSymbolicLink());
    assert.equal(file.uid, temporaryIdentity.uid);
  }
  const finalIdentity = await fs.lstat(temporaryDirectory);
  assert.equal(finalIdentity.dev, temporaryIdentity.dev);
  assert.equal(finalIdentity.ino, temporaryIdentity.ino);
  assert.equal(finalIdentity.uid, temporaryIdentity.uid);
  await fs.rm(temporaryDirectory, { recursive: true, force: false });
}

try {
  assert.equal(process.env.NODE_ENV, 'test', 'Run with NODE_ENV=test; the runner does not replace the caller environment.');
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 22 or newer is required.');
  assert(!/(?:^|\s)(?:--conditions|-C)(?:=|\s|$)/u.test(process.env.NODE_OPTIONS ?? ''),
    'NODE_OPTIONS must not add import conditions; the child uses react-server only.');
  assert(!process.execArgv.some(argument => argument === '--conditions' || argument.startsWith('--conditions=')
    || argument === '-C' || argument.startsWith('-C=')),
    'Invoke this runner without extra import conditions.');
  esbuild = requireFromRoot('esbuild');
  const parent = await fs.realpath(tmpdir());
  temporaryDirectory = await fs.mkdtemp(path.join(parent, 'canvas-document-read-tool-dispatch-bundle-'));
  temporaryIdentity = await fs.lstat(temporaryDirectory);
  assert(temporaryIdentity.isDirectory() && !temporaryIdentity.isSymbolicLink());
  if (process.getuid) assert.equal(temporaryIdentity.uid, process.getuid());
  await fs.chmod(temporaryDirectory, 0o700);
  canonicalTemporaryDirectory = await fs.realpath(temporaryDirectory);
  assert.equal(path.dirname(canonicalTemporaryDirectory), parent);
  canonicalModulesTarget = await fs.realpath(path.join(root, 'node_modules'));
  const modules = path.join(temporaryDirectory, 'node_modules');
  await fs.symlink(path.join(root, 'node_modules'), modules, 'dir');
  modulesIdentity = await fs.lstat(modules);
  assert(modulesIdentity.isSymbolicLink());
  assert.equal(modulesIdentity.uid, temporaryIdentity.uid);

  stage = 'bundle';
  const bundle = path.join(temporaryDirectory, 'dispatch.mjs');
  const resolvedNext = [], resolvedConstructorPackages = [];
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: [entryPoint], outfile: bundle,
    bundle: true, format: 'esm', platform: 'node', target: 'node22',
    packages: 'external', splitting: false, metafile: true, sourcemap: 'external',
    tsconfig: path.join(root, 'tsconfig.json'), conditions: ['react-server'],
    banner: { js: 'import {createRequire as __canvasCreateRequire} from "node:module";const require=__canvasCreateRequire('
      + JSON.stringify(path.join(root, 'package.json')) + ');' },
    plugins: [{
      name: 'actual-next-and-commonjs-constructor-entries',
      setup(build) {
        build.onResolve({ filter: /^next\// }, args => {
          const actual = requireFromRoot.resolve(args.path);
          resolvedNext.push({ request: args.path, path: actual });
          return { path: actual, external: true };
        });
        build.onResolve({ filter: /^(?:@tiptap\/|@hocuspocus\/|prosemirror-|yjs$|y-prosemirror$)/ }, args => {
          const actual = requireFromRoot.resolve(args.path);
          resolvedConstructorPackages.push({ request: args.path, path: actual });
          return { path: actual, namespace: 'actual-cjs-constructor-entry' };
        });
        build.onResolve({ filter: /.*/, namespace: 'actual-cjs-constructor-entry' }, args => ({ path: args.path, external: true }));
        build.onLoad({ filter: /.*/, namespace: 'actual-cjs-constructor-entry' }, args => ({
          contents: 'module.exports = require(' + JSON.stringify(args.path) + ');', loader: 'js', resolveDir: root,
        }));
      },
    }],
  });
  await esbuild.stop();
  compilerStopped = true;

  stage = 'verify-bundle';
  const inputs = Object.keys(result.metafile.inputs);
  for (const expected of criticalInputs) {
    assert.equal(inputs.filter(input => path.resolve(root, input) === path.join(root, expected)).length, 1,
      `The bundle must contain the actual source exactly once: ${expected}`);
  }
  assert.equal(Object.values(result.metafile.outputs).filter(output => output.entryPoint).length, 1);
  const sourceInputCount = inputs.length;
  const bundleSha256 = createHash('sha256').update(await fs.readFile(bundle)).digest('hex');
  const meta = path.join(temporaryDirectory, 'bundle-meta.json');
  await fs.writeFile(meta, JSON.stringify({
    kind: 'real-source-esm-document-read-tool-dispatch', esbuildVersion: esbuild.version,
    sourceInputCount, bundleSha256,
    options: { bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external',
      splitting: false, conditions: ['react-server'] },
    resolvedNext, resolvedConstructorPackages, metafile: result.metafile,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const file of [bundle, `${bundle}.map`, meta]) {
    await fs.chmod(file, 0o600);
    const identity = await fs.lstat(file);
    assert(identity.isFile() && !identity.isSymbolicLink());
    assert.equal(identity.uid, temporaryIdentity.uid);
    assert.equal(identity.mode & 0o777, 0o600);
  }
  console.log('DOCUMENT_READ_TOOL_DISPATCH_BUNDLE', JSON.stringify({ sourceInputCount, bundleSha256 }));

  stage = 'test';
  outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=react-server', bundle], {
      cwd: root, env: { ...process.env }, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
} catch (error) {
  primaryFailure = diagnostic(error);
} finally {
  if (esbuild && !compilerStopped) {
    try { await esbuild.stop(); compilerStopped = true; }
    catch (error) { cleanupFailure ??= { ...diagnostic(error), stage: 'stop-compiler' }; }
  }
  if (temporaryDirectory && temporaryIdentity) {
    try {
      await removeOwnTemporaryDirectory();
      console.log('DOCUMENT_READ_TOOL_DISPATCH_CLEANUP', JSON.stringify({ removed: true, temporaryDirectory }));
    } catch (error) {
      cleanupFailure ??= { ...diagnostic(error), stage: 'cleanup' };
      console.error('DOCUMENT_READ_TOOL_DISPATCH_CLEANUP', JSON.stringify({ removed: false, temporaryDirectory }));
    }
  }
}

if (primaryFailure) console.error('DOCUMENT_READ_TOOL_DISPATCH_RUNNER_FAILED', JSON.stringify(primaryFailure));
if (cleanupFailure) console.error('DOCUMENT_READ_TOOL_DISPATCH_RUNNER_CLEANUP_FAILED', JSON.stringify(cleanupFailure));
if (outcome?.signal) {
  // Cleanup completes before reproducing the actual child's terminating signal.
  process.kill(process.pid, outcome.signal);
  process.exitCode = 1;
} else if (typeof outcome?.code === 'number' && outcome.code !== 0) {
  process.exitCode = outcome.code;
} else if (primaryFailure || cleanupFailure || outcome?.code !== 0) {
  process.exitCode = 1;
}
