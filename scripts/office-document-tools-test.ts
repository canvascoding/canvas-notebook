import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { runWithAgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createOfficeDocumentWorkflow, preserveOfficeDocumentDraftsBeforeScratchCleanup, type OfficeDocumentDependencies } from '../app/lib/pi/office-document-workflow';
import { createOfficeDocumentTools, OFFICE_DOCUMENT_TOOL_NAMES } from '../app/lib/pi/office-document-tools';
import { executeAgentSandboxedCommand } from '../app/lib/pi/agent-shell-sandbox';
import { buildAgentBashEnvironment, executeAgentBashCommand } from '../app/lib/pi/agent-bash-runtime';
import { clearAgentRuntimeTempDir, resolveAgentRuntimeTempDir } from '../app/lib/pi/agent-runtime-temp';
import { DOCX_PACKAGE_LIMITS } from '../app/lib/office/docx-package';
import { getPiToolsetsForTool, resolveDelegatedWorkerToolNames } from '../app/lib/pi/toolsets';
import { filterToolsForWorkspacePermissions } from '../app/lib/pi/workspace-tool-policy';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WriteWorkspaceFileContentInput } from '../app/lib/files/write-service';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(process.cwd(), '.office-document-tools-test-'));
  const beforeData = process.env.DATA;
  const beforeCanvas = process.env.CANVAS_DATA_ROOT;
  const beforeMaxBytes = process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES;
  const beforeMaxFiles = process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES;
  const data = path.join(fixture, 'data');
  const root = path.join(fixture, 'workspace');
  process.env.DATA = data;
  process.env.CANVAS_DATA_ROOT = data;
  try {
    await fs.mkdir(data, { recursive: true });
    await fs.mkdir(root, { recursive: true });
    const context: AgentExecutionContext = {
      userId: 'office-user', sessionId: 'office-session', agentId: 'office-agent',
      workspaceId: 'office-workspace', workspaceType: 'team', workspaceName: 'Office',
      organizationId: 'office-org', customerId: null, projectId: null,
      workspaceRoot: root, workspaceRootRelativePath: null,
      canWrite: true, canDelete: true, canShare: false, legacy: false,
    };
    const workspace: WorkspaceContext = {
      workspaceId: context.workspaceId, workspaceType: 'team', rootPath: root,
      organizationId: context.organizationId, legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true },
    };
    let authorized = true;
    let failure: 'none' | 'before' | 'after' = 'none';
    let beforePublish: (() => Promise<void>) | undefined;
    let publishedCount = 0;
    const calls: WriteWorkspaceFileContentInput[] = [];
    const leases = new Map<string, { id: string; expiresAt: number; lineageId: string; sessionId: string }>();
    const journal = new Map<string, { stats: { sha256: string; size: number }; revision: { id: string } }>();
    const policyError = (code: string, status: number) => Object.assign(new Error(code), { code, status });
    const read = (filePath: string) => fs.readFile(path.join(root, filePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const dependencies: OfficeDocumentDependencies = {
      async resolveAuthority(input) {
        if (!authorized) throw policyError('WORKSPACE_ACCESS_REVOKED', 403);
        return { context: input, workspace };
      },
      async canonicalPath(_workspace, filePath) {
        return path.relative(root, await fs.realpath(path.join(root, filePath)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return path.join(root, filePath);
          throw error;
        }));
      },
      async readSource(_workspace, filePath) { return read(filePath); },
      async ensureRevision(_workspace, filePath, buffer) { return { id: `revision-${sha(buffer)}`, lineageId: `lineage-${filePath}` }; },
      async acquire(_authority, filePath, _revision, leaseSessionId) {
        const current = leases.get(filePath);
        if (current && current.sessionId !== leaseSessionId) throw policyError('FILE_LOCKED', 423);
        const lease = current ?? { id: `lease-${randomUUID()}`, expiresAt: Date.now() + 900_000, lineageId: `lineage-${filePath}`, sessionId: leaseSessionId };
        leases.set(filePath, lease);
        return lease;
      },
      async renew(_authority, filePath, id, leaseSessionId) {
        const lease = leases.get(filePath);
        if (!lease || lease.id !== id || lease.sessionId !== leaseSessionId) throw policyError('FILE_LOCK_STALE', 423);
        lease.expiresAt += 60_000;
        return lease;
      },
      async release(_authority, filePath, id, leaseSessionId) {
        if (leases.get(filePath)?.id === id && leases.get(filePath)?.sessionId === leaseSessionId) leases.delete(filePath);
      },
      async publish(input) {
        calls.push(input);
        assert.equal(input.actorType, 'agent');
        assert.equal(input.actorUserId, context.userId);
        assert.match(input.actorSessionId || '', /^office-checkout-/);
        assert(input.idempotencyKey);
        const existing = journal.get(input.idempotencyKey);
        if (existing) return existing;
        if (failure === 'before') { failure = 'none'; throw new Error('Temporary database failure'); }
        await beforePublish?.();
        input.signal?.throwIfAborted();
        if (leases.get(input.path)?.id !== input.lockId || leases.get(input.path)?.sessionId !== input.actorSessionId) throw policyError('FILE_LOCK_STALE', 423);
        const before = await read(input.path);
        if (input.createOnly ? before !== null : !before || sha(before) !== input.expectedSha256) throw policyError('FILE_REVISION_CONFLICT', 409);
        const buffer = input.content as Buffer;
        await fs.writeFile(path.join(root, input.path), buffer);
        const published = { stats: { sha256: sha(buffer), size: buffer.length }, revision: { id: `saved-${++publishedCount}` } };
        journal.set(input.idempotencyKey, published);
        if (failure === 'after') { failure = 'none'; throw new Error('Lost acknowledgement after publication'); }
        return published;
      },
    };
    const workflow = createOfficeDocumentWorkflow(dependencies);
    const original = await docx('Original');
    const modified = await docx('Agent proposal');
    const newer = await docx('Another editor');
    const seed = async (name: string) => fs.writeFile(path.join(root, name), original);

    const quotaContext = { ...context, sessionId: 'office-quota-session' };
    const quotaScratch = resolveAgentRuntimeTempDir(quotaContext);
    await seed('quota.docx');
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = String(original.length - 1);
    await assert.rejects(workflow.checkout({ path: 'quota.docx' }, quotaContext), /temp quota exceeded/);
    assert.equal(leases.has('quota.docx'), false, 'a rejected checkout releases its exact lease');
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '1048576';
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES = '1';
    await fs.writeFile(path.join(quotaScratch, 'existing.txt'), 'occupied');
    await assert.rejects(workflow.checkout({ path: 'quota.docx' }, quotaContext), /files would exceed/);
    await clearAgentRuntimeTempDir(quotaScratch);
    const quotaCheckout = await workflow.checkout({ path: 'quota.docx' }, quotaContext);
    await fs.writeFile(quotaCheckout.workingPath, modified);
    await workflow.release(quotaCheckout.checkoutId, quotaContext);
    await assert.rejects(workflow.inspect({ checkoutId: quotaCheckout.checkoutId, restoreWorkingCopy: true }, quotaContext), /files would exceed/);
    assert.deepEqual(await fs.readFile(quotaCheckout.workingPath), modified, 'staging quota failure leaves the old working file untouched');
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES = '2';
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = String(modified.length * 2 - 1);
    await assert.rejects(workflow.inspect({ checkoutId: quotaCheckout.checkoutId, restoreWorkingCopy: true }, quotaContext), /bytes would exceed/);
    assert.deepEqual(await fs.readFile(quotaCheckout.workingPath), modified);
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = String(modified.length * 2);
    await workflow.inspect({ checkoutId: quotaCheckout.checkoutId, restoreWorkingCopy: true }, quotaContext);
    assert.deepEqual(await fs.readFile(quotaCheckout.workingPath), modified, 'exact atomic staging headroom is accepted');

    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES = '10000';
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '1048576';
    const recoveryContext = { ...context, sessionId: 'office-quota-recovery-session' };
    const recoveryScratch = resolveAgentRuntimeTempDir(recoveryContext);
    await seed('quota-recovery.docx');
    const quotaRecovery = await workflow.checkout({ path: 'quota-recovery.docx' }, recoveryContext);
    await fs.writeFile(quotaRecovery.workingPath, modified);
    failure = 'before';
    assert.equal((await workflow.commit(quotaRecovery.checkoutId, recoveryContext)).status, 'prepared');
    const recoveryManifestPath = path.join(data, 'office', 'checkouts', quotaRecovery.checkoutId, 'manifest.json');
    const beforeRecoveryManifest = JSON.parse(await fs.readFile(recoveryManifestPath, 'utf8'));
    await fs.writeFile(quotaRecovery.workingPath, newer);
    await fs.writeFile(path.join(recoveryScratch, 'oversized-intermediate.bin'), Buffer.alloc(8192));
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '4096';
    authorized = false;
    const preserved = await preserveOfficeDocumentDraftsBeforeScratchCleanup({ ...recoveryContext, canWrite: false }, recoveryScratch);
    authorized = true;
    assert.deepEqual(preserved, { checkoutIds: [quotaRecovery.checkoutId], bytes: newer.length });
    const afterRecoveryManifest = JSON.parse(await fs.readFile(recoveryManifestPath, 'utf8'));
    assert.equal(afterRecoveryManifest.recoveryDraftHash, sha(newer));
    delete afterRecoveryManifest.recoveryDraftHash;
    assert.deepEqual(afterRecoveryManifest, beforeRecoveryManifest, 'quota rescue must preserve prepared bytes, key, baseline, lease, status and error');
    await clearAgentRuntimeTempDir(recoveryScratch);
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '1048576';
    const restoredRecovery = await workflow.inspect({ checkoutId: quotaRecovery.checkoutId, restoreWorkingCopy: true }, recoveryContext);
    assert.equal(restoredRecovery.recoveryDraftSha256, sha(newer));
    assert.deepEqual(await fs.readFile(quotaRecovery.workingPath), newer, 'the latest edited working draft survives quota cleanup');
    assert.equal((await workflow.commit(quotaRecovery.checkoutId, recoveryContext)).status, 'committed');
    assert.equal(calls.at(-1)!.idempotencyKey, beforeRecoveryManifest.idempotencyKey);
    assert.deepEqual(calls.at(-1)!.content, modified, 'retry publishes the original prepared request, never the independently rescued draft');
    assert.deepEqual(await fs.readFile(quotaRecovery.workingPath), newer);
    await assert.rejects(preserveOfficeDocumentDraftsBeforeScratchCleanup({ ...recoveryContext, workspaceId: 'another-workspace' }, recoveryScratch), /belongs to another/);
    await assert.rejects(preserveOfficeDocumentDraftsBeforeScratchCleanup(recoveryContext, quotaScratch), /another session/);

    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (to === recoveryManifestPath) throw Object.assign(new Error('Recovery manifest fsync fixture failure'), { code: 'EIO' });
      return originalRename(from, to);
    };
    try {
      await assert.rejects(async () => {
        await preserveOfficeDocumentDraftsBeforeScratchCleanup(recoveryContext, recoveryScratch);
        await clearAgentRuntimeTempDir(recoveryScratch);
      }, /Recovery manifest/);
      assert.deepEqual(await fs.readFile(quotaRecovery.workingPath), newer, 'a failed durable rescue prevents destructive cleanup');
    } finally { fs.rename = originalRename; }

    await fs.unlink(quotaRecovery.workingPath);
    await fs.symlink(path.join(root, 'quota-recovery.docx'), quotaRecovery.workingPath);
    await assert.rejects(preserveOfficeDocumentDraftsBeforeScratchCleanup(recoveryContext, recoveryScratch), /ELOOP/);
    assert.deepEqual(await read('quota-recovery.docx'), modified);
    await fs.unlink(quotaRecovery.workingPath);
    await fs.writeFile(quotaRecovery.workingPath, newer);
    await fs.truncate(quotaRecovery.workingPath, DOCX_PACKAGE_LIMITS.compressedBytes + 1);
    await assert.rejects(preserveOfficeDocumentDraftsBeforeScratchCleanup(recoveryContext, recoveryScratch), /size limit/);
    assert.equal((await fs.stat(quotaRecovery.workingPath)).size, DOCX_PACKAGE_LIMITS.compressedBytes + 1);
    await fs.writeFile(quotaRecovery.workingPath, newer);
    const officeDir = path.join(recoveryScratch, 'office');
    await Promise.all(Array.from({ length: 1025 }, (_, index) => fs.writeFile(path.join(officeDir, `generated-${index}.tmp`), '')));
    await assert.rejects(preserveOfficeDocumentDraftsBeforeScratchCleanup(recoveryContext, recoveryScratch), /bounded checkout scan limit/);
    await clearAgentRuntimeTempDir(recoveryScratch);
    assert.deepEqual(await preserveOfficeDocumentDraftsBeforeScratchCleanup(recoveryContext, recoveryScratch), { checkoutIds: [], bytes: 0 });

    const runtimeContext = { ...context, sessionId: 'office-runtime-quota-session' };
    const runtimeScratch = resolveAgentRuntimeTempDir(runtimeContext);
    await seed('runtime-quota.docx');
    const runtimeCheckout = await workflow.checkout({ path: 'runtime-quota.docx' }, runtimeContext);
    const runtimeManifestPath = path.join(data, 'office', 'checkouts', runtimeCheckout.checkoutId, 'manifest.json');
    const overflowingCommand = (bytes: Buffer) => executeAgentBashCommand({
      command: `/usr/bin/python3 -I -B -c ${quote([
        'import base64, os',
        'from pathlib import Path',
        `Path(${JSON.stringify(runtimeCheckout.workingPath)}).write_bytes(base64.b64decode(${JSON.stringify(bytes.toString('base64'))}))`,
        'Path(os.environ["CANVAS_AGENT_TEMP_DIR"], "oversized-intermediate.bin").write_bytes(b"x" * 8192)',
      ].join('\n'))}`,
      cwd: runtimeScratch,
      workspaceDir: root,
      tempDir: runtimeScratch,
      env: buildAgentBashEnvironment({ sourceEnv: { ...process.env, NODE_ENV: 'test' }, workspaceDir: root, tempDir: runtimeScratch }),
      executionContext: runtimeContext,
    });
    const originalRm = fs.rm;
    let verifiedRecoveryBeforeCleanup = false;
    fs.rm = async (target, options) => {
      if (target === runtimeScratch && options?.recursive) {
        const rescued = JSON.parse(await fs.readFile(runtimeManifestPath, 'utf8'));
        assert.equal(rescued.recoveryDraftHash, sha(newer));
        assert.equal(rescued.status, 'checked_out');
        assert.deepEqual(await fs.readFile(path.join(path.dirname(runtimeManifestPath), `${rescued.recoveryDraftHash}.docx`)), newer);
        verifiedRecoveryBeforeCleanup = true;
      }
      return originalRm(target, options);
    };
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '4096';
    try {
      await assert.rejects(overflowingCommand(newer), /cleared automatically/);
      assert.equal(verifiedRecoveryBeforeCleanup, true, 'the actual Bash runtime must persist the edited DOCX before deleting scratch');
      assert.deepEqual(await fs.readdir(runtimeScratch), []);
      assert.deepEqual(await read('runtime-quota.docx'), original);
    } finally { fs.rm = originalRm; }
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '1048576';
    await workflow.inspect({ checkoutId: runtimeCheckout.checkoutId, restoreWorkingCopy: true }, runtimeContext);
    assert.deepEqual(await fs.readFile(runtimeCheckout.workingPath), newer, 'actual Bash quota cleanup leaves a restorable latest draft');

    fs.rename = async (from, to) => {
      if (to === runtimeManifestPath) throw Object.assign(new Error('Bash runtime recovery write fixture failure'), { code: 'EIO' });
      return originalRename(from, to);
    };
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '4096';
    try {
      await assert.rejects(overflowingCommand(modified), (error: unknown) => {
        assert(error instanceof AggregateError);
        assert.match(error.message, /Automatic cleanup .* failed/);
        assert(error.errors.some((cause: unknown) => cause instanceof Error && cause.message.includes('recovery write fixture failure')));
        return true;
      });
      assert.deepEqual(await fs.readFile(runtimeCheckout.workingPath), modified, 'actual runtime cleanup must stop when recovery publication fails');
      assert.equal((await fs.stat(path.join(runtimeScratch, 'oversized-intermediate.bin'))).size, 8192);
      assert.deepEqual(await read('runtime-quota.docx'), original);
    } finally { fs.rename = originalRename; }
    process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = '1048576';

    await seed('report.docx');
    const checkout = await workflow.checkout({ path: 'report.docx' }, context);
    assert.equal(checkout.baseSha256, sha(original));
    assert.equal(checkout.documentId, 'lineage-report.docx');
    assert.deepEqual(await fs.readFile(checkout.workingPath), original);
    await assert.rejects(workflow.checkout({ path: 'report.docx' }, context), /FILE_LOCKED/, 'same-conversation checkouts have distinct lease owners');
    await assert.rejects(workflow.checkout({ path: 'report.docx' }, { ...context, sessionId: 'other-session' }), /FILE_LOCKED/);
    for (const actor of [{ ...context, sessionId: 'other-session' }, { ...context, userId: 'other-user' }, { ...context, workspaceId: 'other-workspace' }, { ...context, agentId: 'other-agent' }]) {
      await assert.rejects(workflow.commit(checkout.checkoutId, actor), /belongs to another/);
    }
    for (const filePath of ['../report.docx', '/report.docx', 'report.md']) {
      await assert.rejects(workflow.checkout({ path: filePath }, context), /DOCX path/);
    }
    const renewed = await workflow.inspect({ checkoutId: checkout.checkoutId, renewLease: true }, context);
    assert(renewed.lockExpiresAt > checkout.lockExpiresAt);
    await fs.writeFile(checkout.workingPath, modified);
    const committed = await workflow.commit(checkout.checkoutId, context);
    assert.equal(committed.status, 'committed');
    assert.deepEqual(await read('report.docx'), modified);
    assert.equal(leases.has('report.docx'), false);
    const count = publishedCount;
    await fs.writeFile(checkout.workingPath, newer);
    assert.deepEqual(await workflow.commit(checkout.checkoutId, context), committed);
    assert.equal(publishedCount, count);

    await seed('conflict.docx');
    const conflictCheckout = await workflow.checkout({ path: 'conflict.docx' }, context);
    await fs.writeFile(conflictCheckout.workingPath, modified);
    await fs.writeFile(path.join(root, 'conflict.docx'), newer);
    const conflict = await workflow.commit(conflictCheckout.checkoutId, context);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.error?.code, 'FILE_REVISION_CONFLICT');
    assert.deepEqual(await read('conflict.docx'), newer);
    await fs.rm(resolveAgentRuntimeTempDir(context), { recursive: true, force: true });
    await workflow.inspect({ checkoutId: conflict.recoveryId, restoreWorkingCopy: true }, context);
    assert.deepEqual(await fs.readFile(conflict.workingPath), modified, 'proposal survives scratch cleanup');
    assert.equal((await workflow.commit(conflict.checkoutId, context)).status, 'conflict');

    await seed('expired.docx');
    const expired = await workflow.checkout({ path: 'expired.docx' }, context);
    await fs.writeFile(expired.workingPath, modified);
    leases.set('expired.docx', { id: 'replacement-lease', expiresAt: Date.now() + 60_000, lineageId: 'lineage-expired.docx', sessionId: 'other-session' });
    assert.equal((await workflow.commit(expired.checkoutId, context)).error?.code, 'FILE_LOCK_STALE');
    await workflow.release(expired.checkoutId, context);
    assert.equal(leases.get('expired.docx')?.id, 'replacement-lease', 'releasing an obsolete checkout must not release its successor');
    assert.deepEqual(await read('expired.docx'), original);

    const created = await workflow.checkout({ path: 'new.docx', createOnly: true }, context);
    await assert.rejects(fs.stat(created.workingPath), /ENOENT/);
    await fs.writeFile(created.workingPath, modified);
    assert.equal((await workflow.commit(created.checkoutId, context)).status, 'committed');
    await assert.rejects(workflow.checkout({ path: 'new.docx', createOnly: true }, context), /already exists/);

    await seed('ack.docx');
    const acknowledgement = await workflow.checkout({ path: 'ack.docx' }, context);
    await fs.writeFile(acknowledgement.workingPath, modified);
    failure = 'after';
    const prepared = await workflow.commit(acknowledgement.checkoutId, context);
    assert.equal(prepared.status, 'prepared');
    const beforeRetry = publishedCount;
    const originalRequest = calls.at(-1)!;
    await fs.writeFile(acknowledgement.workingPath, newer);
    assert.equal((await workflow.commit(acknowledgement.checkoutId, context)).status, 'committed');
    assert.equal(publishedCount, beforeRetry);
    assert.equal(calls.at(-1)!.idempotencyKey, originalRequest.idempotencyKey);
    assert.deepEqual(calls.at(-1)!.content, modified);

    await seed('concurrent.docx');
    const concurrent = await workflow.checkout({ path: 'concurrent.docx' }, context);
    await fs.writeFile(concurrent.workingPath, modified);
    const beforeConcurrent = publishedCount;
    const concurrentResults = await Promise.all([
      workflow.commit(concurrent.checkoutId, context),
      workflow.commit(concurrent.checkoutId, context),
    ]);
    assert.equal(concurrentResults[0].status, 'committed');
    assert.deepEqual(concurrentResults[0], concurrentResults[1]);
    assert.equal(publishedCount, beforeConcurrent + 1, 'concurrent commits publish a checkout only once');

    await seed('cancel.docx');
    const cancelled = await workflow.checkout({ path: 'cancel.docx' }, context);
    await fs.writeFile(cancelled.workingPath, modified);
    const abort = new AbortController();
    beforePublish = async () => { abort.abort(); };
    const abortedResult = await workflow.commit(cancelled.checkoutId, context, abort.signal);
    beforePublish = undefined;
    assert.equal(abortedResult.status, 'conflict');
    assert.deepEqual(await read('cancel.docx'), original);
    await fs.rm(path.dirname(cancelled.workingPath), { recursive: true, force: true });
    await workflow.inspect({ checkoutId: cancelled.checkoutId, restoreWorkingCopy: true }, context);
    assert.deepEqual(await fs.readFile(cancelled.workingPath), modified);

    await seed('permission.docx');
    const permission = await workflow.checkout({ path: 'permission.docx' }, context);
    await fs.writeFile(permission.workingPath, modified);
    authorized = false;
    assert.equal((await workflow.commit(permission.checkoutId, context)).error?.code, 'WORKSPACE_ACCESS_REVOKED');
    authorized = true;
    await fs.rm(path.dirname(permission.workingPath), { recursive: true, force: true });
    await workflow.inspect({ checkoutId: permission.checkoutId, restoreWorkingCopy: true }, context);
    assert.deepEqual(await fs.readFile(permission.workingPath), modified);

    await seed('invalid.docx');
    const invalid = await workflow.checkout({ path: 'invalid.docx' }, context);
    await fs.writeFile(invalid.workingPath, 'not a ZIP');
    assert.equal((await workflow.commit(invalid.checkoutId, context)).error?.code, 'DOCX_INVALID_PACKAGE');
    assert.deepEqual(await read('invalid.docx'), original);

    await seed('release.docx');
    const released = await workflow.checkout({ path: 'release.docx' }, context);
    await fs.writeFile(released.workingPath, modified);
    assert.equal((await workflow.release(released.checkoutId, context)).status, 'released');
    assert.equal((await workflow.commit(released.checkoutId, context)).status, 'released');
    assert.deepEqual(await read('release.docx'), original);

    await seed('escape.docx');
    const escaped = await workflow.checkout({ path: 'escape.docx' }, context);
    await fs.unlink(escaped.workingPath);
    await fs.symlink(path.join(root, 'escape.docx'), escaped.workingPath);
    assert.equal((await workflow.commit(escaped.checkoutId, context)).status, 'conflict');
    assert.deepEqual(await read('escape.docx'), original);

    const protectedManifest = path.join(data, 'office', 'checkouts', checkout.checkoutId, 'manifest.json');
    const manifestBefore = await fs.readFile(protectedManifest);
    await assert.rejects(executeAgentSandboxedCommand(`/usr/bin/python3 -c ${quote(`from pathlib import Path; Path(${JSON.stringify(protectedManifest)}).write_text('{}')`)}`, { context, env: { NODE_ENV: 'test', PATH: process.env.PATH } }), /PermissionError|Operation not permitted|Permission denied/);
    assert.deepEqual(await fs.readFile(protectedManifest), manifestBefore, 'Python cannot rewrite server baselines');

    const tools = createOfficeDocumentTools(workflow);
    assert.deepEqual(tools.map((tool) => tool.name), [...OFFICE_DOCUMENT_TOOL_NAMES]);
    for (const name of OFFICE_DOCUMENT_TOOL_NAMES) assert.deepEqual(getPiToolsetsForTool(name), ['file']);
    assert.equal(filterToolsForWorkspacePermissions(tools, { canWrite: false, canDelete: false, canShare: false }).length, 0);
    await seed('forgery.docx');
    const forgery = await workflow.checkout({ path: 'forgery.docx' }, context);
    await fs.writeFile(forgery.workingPath, modified);
    const tool = tools.find((item) => item.name === 'commit_docx')!;
    await runWithAgentExecutionContext(context, () => tool.execute('forged-request', {
      checkoutId: forgery.checkoutId, expectedSha256: 'forged', baseRevisionId: 'forged', lockId: 'forged', path: 'other.docx',
    }));
    assert.equal(calls.at(-1)!.expectedSha256, sha(original));
    assert.equal(calls.at(-1)!.path, 'forgery.docx');
    assert.notEqual(calls.at(-1)!.lockId, 'forged');
    // Imported mapping ensures delegated workers can gain these tools through
    // the normal file capability; no special hidden side channel is required.
    assert.deepEqual([...resolveDelegatedWorkerToolNames(['file'], OFFICE_DOCUMENT_TOOL_NAMES)].sort(), [...OFFICE_DOCUMENT_TOOL_NAMES].sort());
    console.log('office-document-tools-test: checkout, validation, fencing conflicts, permissions, abort, durable recovery, replay and shell/manifest isolation passed');
  } finally {
    if (beforeData === undefined) delete process.env.DATA;
    else process.env.DATA = beforeData;
    if (beforeCanvas === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = beforeCanvas;
    if (beforeMaxBytes === undefined) delete process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES;
    else process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES = beforeMaxBytes;
    if (beforeMaxFiles === undefined) delete process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES;
    else process.env.CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES = beforeMaxFiles;
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

void main();
