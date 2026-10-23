import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual existing owner/PG18/FD/metadata fixture only, not a browser or HTTP
// transport proof. Raw PNG/PDF bytes below are owned asset fixtures; they are
// never Markdown imports, fabricated native states or Scene capabilities.
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
async function nativeCopyHtmlAssetsOwnerPostgresTest(): Promise<void> {
  const files = ['scripts/workspace-operation-native-copy-html-assets-owner-postgres-test.ts',
    'scripts/workspace-operation-native-copy-html-assets-test.ts', 'scripts/workspace-operation-native-copy-html-b-test.ts',
    'scripts/workspace-operation-native-copy-html-owner-postgres-test.ts', 'scripts/helpers/native-copy-metadata-owner-fixture.ts',
    'app/lib/files/workspace-operation-managed-copy-plan-v6.ts', 'app/lib/files/workspace-operation-html-copy-stage.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-phase.ts',
    'app/lib/files/workspace-operation-native-copy-phase-contract.ts', 'app/lib/files/workspace-operation-native-copy-phase-read.ts',
    'app/lib/files/workspace-operation-native-copy-metadata.ts', 'app/lib/files/workspace-operation-native-copy-html-graph.ts',
    'app/lib/files/workspace-operation-native-copy-html-public.ts', 'app/lib/files/workspace-operation-native-copy-public.ts',
    'app/lib/files/workspace-operation-native-copy-html-link-receipt.ts', 'app/lib/files/workspace-operation-html-copy-observation.ts',
    'app/lib/files/workspace-operation-managed-copy-stage.ts', 'app/lib/files/workspace-operation-staging.ts',
    'app/lib/files/workspace-operation-mixed-source-evidence-v5.ts', 'app/lib/files/workspace-operation-native-source-evidence.ts',
    'app/lib/markdown/workspace-native-link-clone-v4.ts', 'app/lib/markdown/workspace-native-copy-link-updates-v4.ts',
    'app/lib/collaboration/native-copy-persistence.ts', 'app/lib/markdown/native-link-mutation-persistence.ts',
    'app/lib/files/workspace-file-metadata.ts', 'app/lib/files/workspace-file-metadata-contract.ts', 'app/lib/filesystem/file-version.ts',
    'app/lib/filesystem/prepared-workspace-path-copy.ts', 'app/lib/filesystem/prepared-workspace-path-copy-contract.ts'];
  const pins = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))])));
  console.log(JSON.stringify({ suite: 'native-copy-html-assets-owner', sourcePins: pins }));
  try {
    await withNativeCopyMetadataOwnerFixture(async h => {
      const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute } = await import('../app/lib/files/workspace-operation-native-copy-owner');
      const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
      const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
      const { WorkspaceOperationJournal } = await import('../app/lib/files/workspace-operation-journal');
      const { loadCollaborationStateOnConnection: load } = await import('../app/lib/collaboration/persistence');
      const { inspectPersistedDocumentLinksV4: inspect } = await import('../app/lib/markdown/workspace-native-link-inventory');
      const { workspaceOperationNativeCopyPublicPreview: project } = await import('../app/lib/files/workspace-operation-native-copy-public');
      const { updateWorkspaceFileMetadata } = await import('../app/lib/files/workspace-file-metadata');
      const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
      const store = new WorkspaceOperationStaging(), journal = new WorkspaceOperationJournal();
      const cases = [false, true].flatMap(mixed => [false, true].map(cross => ({ mixed, cross, folder: false })));
      cases.push({ mixed: true, cross: true, folder: true });
      for (const { mixed, cross, folder } of cases) {
        currentCase = `${mixed ? 'native+assets' : 'assets-only'}-${cross ? 'cross' : 'same'}-${folder ? 'folder' : 'files'}`;
        const suffix = crypto.randomUUID(), target = cross ? h.destination : h.source, prefix = `source-folder-${suffix}`;
        if (folder) await mkdir(path.join(h.source.rootPath, prefix), { mode: 0o700 });
        const png = folder ? `${prefix}/picture.png` : `picture-${suffix}.png`, pdf = folder ? `${prefix}/report.pdf` : `report-${suffix}.pdf`;
        const note = folder ? `${prefix}/note.md` : `note-${suffix}.md`, html = `unrelated-${suffix}.html`;
        const copiedPath = (sourcePath: string) => `copied-${sourcePath}`;
        const assetBytes = new Map([[png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])],
          [pdf, Buffer.from('%PDF-1.7\nOwned copy fixture\n%%EOF\n')]]);
        const htmlBytes = Buffer.from(`<p>Unrelated <a href="${png}">original asset</a></p>\n`);
        for (const [name, bytes] of [...assetBytes, [html, htmlBytes] as const]) {
          await writeFile(path.join(h.source.rootPath, name), bytes, { flag: 'wx', mode: 0o600 });
        }
        const native = mixed ? await h.upload(note, Buffer.from(`[Picture](${path.posix.basename(png)})\n\n[PDF](${path.posix.basename(pdf)})\n`)) : null;
        const sourcePaths = [...assetBytes.keys(), ...(mixed ? [note] : [])], targetPaths = sourcePaths.map(copiedPath);
        const selections = folder ? [{ sourcePath: prefix, destinationPath: copiedPath(prefix) }]
          : sourcePaths.map(sourcePath => ({ sourcePath, destinationPath: copiedPath(sourcePath) }));
        for (const sourcePath of sourcePaths) {
          if (assetBytes.has(sourcePath)) {
            // Real physical-file metadata branch: original request and current
            // lstat version; never invent a native registry/state for an asset.
            const expectedTarget = { version: 1, kind: 'filesystem', workspaceId: h.source.workspaceId, path: sourcePath,
              entryType: 'file', fileVersion: filesystemFileVersion(await lstat(path.join(h.source.rootPath, sourcePath))) };
            await updateWorkspaceFileMetadata(await h.request(h.source, 'owner'), { path: sourcePath, expectedTarget,
              title: `Original ${sourcePath}`, isFavorite: true, pinned: true });
            await updateWorkspaceFileMetadata(await h.request(h.source, 'member'), { path: sourcePath, expectedTarget,
              isFavorite: true, pinned: true });
          } else {
            await h.metadata(h.source, sourcePath, { title: `Original ${sourcePath}`, isFavorite: true, pinned: true }, 'owner');
            await h.metadata(h.source, sourcePath, { isFavorite: true, pinned: true }, 'member');
          }
        }
        const originalFilePins = await Promise.all([...assetBytes.keys(), html].map(async name => {
          const info = await lstat(path.join(h.source.rootPath, name));
          return { name, dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, gid: info.gid, size: info.size,
            mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, bytes: await readFile(path.join(h.source.rootPath, name)) };
        }));
        const sourceMetadata = async () => ({
          titles: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=ANY($2::text[]) ORDER BY path', [h.source.workspaceId, sourcePaths])).rows,
          personal: (await h.admin.query('SELECT *,xmin::text AS xmin FROM workspace_file_user_states WHERE workspace_id=$1 AND path=ANY($2::text[]) ORDER BY path,user_id', [h.source.workspaceId, sourcePaths])).rows,
        });
        const beforeMetadata = await sourceMetadata();
        const nativeState = async () => native ? (await h.admin.query('SELECT d.*,d.xmin::text AS d_xmin,s.*,s.xmin::text AS s_xmin FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1', [native.documentId])).rows : [];
        const beforeNative = await nativeState();
        const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'owner', actorId: 'owner', sessionId: 'session-owner' },
          sourceWorkspace: h.source, destinationWorkspace: target });
        const plan = await preview({ origin, request: await h.request(h.source, 'owner'), selections });
        assert.equal(plan.version, 6); assert(plan.version === 6);
        assert.equal(plan.cloneRequirements.length, mixed ? 1 : 0); assert.equal(plan.sceneCopyRequirements.length, 0);
        const publicPlan = project(plan); assert.equal(publicPlan.version, 5); assert.equal(publicPlan.coverage.complete, false); assert.equal(publicPlan.linkAssessment?.complete, true);
        const operationId = crypto.randomUUID(), input = async () => ({ origin, request: await h.request(h.source, 'owner'), selections,
          operationId, expectedPlanId: plan.planId });
        const result = await execute(await input()); assert.equal(result.execution.status, 'complete');
        assert.deepEqual(result.execution.pendingSteps, []); assert.equal((await journal.get(operationId))?.status, 'completed');
        const ledger = async () => (await h.admin.query('SELECT publication_status,publication_fingerprint,private_result,created_at,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
        const birth = await ledger(); assert(birth); assert.equal(birth.publication_status, 'published');
        assert.equal(birth.private_result.documents.length, mixed ? 1 : 0);
        const steps = (await h.admin.query('SELECT step_key,phase,receipt_json,xmin::text AS xmin FROM workspace_file_operation_steps WHERE operation_id=$1 ORDER BY step_key', [operationId])).rows;
        const completion = steps.find(row => row.step_key === 'copy-completion'); assert(completion);
        const proof = JSON.parse(completion.receipt_json); assert.equal(proof.version, 6);
        assert.equal(proof.stageDigest, birth.publication_fingerprint); assert.equal(proof.htmlAssessmentProof, plan.nativePathPlan.htmlAssessmentProof);
        assert.equal(proof.metadata.copyCreatedAt, Number(birth.created_at)); assert.equal(completion.xmin, birth.xmin);
        assert.equal(steps.filter(row => row.phase === 'link' && row.step_key !== 'copy-completion').length, mixed && !folder ? 1 : 0);
        for (const [name, bytes] of assetBytes) {
          const sourceInfo = originalFilePins.find(info => info.name === name)!;
          const copied = path.join(target.rootPath, copiedPath(name)), copiedInfo = await lstat(copied);
          assert(copiedInfo.isFile()); assert.equal(copiedInfo.isSymbolicLink(), false);
          assert.notEqual(`${copiedInfo.dev}:${copiedInfo.ino}`, `${sourceInfo.dev}:${sourceInfo.ino}`);
          assert.deepEqual(await readFile(copied), bytes);
          assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM collaboration_yjs_states s JOIN collaboration_documents d ON d.id=s.document_id WHERE d.workspace_id=$1 AND d.path=$2', [target.workspaceId, copiedPath(name)])).rows[0].n, 0);
        }
        if (native) {
          const receipt = birth.private_result.documents[0]; assert.equal(receipt.source.documentId, native.documentId);
          assert.notEqual(receipt.clone.documentId, native.documentId);
          const state = await load(h.connection, receipt.clone.documentId, true); assert(state); assert.equal(state.documentSequence, folder ? 0 : 1);
          assert.deepEqual(new Set(inspect(state).links.map(link => link.targetPathText)), new Set([path.posix.basename(copiedPath(png)), path.posix.basename(copiedPath(pdf))]));
        }
        const targetTitles = (await h.admin.query('SELECT path,title,xmin::text AS xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=ANY($2::text[]) ORDER BY path', [target.workspaceId, targetPaths])).rows;
        assert.equal(targetTitles.length, targetPaths.length);
        for (const row of targetTitles) { assert.equal(row.title, `Original ${row.path.slice('copied-'.length)}`); assert.equal(row.xmin, birth.xmin); }
        assert.equal((await h.admin.query('SELECT count(*)::integer AS n FROM workspace_file_user_states WHERE workspace_id=$1 AND path=ANY($2::text[])', [target.workspaceId, targetPaths])).rows[0].n, 0);
        assert.deepEqual(await sourceMetadata(), beforeMetadata); assert.deepEqual(await nativeState(), beforeNative);
        for (const pin of originalFilePins) {
          const actual = await lstat(path.join(h.source.rootPath, pin.name));
          assert.deepEqual({ dev: actual.dev, ino: actual.ino, mode: actual.mode, uid: actual.uid, gid: actual.gid,
            size: actual.size, mtimeMs: actual.mtimeMs, ctimeMs: actual.ctimeMs },
          { dev: pin.dev, ino: pin.ino, mode: pin.mode, uid: pin.uid, gid: pin.gid, size: pin.size, mtimeMs: pin.mtimeMs, ctimeMs: pin.ctimeMs });
          assert.deepEqual(await readFile(path.join(h.source.rootPath, pin.name)), pin.bytes);
        }
        assert.equal(await store.loadOwnedCopyByOperationId(operationId), null);
        const writes: string[] = [];
        const replay = await h.withProbe(async event => { if (/^\s*(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP)\b/iu.test(event.text)) writes.push(event.text); }, () => input().then(execute));
        assert.equal(replay.execution.status, 'complete'); assert.equal(replay.alreadyKnown, true); assert.equal(replay.plan, null);
        assert.deepEqual(writes, []); assert.deepEqual(await ledger(), birth);
        groups++; console.log(`PASS native-copy-html-assets-owner ${groups}: ${currentCase}`);
      }
      assert.equal(groups, 5);
    });
    completed = true;
    console.log(JSON.stringify({ suite: 'native-copy-html-assets-owner', groups, passed: true,
      scope: 'actual owner/PG18/FD/shared-title/history; no browser, HTTP transport, Scene or raw import claim' }));
  } finally { for (const file of files) assert.equal(sha(await readFile(file)), pins[file], `Source changed: ${file}`); }
}
nativeCopyHtmlAssetsOwnerPostgresTest().catch(error => {
  console.error(JSON.stringify({ suite: 'native-copy-html-assets-owner', failed: true, currentCase, groups,
    code: error && typeof error === 'object' && typeof Object.getOwnPropertyDescriptor(error, 'code')?.value === 'string' ? Object.getOwnPropertyDescriptor(error, 'code')!.value : null,
    name: error instanceof Error ? error.name : 'Unknown' })); process.exitCode = 1;
});
