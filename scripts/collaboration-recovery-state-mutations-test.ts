import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { createRichMarkdownYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { decodeRecoveryState, recoveryStateFingerprint } from '../app/lib/collaboration/recovery-evidence';
import { lockIdentity } from '../app/lib/collaboration/room-owner';
import { collaborationRoomReleaseDigest } from '../app/lib/collaboration/room-owner-release';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { collaborationAdmissionActionDigest } from '../app/lib/collaboration/room-admission-contract';
import { CollaborationProjectionIdentityError } from '../app/lib/collaboration/projection-identity';
import { applyCodeMarkRecoveryClone, archiveCollaborationRecoveryOrphan,
  withOfflineCollaborationRecoveryGuards, type OfflineCollaborationRecoveryGuard } from '../app/lib/collaboration/recovery-state-mutations';

type Row = Record<string, unknown>;

async function main() {
  const database = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(database.hostname)); assert.equal(database.port, '55433');
  assert.match(database.pathname, /^\/canvas_editor_test_[a-f0-9]+$/u, 'requires the disposable PostgreSQL test wrapper');
  const client = new Client({ connectionString: database.href }); await client.connect();
  const documents: Y.Doc[] = []; const events: string[] = [];
  const open = (fault?: 'commit_reply_lost' | 'commit_rejected', afterCommit?: () => Promise<void>) => {
    let first = true;
    return async (): Promise<SqlConnection> => {
      const native = new Client({ connectionString: database.href, query_timeout: 8000 }); await native.connect();
      const inject = first ? fault : undefined; first = false;
      return {
        get: async (sql, params) => (await native.query(sql, params)).rows[0],
        all: async (sql, params) => (await native.query(sql, params)).rows,
        run: async (sql, params) => {
          if (sql === 'COMMIT' && inject) {
            if (inject === 'commit_reply_lost') { await native.query(sql, params); await afterCommit?.(); }
            events.push(inject); throw new Error(inject);
          }
          return { changes: (await native.query(sql, params)).rowCount ?? 0 };
        },
        close: async (error) => { events.push(error ? 'discard' : 'close'); await native.end(); },
      };
    };
  };
  const row = async (id: string) => (await client.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [id])).rows[0] as Row;
  const state = async (id: string) => decodeRecoveryState(await row(id));
  const guarded = <T>(ids: string[], operation: (guard: OfflineCollaborationRecoveryGuard) => Promise<T>) =>
    withOfflineCollaborationRecoveryGuards({ documentIds: ids, openGuardConnection: open(), operation });
  const token = () => ({ operationId: randomUUID(), backupId: randomUUID() });
  const scope = randomUUID();
  try {
    await client.query(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,'Recovery mutation',$2,0,1,1)`,
      [scope, `${scope}@example.test`]);
    await client.query(`INSERT INTO canvas_organization_settings (organization_id,owner_user_id,created_at,updated_at) VALUES ($1,$1,1,1)`, [scope]);
    await client.query(`INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$1,'team',$2,'Recovery mutation','active',1,1)`, [scope, `workspace/${scope}`]);
    const fixture = async (name: string, conflict = false, registered = true) => {
      const id = `${name}-${randomUUID()}`; const path = `${id}.md`;
      let doc: Y.Doc;
      if (conflict) {
        const seed = createRichMarkdownYDoc('---\ntitle: Evidence\n---\n\nOriginal text\n', 'tiptap_xml');
        const code = new Y.Doc({ gc: false }); const bold = new Y.Doc({ gc: false }); doc = new Y.Doc({ gc: false });
        documents.push(seed, code, bold);
        for (const copy of [code, bold, doc]) Y.applyUpdate(copy, Y.encodeStateAsUpdate(seed));
        const content = (copy: Y.Doc) => {
          const paragraph = copy.getXmlFragment('body').get(0); assert(paragraph instanceof Y.XmlElement);
          const value = paragraph.get(0); assert(value instanceof Y.XmlText); return value;
        };
        content(code).format(0, content(code).length, { code: {} }); content(bold).format(0, content(bold).length, { bold: {} });
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(code)); Y.applyUpdate(doc, Y.encodeStateAsUpdate(bold));
        assert.equal(validateRichMarkdownYDoc(doc).code, 'schema_invalid');
      } else { doc = new Y.Doc(); doc.getText('content').insert(0, 'Original text'); }
      documents.push(doc);
      await client.query(`INSERT INTO collaboration_yjs_states
        (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,checkpoint_sequence,persisted_at,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,
        projection_error_code,projection_error_sequence,projection_error_generation,projection_error_permanent)
        VALUES ($1,$2,$2,$3,$4,4,1,$5,$6,7,6,10,9,'prior-canonical','prior-serialized','crlf',1,$7,$8,7,4,$7)`,
      [id, scope, path, conflict ? 'tiptap_xml' : 'plain_text', Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), conflict ? 1 : 0,
        conflict ? 'schema_invalid' : null]);
      if (registered) await client.query(`INSERT INTO collaboration_documents
        (id,workspace_id,organization_id,workspace_type,path,provider,status,created_at,updated_at)
        VALUES ($1,$2,$2,'team',$3,'yjs','active',1,1)`, [id, scope, path]);
      return { id, path, expected: await state(id), doc };
    };

    const repaired = await fixture('repair', true); const repairIds = token();
    const beforeJson = readRichDocumentJson(repaired.doc);
    await guarded([repaired.id], async guard => {
      const beforeOwner = (await row(repaired.id)).room_owner_epoch;
      assert.equal((await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [lockIdentity(repaired.id).key])).rows[0].locked, false);
      const result = await applyCodeMarkRecoveryClone({ ...repairIds, expected: repaired.expected, guard, openConnection: open() });
      assert.equal(result.disposition, 'applied'); assert.equal(result.state.lifecycleGeneration, 5); assert.equal(result.state.documentSequence, 8);
      assert.equal(result.state.checkpointSequence, 6, 'projection remains pending after SQL commit');
      assert.equal(result.state.degraded, false); assert.equal(result.state.projectionError, undefined);
      assert.equal(result.state.hasBom, true); assert.equal(result.state.newlineStyle, 'crlf');
      assert.equal((await row(repaired.id)).room_owner_epoch, beforeOwner, 'guard never acquires owner identity');
      const clone = new Y.Doc(); documents.push(clone); Y.applyUpdate(clone, result.state.yjsState);
      assert.equal(validateRichMarkdownYDoc(clone).valid, true);
      const expectedJson = JSON.parse(JSON.stringify(beforeJson), (key, value) => key === 'marks' && Array.isArray(value)
        && value.some(mark => mark.type === 'code') ? value.filter(mark => mark.type === 'code') : value);
      assert.equal(JSON.stringify(readRichDocumentJson(clone)), JSON.stringify(expectedJson));
      assert.equal((await applyCodeMarkRecoveryClone({ ...repairIds, expected: repaired.expected, guard, openConnection: open() })).disposition, 'already_applied');
    });
    const outcome = (await client.query('SELECT * FROM collaboration_recovery_state_mutations WHERE operation_id=$1', [repairIds.operationId])).rows[0];
    assert.deepEqual(new Uint8Array(outcome.before_update), repaired.expected.yjsState);
    assert.deepEqual(new Uint8Array(outcome.before_vector), repaired.expected.stateVector);
    assert.equal(outcome.before_metadata.row.projection_error_code, 'schema_invalid');
    await client.query(`UPDATE collaboration_yjs_states SET checkpoint_sequence=document_sequence,checkpointed_at=persisted_at+1,
      canonical_hash=$2,serialized_hash=$3 WHERE document_id=$1`,
    [repaired.id, outcome.after_metadata.projectedCanonicalHash, outcome.after_metadata.projectedSerializedHash]);
    await guarded([repaired.id], async guard => {
      assert.equal((await applyCodeMarkRecoveryClone({ ...repairIds, expected: repaired.expected, guard, openConnection: open() })).disposition,
        'already_applied', 'legitimate checkpoint finalization does not duplicate repair');
    });
    await client.query('UPDATE collaboration_yjs_states SET document_sequence=document_sequence+1 WHERE document_id=$1', [repaired.id]);
    await guarded([repaired.id], async guard => {
      await assert.rejects(applyCodeMarkRecoveryClone({ ...repairIds, expected: repaired.expected, guard, openConnection: open() }), /recovery_operation_conflict/u);
    });

    for (const fault of ['commit_reply_lost', 'commit_rejected'] as const) {
      const target = await fixture(fault, true); const ids = token(); const original = recoveryStateFingerprint(target.expected);
      await guarded([target.id], async guard => {
        const applying = applyCodeMarkRecoveryClone({ ...ids, expected: target.expected, guard, openConnection: open(fault) });
        if (fault === 'commit_reply_lost') {
          const result = await applying; assert.equal(result.state.lifecycleGeneration, 5); assert.equal(result.state.documentSequence, 8);
          assert.equal(Number((await client.query('SELECT COUNT(*) AS count FROM collaboration_recovery_state_mutations WHERE operation_id=$1',
            [ids.operationId])).rows[0].count), 1);
        } else { await assert.rejects(applying, /recovery_operation_conflict/u); assert.equal(recoveryStateFingerprint(await state(target.id)), original); }
      });
    }
    assert(events.includes('commit_reply_lost') && events.includes('commit_rejected') && events.includes('discard'));
    const lostIdentity = await fixture('lost-commit-identity', true);
    await guarded([lostIdentity.id], async guard => {
      await assert.rejects(applyCodeMarkRecoveryClone({ ...token(), expected: lostIdentity.expected, guard,
        openConnection: open('commit_reply_lost', async () => {
          await client.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [lostIdentity.id]);
        }) }), (error: unknown) => error instanceof CollaborationProjectionIdentityError,
      'durable bytes alone never prove a currently valid registry identity');
      assert.equal((await state(lostIdentity.id)).lifecycleGeneration, 5, 'lost proof does not replay a committed mutation');
    });

    const successor = await fixture('successor'); const orphan = await fixture('orphan', false, false);
    await client.query('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [orphan.id, successor.path]); orphan.expected = await state(orphan.id);
    const originalSuccessor = await row(successor.id); const archiveIds = token();
    await guarded([orphan.id, successor.id], async guard => {
      const result = await archiveCollaborationRecoveryOrphan({ ...archiveIds, expected: orphan.expected, guard, openConnection: open() });
      assert.equal(result.state.status, 'archived'); assert.equal(result.state.lifecycleGeneration, 5); assert.equal(result.state.documentSequence, 7);
      assert.deepEqual(result.state.yjsState, orphan.expected.yjsState); assert.deepEqual(result.state.stateVector, orphan.expected.stateVector);
    });
    assert.deepEqual(await row(successor.id), originalSuccessor, 'same-path successor is never archived or changed');
    await guarded([orphan.id, successor.id], async guard => {
      assert.equal((await archiveCollaborationRecoveryOrphan({ ...archiveIds, expected: orphan.expected, guard, openConnection: open() })).disposition, 'already_archived');
      await assert.rejects(archiveCollaborationRecoveryOrphan({ ...token(), expected: successor.expected, guard, openConnection: open() }), /recovery_state_changed/u);
    });
    await client.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [successor.id]);
    await guarded([orphan.id, successor.id], async guard => {
      await assert.rejects(archiveCollaborationRecoveryOrphan({ ...archiveIds, expected: orphan.expected, guard, openConnection: open() }),
        /recovery_state_changed/u, 'an archived orphan retry still requires its current different successor');
    });
    const lostArchiveSuccessor = await fixture('lost-archive-successor'); const lostArchive = await fixture('lost-archive', false, false);
    await client.query('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1', [lostArchive.id, lostArchiveSuccessor.path]);
    lostArchive.expected = await state(lostArchive.id);
    await guarded([lostArchive.id, lostArchiveSuccessor.id], async guard => {
      await assert.rejects(archiveCollaborationRecoveryOrphan({ ...token(), expected: lostArchive.expected, guard,
        openConnection: open('commit_reply_lost', async () => {
          await client.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [lostArchiveSuccessor.id]);
        }) }), /recovery_state_changed/u, 'lost archive COMMIT proof rechecks the current successor');
      assert.equal((await state(lostArchive.id)).status, 'archived');
    });

    const busy = await fixture('busy');
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockIdentity(busy.id).key]);
    await assert.rejects(guarded([busy.id], async () => {}), /recovery_room_busy/u);
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockIdentity(busy.id).key]);
    const stale = await fixture('stale-owner');
    await client.query('UPDATE collaboration_yjs_states SET room_owner_epoch=1,room_owner_token=$2,room_owner_backend_pid=1,room_owner_backend_start=$3 WHERE document_id=$1',
      [stale.id, randomUUID(), 'stale']);
    await assert.rejects(guarded([stale.id], async () => {}), /recovery_release_unproven/u);
    assert.equal((await row(stale.id)).room_owner_backend_start, 'stale', 'no stale owner clearing');
    await client.query('UPDATE collaboration_yjs_states SET room_owner_token=NULL,room_owner_backend_pid=NULL,room_owner_backend_start=NULL WHERE document_id=$1', [stale.id]);
    await assert.rejects(guarded([stale.id], async () => {}), /recovery_release_unproven/u);

    const released = await fixture('released-owner', true);
    await client.query('UPDATE collaboration_yjs_states SET room_owner_epoch=1 WHERE document_id=$1', [released.id]);
    const releaseRow = await row(released.id);
    await client.query(`INSERT INTO collaboration_room_release_receipts
      (release_id,document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,owner_epoch,
      owner_token,owner_backend_pid,owner_backend_start,document_sequence,persisted_update_hash,persisted_vector_hash,live_update_hash,live_vector_hash,created_at)
      VALUES ($1,$2,$3,$3,$4,'tiptap_xml',4,1,1,$5,1,'prior',7,$6,$7,$6,$7,10)`,
    [randomUUID(), released.id, scope, released.path, randomUUID(), collaborationRoomReleaseDigest('update', releaseRow.yjs_state as Uint8Array),
      collaborationRoomReleaseDigest('vector', releaseRow.state_vector as Uint8Array)]);
    const releasedIds = token();
    await guarded([released.id], async guard => {
      assert.equal((await applyCodeMarkRecoveryClone({ ...releasedIds, expected: released.expected, guard, openConnection: open() })).disposition, 'applied');
    });
    await guarded([released.id], async guard => {
      assert.equal((await applyCodeMarkRecoveryClone({ ...releasedIds, expected: released.expected, guard, openConnection: open() })).disposition,
        'already_applied', 'retained predecessor release proves neutral guard after restart');
    });

    const pending = await fixture('pending');
    await client.query(`INSERT INTO collaboration_agent_operations
      (operation_id,document_id,workspace_id,initiated_by_user_id,actor_id,idempotency_key,payload_hash,status,base_state_vector,created_at,updated_at)
      VALUES ($1,$2,$3,$3,$3,$1,'payload','applying',$4,1,1)`, [randomUUID(), pending.id, scope, Buffer.from(pending.expected.stateVector)]);
    await assert.rejects(guarded([pending.id], async () => {}), /recovery_agent_pending/u);
    const reserved = await fixture('reserved'); const actionPayloadText = JSON.stringify({ operation: 'recovery-test' });
    await createCollaborationAdmissionService({ openConnection: open() }).reserve({ requestId: randomUUID(), actorId: scope,
      action: 'compact', actionPayloadText, actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
      scopes: [{ workspaceId: scope, organizationId: scope, path: reserved.path, kind: 'exact' }],
      expectedDocuments: [{ documentId: reserved.id, workspaceId: scope, organizationId: scope, path: reserved.path,
        representation: reserved.expected.representation, lifecycleGeneration: 4, schemaVersion: 1, status: 'active' }] });
    await assert.rejects(guarded([reserved.id], async () => {}), /ADMISSION_CONFLICT/u);
    await assert.rejects(applyCodeMarkRecoveryClone({ ...token(), expected: released.expected, guard: { assertActive: async () => {} }, openConnection: open() }),
      /recovery_guard_required/u);
    console.log('Recovery state mutations: dedicated guards, release proof, clone identities, pending projection, durable originals, exact archive, idempotence and both COMMIT outcomes passed.');
  } finally {
    documents.forEach(doc => doc.destroy()); await client.end();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.name + ': ' + error.message : 'Recovery mutation test failed'); process.exitCode = 1; });
