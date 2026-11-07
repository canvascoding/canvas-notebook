import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';
import { withInstalledApiKeySdkMcpFixture, type InstalledSdkProbeEvent } from './helpers/installed-api-key-sdk-mcp-fixture';

const python = process.env.CANVAS_SDK_TEST_PYTHON, wheel = process.env.CANVAS_SDK_TEST_WHEEL;
assert(python && path.isAbsolute(python) && wheel && path.isAbsolute(wheel));
const helpers = ['python_sdk_issued_oauth_keychain_probe.py', 'python_sdk_compiled_operations_probe.py'];
const helperHashes = Object.fromEntries(await Promise.all(helpers.map(async file =>
  [file, createHash('sha256').update(await readFile(path.join('scripts/helpers', file))).digest('hex')])));

await withNativeCopyMetadataOwnerFixture(async h => {
  Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'off', CANVAS_MCP_DIRECT_ENABLED: 'true',
    CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
    CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,create_knowledge_source,edit_knowledge_source' });
  assert.equal((await import('../app/lib/document-review-availability')).readDocumentReviewAvailability().documentReviewEnabled, false);
  assert.equal((await import('../app/lib/files/workspace-file-undo-policy')).WORKSPACE_FILE_UNDO_ENABLED, false);
  const { createApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
  const manager = new Headers((await h.request(h.source, 'owner')).headers); manager.set('Origin', 'http://localhost');
  const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'SDK read boundary acceptance',
    workspaceIds: [h.source.workspaceId], actions: ['read', 'create', 'edit', 'status'], expiresAt: Date.now() + 3_600_000 });
  try {
    const protectedPath = 'read-boundary-protected.md', protectedBytes = Buffer.from('# Protected SDK read source\n');
    const protectedDoc = await h.upload(protectedPath, protectedBytes);
    const snapshot = async () => ({
      registry: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [protectedDoc.documentId])).rows,
      native: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [protectedDoc.documentId])).rows,
      bytes: await readFile(path.join(h.source.rootPath, protectedPath)),
    });
    const before = await snapshot(), nonce = randomUUID().replaceAll('-', '').slice(0, 12);
    const journalDirectory = path.join(h.dataRoot, 'read-boundary-journal');
    await mkdir(journalDirectory, { mode: 0o700 });
    const journalFile = path.join(journalDirectory, 'requests.json');
    await writeFile(journalFile, '[]\n', { flag: 'wx', mode: 0o600 });
    const http: InstalledSdkProbeEvent[] = [];
    let result: Record<string, unknown> | undefined;
    const evidence = await withNativeApiKeyEditRuntime(h, async () => withInstalledApiKeySdkMcpFixture({
      python, wheel, key: issued.key, probe: path.resolve('scripts/helpers/python_sdk_read_boundaries_probe.py'),
      config: { transportProfile: 'source-handler', nonce, workspaceId: h.source.workspaceId, journalFile, helperHashes },
      event: async event => {
        if (event.event === 'http_observation') http.push(event);
        else {
          assert.equal(event.event, 'complete'); assert.equal(event.passed, true);
          assert(event.result && typeof event.result === 'object'); result = event.result as Record<string, unknown>;
          assert.equal(result.groups, 4); assert.equal(result.compiledNext, false);
          assert.equal(result.logicalMutationsJournaled, 3); assert.equal(result.automaticConflictingReadCalls, 2);
          assert.equal(result.pageBudgetReadCalls, 1); assert.equal(result.byteBudgetReadCalls, 1);
        }
      },
    }));
    assert(result && Array.isArray(result.phases));
    assert.equal(result.httpRequests, http.length); assert(http.length > 15);
    for (const phase of result.phases) {
      assert(phase && typeof phase === 'object' && typeof phase.sampleId === 'string');
      assert(http.some(event => event.sampleId === phase.sampleId), `Missing HTTP evidence for ${phase.case}`);
    }
    assert.equal(evidence.droppedAcknowledgements, 0); assert.equal(evidence.deniedMethods.length, 0);
    assert.equal(evidence.stderrBytes, 0); assert.deepEqual(await snapshot(), before);
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as Array<{ tool: string; arguments: Record<string, unknown> }>;
    assert.equal(journal.length, 3); assert.equal(journal[0].tool, 'create_knowledge_source');
    assert(journal.slice(1).every(item => item.tool === 'edit_knowledge_source' && item.arguments.action === 'edit'));
    assert.equal(new Set(journal.map(item => item.arguments.idempotency_key)).size, 3);
    console.log(JSON.stringify({ suite: 'installed-sdk-read-boundaries-http', passed: true, groups: 4,
      httpRequests: http.length, wheelSha256: evidence.wheelSha256, logicalMutationsJournaled: 3,
      protectedNativeRowsXminAndBytesPreserved: true, automaticConflictingReadCalls: 2,
      pageBudgetReadCalls: 1, byteBudgetReadCalls: 1, compiledNext: false,
      oauthIssuance: false, reviewCenterEnabled: false, undoEnabled: false }));
  } finally {
    await revokeApiKey(manager, issued.integration.id, { expectedRevision: 1, credentialId: issued.credential.id });
  }
});
