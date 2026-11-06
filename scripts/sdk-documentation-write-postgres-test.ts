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
const exampleInputs = ['docs/product/en/developers/python-sdk.mdx', 'scripts/helpers/python_sdk_documentation_write_probe.py',
  'scripts/helpers/python_sdk_issued_oauth_keychain_probe.py', 'scripts/helpers/python_sdk_compiled_operations_probe.py'];
const exampleHashes = async () => Object.fromEntries(await Promise.all(exampleInputs.map(async file =>
  [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const exampleSourceHashes = await exampleHashes();
const sourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
const downloaded = await fetch(sourceUrl, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000) });
assert.equal(downloaded.status, 200);
const sourceBytes = Buffer.from(await downloaded.arrayBuffer());
assert(sourceBytes.length > 0 && sourceBytes.length <= 512 * 1024);

await withNativeCopyMetadataOwnerFixture(async h => {
  Object.assign(process.env, { FILE_VERSION_CENTER_MODE: 'off', CANVAS_MCP_DIRECT_ENABLED: 'true',
    CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
    CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,get_knowledge_manifest,create_knowledge_source,import_knowledge_file,edit_knowledge_source,copy_knowledge_source,move_knowledge_source,delete_knowledge_source' });
  assert.equal((await import('../app/lib/document-review-availability')).readDocumentReviewAvailability().documentReviewEnabled, false);
  assert.equal((await import('../app/lib/files/workspace-file-undo-policy')).WORKSPACE_FILE_UNDO_ENABLED, false);
  const { createApiIntegration, revokeApiKey } = await import('../app/lib/api-keys/management');
  const { API_KEY_ACTIONS } = await import('../app/lib/api-keys/contracts');
  const manager = new Headers((await h.request(h.source, 'owner')).headers); manager.set('Origin', 'http://localhost');
  const issued = await createApiIntegration(manager, { requestId: randomUUID(), name: 'Executable SDK documentation',
    workspaceIds: [h.source.workspaceId, h.destination.workspaceId], actions: [...API_KEY_ACTIONS], expiresAt: Date.now() + 3_600_000 });
  const protectedPath = 'documentation-protected.md', protectedBytes = Buffer.from('# Protected documentation source\n');
  const protectedDoc = await h.upload(protectedPath, protectedBytes);
  const snapshot = async () => ({
    registry: (await h.admin.query('SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM collaboration_documents d WHERE id=$1', [protectedDoc.documentId])).rows,
    native: (await h.admin.query('SELECT to_jsonb(s) AS row,xmin::text AS xmin FROM collaboration_yjs_states s WHERE document_id=$1', [protectedDoc.documentId])).rows,
    bytes: await readFile(path.join(h.source.rootPath, protectedPath)),
  });
  const before = await snapshot(), nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const originalPath = 'original/quelle-ä😀.md', originalText = '# Original documentation note\n';
  // Existing files can arrive through the supported local workspace mount.
  // Create only this owned physical fixture; its manifest and native import
  // use the genuine services, with no fabricated registry/Yjs rows.
  await mkdir(path.join(h.source.rootPath, 'original'), { recursive: true });
  await writeFile(path.join(h.source.rootPath, originalPath), originalText, { flag: 'wx', mode: 0o600 });
  const requestsDirectory = path.join(h.dataRoot, 'documentation-requests');
  await mkdir(requestsDirectory, { mode: 0o700 });
  const http: InstalledSdkProbeEvent[] = [];
  let result: Record<string, unknown> | undefined;
  try {
    const evidence = await withNativeApiKeyEditRuntime(h, async () => withInstalledApiKeySdkMcpFixture({
      python, wheel, key: issued.key, probe: path.resolve('scripts/helpers/python_sdk_documentation_write_probe.py'),
      config: { transportProfile: 'source-handler', exampleSourceHashes, nonce, workspaceId: h.source.workspaceId, destinationWorkspaceId: h.destination.workspaceId,
        originalPath, originalText, requestsDirectory, fileReference: { download_url: sourceUrl, file_id: 'documentation-mcp-readme', mime_type: 'text/markdown' },
        expectedImportedMarkdown: sourceBytes.toString('utf8') },
      event: async event => {
        if (event.event === 'http_observation') http.push(event);
        else {
          assert.equal(event.event, 'complete'); assert.equal(event.passed, true);
          assert(event.result && typeof event.result === 'object'); result = event.result as Record<string, unknown>;
          assert.equal(result.compiledNext, false); assert.equal(result.logicalMutationsJournaled, 7);
          assert(Array.isArray(result.executedExampleFunctions)); assert.equal(result.executedExampleFunctions.length, 12);
        }
      },
    }));
    assert(result && http.length > 20);
    assert.equal(result.httpRequests, http.length, 'Every observed HTTP exchange must reach the controller.');
    assert(Array.isArray(result.phases));
    for (const phase of result.phases) {
      assert(phase && typeof phase === 'object' && typeof phase.sampleId === 'string');
      assert(http.some(event => event.sampleId === phase.sampleId), `Missing HTTP evidence for ${phase.example}`);
    }
    assert.equal(evidence.droppedAcknowledgements, 0);
    assert.equal(evidence.deniedMethods.length, 0); assert.equal(evidence.stderrBytes, 0);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await exampleHashes(), exampleSourceHashes);
    console.log(JSON.stringify({ suite: 'sdk-documentation-write-http', passed: true, exampleFunctions: 12,
      logicalMutationsJournaled: 7, httpRequests: http.length, wheelSha256: evidence.wheelSha256,
      documentationSha256: result.documentationSha256, protectedNativeRowsXminAndBytesPreserved: true,
      compiledNext: false, oauthIssuance: false, reviewCenterEnabled: false, undoEnabled: false }));
  } finally {
    await revokeApiKey(manager, issued.integration.id, { expectedRevision: 1, credentialId: issued.credential.id });
  }
});
