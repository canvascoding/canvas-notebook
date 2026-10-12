import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { WriteWorkspaceFileContentInput } from '../app/lib/files/write-service';
import type { DirectMcpAccessPrincipal } from '../app/lib/mcp/server/access-token-verifier';
import { validateDirectMcpIngestContent } from '../app/lib/mcp/server/ingest-validation';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const sha256 = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

test('private MCP ingest journal protects create-only publication and durable retries', async (suite) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-file-ingest-'));
  await fs.chmod(dataRoot, 0o700);
  const previousEnv = Object.fromEntries(['DATA', 'CANVAS_DATA_ROOT', 'BASE_URL', 'BETTER_AUTH_BASE_URL']
    .map(key => [key, process.env[key]]));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.BASE_URL = 'http://127.0.0.1:3000';
  process.env.BETTER_AUTH_BASE_URL = process.env.BASE_URL;
  const workspace: WorkspaceContext = {
    workspaceId: `mcp-ingest-${randomUUID()}`, workspaceType: 'personal',
    rootPath: path.join(dataRoot, 'workspace'), legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true },
  };
  await fs.mkdir(workspace.rootPath, { mode: 0o700 });
  const principal: DirectMcpAccessPrincipal = {
    subject: 'ingest-user', userId: 'ingest-user', clientId: 'ingest-client', clientName: 'Ingest test',
    sessionId: 'ingest-session', issuer: `${process.env.BASE_URL}/api/auth`,
    audience: `${process.env.BASE_URL}/mcp`, scopes: ['knowledge:write'],
    issuedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, payload: {},
  };
  let writes = 0;
  const activeRevisions = new Map<string, string>();
  const writerInputs: WriteWorkspaceFileContentInput[] = [];
  let afterPublication: (() => Promise<void>) | undefined;
  mock.module('@/app/lib/files/collaboration-policy', { exports: {
    readFileCollaborationState: async (input: { workspace: WorkspaceContext; path: string }) => {
      assert.equal(input.workspace.workspaceId, workspace.workspaceId);
      const id = activeRevisions.get(input.path);
      return { latestRevision: id ? { id } : null };
    },
  } });
  mock.module('@/app/lib/files/write-service', { exports: {
    // Keep all filesystem resolution, revision hashes, journals and kernel
    // locks real. Only the database/version publication service is replaced.
    writeWorkspaceFileContent: async (input: WriteWorkspaceFileContentInput) => {
      writerInputs.push(input);
      input.signal?.throwIfAborted();
      await input.beforePublish?.();
      input.signal?.throwIfAborted();
      assert.equal(input.createOnly, true);
      await fs.writeFile(path.join(input.workspace.rootPath, input.path), input.content, { flag: 'wx', mode: 0o600 });
      writes += 1;
      activeRevisions.set(input.path, `revision-${writes}`);
      await afterPublication?.();
      return { revision: { id: `revision-${writes}` } };
    },
  } });
  try {
    const { createDirectMcpWorkspaceFile, directMcpIngestFingerprint, normalizeDirectMcpIngestPath } =
      await import('../app/lib/mcp/server/file-ingest');
    const hasCode = (code: string) => (error: unknown) =>
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
    const destination = (filePath: string) => path.join(workspace.rootPath, filePath);
    const recordPath = (key: string, identity = principal) => path.join(dataRoot, 'system', 'mcp-file-ingest',
      `${directMcpIngestFingerprint([identity.clientId, identity.userId, workspace.workspaceId, key])}.json`);
    const request = (filePath: string, content: string, key: string = randomUUID(), source: 'generated' | 'uploaded' = 'generated') => {
      let loads = 0;
      let checks = 0;
      const input = {
        principal, workspace, path: filePath, idempotencyKey: key,
        fingerprint: directMcpIngestFingerprint({ path: filePath, content, source }),
        loadContent: async () => {
          loads += 1;
          const bytes = Buffer.from(content);
          return { content: bytes, validation: await validateDirectMcpIngestContent({ path: filePath, content: bytes, source }) };
        },
        verifyAuthority: async () => { checks += 1; },
      };
      return { input, key, loads: () => loads, checks: () => checks };
    };

    await suite.test('a complete original Markdown file receives a verified hash and private durable receipt', async () => {
      const original = '\uFEFF# Imported\r\n\r\nA **bold** paragraph.\r\n';
      const item = request('notes/original.md', original, 'original-request', 'uploaded');
      const receipt = await createDirectMcpWorkspaceFile(item.input);
      assert.equal(receipt.status, 'created');
      assert.equal(receipt.sha256, sha256(original));
      assert.equal(receipt.size, Buffer.byteLength(original));
      assert.equal(receipt.mime_type, 'text/markdown');
      assert.ok(receipt.markdown);
      assert.equal(receipt.revision_id, `revision-${writes}`);
      assert.equal(receipt.workspace_id, workspace.workspaceId);
      assert.equal(receipt.path, item.input.path);
      const url = new URL(receipt.document_url);
      assert.equal(url.origin, process.env.BASE_URL);
      assert.equal(url.searchParams.get('workspaceId'), workspace.workspaceId);
      assert.equal(url.searchParams.get('path'), item.input.path);
      assert.deepEqual(await fs.readFile(destination(item.input.path)), Buffer.from(original));
      assert.equal(item.loads(), 1);
      assert.equal(item.checks(), 3, 'authority must be rechecked at actual publication');
      const writer = writerInputs.at(-1)!;
      assert.equal(writer.actorType, 'agent');
      assert.equal(writer.actorUserId, principal.userId);
      assert.equal(writer.versionSource, 'external_import');
      assert.equal(writer.idempotencyKey, receipt.operation_id);
      const journal = JSON.parse(await fs.readFile(recordPath(item.key), 'utf8'));
      assert.equal(journal.phase, 'completed');
      assert.equal(journal.receipt.sha256, receipt.sha256);
      assert.equal((await fs.stat(recordPath(item.key))).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(recordPath(item.key)))).mode & 0o777, 0o700);
    });

    await suite.test('concurrent calls and a later retry publish once and skip content loading', async () => {
      const item = request('concurrent.md', '# One publication\n', 'concurrent-request');
      const writesBefore = writes;
      const [first, second] = await Promise.all([createDirectMcpWorkspaceFile(item.input), createDirectMcpWorkspaceFile(item.input)]);
      assert.deepEqual([first.status, second.status].sort(), ['already_created', 'created']);
      assert.equal(first.operation_id, second.operation_id);
      assert.equal(first.revision_id, second.revision_id);
      assert.equal(item.loads(), 1);
      assert.equal(writes, writesBefore + 1);
      const retry = await createDirectMcpWorkspaceFile({ ...item.input,
        loadContent: async () => { throw new Error('A completed retry must not reload or download content.'); } });
      assert.deepEqual(retry, { ...first, status: 'already_created' });
      assert.equal(writes, writesBefore + 1);
    });

    await suite.test('same idempotency key with different content or path is a conflict before loading', async () => {
      const item = request('key-bound.md', '# Original\n', 'bound-key');
      await createDirectMcpWorkspaceFile(item.input);
      for (const changed of [request('key-bound.md', '# Different\n', item.key), request('different.md', '# Original\n', item.key)]) {
        await assert.rejects(createDirectMcpWorkspaceFile(changed.input), hasCode('MCP_INGEST_IDEMPOTENCY_CONFLICT'));
        assert.equal(changed.loads(), 0);
      }
      assert.equal(await fs.readFile(destination(item.input.path), 'utf8'), '# Original\n');
      await assert.rejects(fs.stat(destination('different.md')), hasCode('ENOENT'));
    });

    await suite.test('changed or deleted completed destinations reject retries without overwriting', async () => {
      const item = request('destination-changed.md', '# Original\n');
      await createDirectMcpWorkspaceFile(item.input);
      const writesBefore = writes;
      await fs.writeFile(destination(item.input.path), '# Human edit\n');
      await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('MCP_INGEST_DESTINATION_CHANGED'));
      assert.equal(await fs.readFile(destination(item.input.path), 'utf8'), '# Human edit\n');
      await fs.unlink(destination(item.input.path));
      await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('MCP_INGEST_DESTINATION_CHANGED'));
      assert.equal(item.loads(), 1);
      assert.equal(writes, writesBefore);
    });

    await suite.test('identical bytes in a recreated file lineage cannot adopt a completed receipt', async () => {
      const original = '# Identical bytes\n';
      const item = request('lineage-recreated.md', original, 'lineage-recreated-request');
      const receipt = await createDirectMcpWorkspaceFile(item.input);
      const writesBefore = writes;
      await fs.unlink(destination(item.input.path));
      activeRevisions.delete(item.input.path);
      await fs.writeFile(destination(item.input.path), original, { flag: 'wx' });
      activeRevisions.set(item.input.path, 'new-lineage-initial-revision');
      assert.equal(sha256(await fs.readFile(destination(item.input.path))), receipt.sha256);
      await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('MCP_INGEST_DESTINATION_CHANGED'));
      assert.equal(item.loads(), 1, 'a completed retry must not download or reload the original');
      assert.equal(writes, writesBefore);
      assert.equal(await fs.readFile(destination(item.input.path), 'utf8'), original);
    });

    await suite.test('an edited file restored to original bytes still rejects an obsolete receipt', async () => {
      const original = '# Restored original\n';
      const item = request('revision-restored.md', original, 'revision-restored-request');
      const receipt = await createDirectMcpWorkspaceFile(item.input);
      const writesBefore = writes;
      await fs.writeFile(destination(item.input.path), '# Human change\n');
      activeRevisions.set(item.input.path, 'human-change-revision');
      await fs.writeFile(destination(item.input.path), original);
      activeRevisions.set(item.input.path, 'human-restored-revision');
      assert.equal(sha256(await fs.readFile(destination(item.input.path))), receipt.sha256);
      await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('MCP_INGEST_DESTINATION_CHANGED'));
      assert.equal(item.loads(), 1);
      assert.equal(writes, writesBefore);
      assert.equal(activeRevisions.get(item.input.path), 'human-restored-revision');
      assert.equal(await fs.readFile(destination(item.input.path), 'utf8'), original);
    });

    await suite.test('an occupied destination is preserved before loading or creating a journal', async () => {
      const item = request('occupied.md', '# Imported\n');
      await fs.writeFile(destination(item.input.path), '# Existing\n');
      const writesBefore = writes;
      await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('MCP_INGEST_PATH_EXISTS'));
      assert.equal(await fs.readFile(destination(item.input.path), 'utf8'), '# Existing\n');
      assert.equal(item.loads(), 0);
      assert.equal(writes, writesBefore);
      await assert.rejects(fs.stat(recordPath(item.key)), hasCode('ENOENT'));
    });

    await suite.test('hidden, traversal and absolute destinations are blocked before reading input', async () => {
      for (const invalid of ['.env', ' .env', ' .private/note.md', 'notes/.private/file.md', '../outside.md', 'notes/../outside.md',
        '/absolute.md', 'notes//empty.md', 'notes\\..\\outside.md', 'C:\\outside.md', '.']) {
        assert.throws(() => normalizeDirectMcpIngestPath(invalid));
        const item = request(invalid, '# Invalid\n');
        await assert.rejects(createDirectMcpWorkspaceFile(item.input));
        assert.equal(item.loads(), 0);
        assert.equal(item.checks(), 0);
      }
    });

    await suite.test('symbolic file and directory aliases cannot publish inside or outside the workspace', async () => {
      const external = path.join(dataRoot, 'external');
      await fs.mkdir(external);
      await fs.writeFile(path.join(external, 'original.md'), '# Private external\n');
      await fs.symlink(external, destination('alias-directory'));
      await fs.symlink(path.join(external, 'original.md'), destination('alias.md'));
      for (const filePath of ['alias-directory/new.md', 'alias.md']) {
        const item = request(filePath, '# Attempted overwrite\n');
        await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('WORKSPACE_PATH_ALIAS'));
        assert.equal(item.loads(), 0);
      }
      assert.equal(await fs.readFile(path.join(external, 'original.md'), 'utf8'), '# Private external\n');
      await assert.rejects(fs.stat(path.join(external, 'new.md')), hasCode('ENOENT'));
    });

    await suite.test('revocation at beforePublish leaves a prepared private journal and no file', async () => {
      const item = request('revoked.md', '# Revoked\n');
      let checks = 0;
      const authority = async () => { if (++checks === 3) throw Object.assign(new Error('Grant revoked'), { code: 'GRANT_REVOKED' }); };
      const writesBefore = writes;
      await assert.rejects(createDirectMcpWorkspaceFile({ ...item.input, verifyAuthority: authority }), hasCode('GRANT_REVOKED'));
      assert.equal(checks, 3);
      assert.equal(writes, writesBefore);
      await assert.rejects(fs.stat(destination(item.input.path)), hasCode('ENOENT'));
      assert.equal(JSON.parse(await fs.readFile(recordPath(item.key), 'utf8')).phase, 'prepared');
      assert.equal((await fs.stat(recordPath(item.key))).mode & 0o777, 0o600);
      const recovered = await createDirectMcpWorkspaceFile(item.input);
      assert.equal(recovered.status, 'created', 'an unpublished prepared attempt can safely resume');
      assert.equal(recovered.sha256, sha256('# Revoked\n'));
    });

    await suite.test('a prepared retry cannot replace bytes that changed behind the same request fingerprint', async () => {
      const item = request('prepared-bound.md', '# Prepared original\n');
      await assert.rejects(createDirectMcpWorkspaceFile({ ...item.input, verifyAuthority: async () => {
        if ((await fs.stat(recordPath(item.key)).catch(() => null))) throw new Error('Stop after preparation');
      } }), /Stop after preparation/u);
      const changed = Buffer.from('# Changed download\n');
      const writesBefore = writes;
      await assert.rejects(createDirectMcpWorkspaceFile({ ...item.input, loadContent: async () => ({ content: changed,
        validation: await validateDirectMcpIngestContent({ path: item.input.path, content: changed, source: 'uploaded' }) }) }),
      hasCode('MCP_INGEST_IDEMPOTENCY_CONFLICT'));
      assert.equal(writes, writesBefore);
      await assert.rejects(fs.stat(destination(item.input.path)), hasCode('ENOENT'));
    });

    await suite.test('publication followed by a crash requires inspection and preserves the physical file', async () => {
      const item = request('crash.md', '# Published before crash\n');
      afterPublication = async () => { throw new Error('Simulated crash after file publication'); };
      try { await assert.rejects(createDirectMcpWorkspaceFile(item.input), /Simulated crash/u); }
      finally { afterPublication = undefined; }
      const writesBefore = writes;
      assert.equal(JSON.parse(await fs.readFile(recordPath(item.key), 'utf8')).phase, 'prepared');
      await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('MCP_INGEST_RECOVERY_REQUIRED'));
      assert.equal(item.loads(), 1);
      assert.equal(writes, writesBefore);
      assert.equal(await fs.readFile(destination(item.input.path), 'utf8'), '# Published before crash\n');
    });

    await suite.test('corrupt receipt journal fails closed without loading or publishing', async () => {
      const item = request('corrupt.md', '# Never published\n');
      await fs.writeFile(recordPath(item.key), '{broken', { mode: 0o600 });
      await assert.rejects(createDirectMcpWorkspaceFile(item.input), hasCode('MCP_INGEST_RECOVERY_REQUIRED'));
      assert.equal(item.loads(), 0);
      await assert.rejects(fs.stat(destination(item.input.path)), hasCode('ENOENT'));
    });
  } finally {
    mock.reset();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
