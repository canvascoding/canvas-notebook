import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

await withNativeCopyMetadataOwnerFixture(async h => {
  const { POST } = await import('../app/api/files/rename/route');
  const targetText = '# Target\n\n[Source](source.md)\n';
  await h.upload('group/target.md', Buffer.from(targetText));
  await h.upload('group/source.md', Buffer.from('# Source\n\n[Target](target.md)\n'));
  const documents = Number((await h.admin.query(`SELECT count(*)::integer AS n FROM collaboration_documents
    WHERE workspace_id=$1 AND status='active'`, [h.source.workspaceId])).rows[0].n);
  assert(documents >= 3 && documents <= 8, 'The genuine revoked phase must contain multiple original targets.');
  const nativeSnapshot = async () => (await h.admin.query(`SELECT to_jsonb(d) AS registry,d.xmin::text AS registry_xmin,
    to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,to_jsonb(s) AS native,s.xmin::text AS native_xmin,
    to_jsonb(m) AS metadata,m.xmin::text AS metadata_xmin
    FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
    JOIN collaboration_yjs_states s ON s.document_id=d.id
    LEFT JOIN workspace_file_metadata m ON m.workspace_id=d.workspace_id AND m.path=d.path
    WHERE d.workspace_id=$1 ORDER BY d.id`, [h.source.workspaceId])).rows;
  const physicalSnapshot = async () => {
    const result: Array<{ path: string; inode: string; bytes: string }> = [];
    const visit = async (relative: string): Promise<void> => {
      for (const name of (await fs.readdir(path.join(h.source.rootPath, relative))).sort()) {
        const current = relative ? `${relative}/${name}` : name, absolute = path.join(h.source.rootPath, current);
        const stat = await fs.lstat(absolute); assert(!stat.isSymbolicLink());
        if (stat.isDirectory()) await visit(current);
        else {
          assert(stat.isFile());
          result.push({ path: current, inode: `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeMs}`,
            bytes: createHash('sha256').update(await fs.readFile(absolute)).digest('hex') });
        }
      }
    };
    await visit(''); return result;
  };
  const beforeNative = await nativeSnapshot(), beforePhysical = await physicalSnapshot();
  const original = await h.request(h.source, 'owner', true);
  const operationId = randomUUID(); let requestId: string | undefined, changed = false, proofWrites = 0;
  const response = await h.withProbe(async event => {
    if (!/^\s*UPDATE\s+collaboration_admission_targets\s+SET\s+status\s*=\s*'released'/iu.test(event.text)) return;
    proofWrites++; assert.equal(proofWrites, 1, 'Current denial must stop before another target proof.');
    assert.equal(event.result.rowCount, 1); assert.equal(typeof event.values[0], 'string');
    requestId = event.values[0] as string;
    const actual = (await event.raw('SELECT current_schema() AS schema,pg_backend_pid() AS backend')).rows[0];
    assert.equal(actual.schema, h.schema); assert(Number.isSafeInteger(Number(actual.backend)));
    // Actual own-B DML after the first real proof ACK: no replacement policy,
    // SQL result, principal or permission callback is installed by this test.
    const revoked = await event.raw('UPDATE "user" SET banned=1 WHERE id=$1 RETURNING id', ['owner']);
    assert.equal(revoked.rowCount, 1); changed = true;
  }, () => POST(new NextRequest('http://localhost/api/files/rename', {
    method: 'POST', headers: new Headers({ ...Object.fromEntries(original.headers), 'content-type': 'application/json' }),
    body: JSON.stringify({ oldPath: 'group/target.md', newPath: 'group/renamed.md', idempotencyKey: operationId }),
  })));
  const body = await response.json();
  console.log(JSON.stringify({ diagnostic: 'implicit-group-authority-response', status: response.status,
    code: typeof body.code === 'string' ? body.code : null, keys: Object.keys(body).sort() }));
  assert(changed && requestId); assert.equal(response.status, 403);
  // The shared current Seat reader rejects the actual banned account with
  // its existing public denial code; no replacement Principal is involved.
  assert.equal(body.code, 'SEAT_ACCESS_INACTIVE');
  assert([0, '0', false].includes((await h.admin.query('SELECT banned FROM "user" WHERE id=$1', ['owner'])).rows[0].banned));
  assert.equal(Number((await h.admin.query(`SELECT count(*)::integer AS n FROM collaboration_admission_targets
    WHERE request_id=$1 AND (quiescence_text IS NOT NULL OR status='released')`, [requestId])).rows[0].n), 0);
  assert.equal(Number((await h.admin.query(`SELECT count(*)::integer AS n FROM workspace_file_operation_batches
    WHERE workspace_id=$1`, [h.source.workspaceId])).rows[0].n), 0);
  assert.deepEqual(await nativeSnapshot(), beforeNative); assert.deepEqual(await physicalSnapshot(), beforePhysical);
  assert.equal(await fs.readFile(path.join(h.source.rootPath, 'group/target.md'), 'utf8'), targetText);
  await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'group/renamed.md')), { code: 'ENOENT' });
  console.log(JSON.stringify({ implicitMoveGroupAuthority: true, passed: true, nativeDocuments: documents,
    denialStatus: response.status, proofWrites, proofGroupRolledBack: true, nativeAndMetadataUnchanged: true,
    physicalBytesAndIdentityUnchanged: true }));
});
completed = true;
