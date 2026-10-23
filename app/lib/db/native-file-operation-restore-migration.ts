import type { SqlConnection } from '../db';

/** Additive private foundation. No global dispatch, route or writer activation. */
export const NATIVE_FILE_RESTORE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_native_restore_intents (
    operation_id text PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),request_id text NOT NULL UNIQUE,
    intent_text text NOT NULL CHECK(octet_length(intent_text) BETWEEN 1 AND 2097152),
    changes_bundle_proof text NOT NULL CHECK(changes_bundle_proof=encode(sha256(convert_to(intent_text,'UTF8')),'hex'))
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_native_restore_receipts (
    operation_id text PRIMARY KEY REFERENCES collaboration_native_restore_intents(operation_id),
    mutation_id text NOT NULL CHECK(length(mutation_id) BETWEEN 1 AND 256),
    document_id text NOT NULL REFERENCES collaboration_documents(id),request_id text NOT NULL UNIQUE REFERENCES collaboration_admission_requests(request_id),
    changes_bundle_proof text NOT NULL CHECK(changes_bundle_proof ~ '^[a-f0-9]{64}$'),
    receipt_text text NOT NULL CHECK(octet_length(receipt_text) BETWEEN 1 AND 2097152),
    receipt_digest text NOT NULL CHECK(receipt_digest=encode(sha256(convert_to(receipt_text,'UTF8')),'hex')),
    after_state_snapshot bytea NOT NULL CHECK(octet_length(after_state_snapshot) BETWEEN 1 AND 4194304)
  )`,
  `CREATE OR REPLACE FUNCTION immutable_native_restore_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Native restore records are immutable' USING ERRCODE='55000'; END $$`,
  `CREATE OR REPLACE FUNCTION validate_native_restore_endstate() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE b jsonb; r jsonb; archive jsonb; old_bundle jsonb; old_mutation jsonb; old_receipt jsonb;
      q record; old_q record; old_row record; side record; native_proof text; restore_proof text; members bigint;
    BEGIN
      PERFORM set_config('search_path',quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      SELECT intent_text::jsonb INTO b FROM collaboration_native_restore_intents WHERE operation_id=NEW.operation_id;
      r:=NEW.receipt_text::jsonb; archive:=b->'archive';
      SELECT * INTO q FROM collaboration_admission_requests WHERE request_id=NEW.request_id AND octet_length(intent_text)<=2097152 AND octet_length(outcome_text)<=33554432;
      SELECT * INTO old_q FROM collaboration_admission_requests WHERE request_id=archive#>>'{request,requestId}' AND octet_length(intent_text)<=2097152 AND octet_length(outcome_text)<=33554432;
      SELECT * INTO old_row FROM collaboration_native_file_operation_receipts WHERE operation_id=archive->>'operationId' AND mutation_id=archive->>'mutationId' AND octet_length(receipt_text)<=8192 AND octet_length(after_state_snapshot)<=4194304;
      SELECT intent_text::jsonb INTO old_bundle FROM collaboration_native_file_operation_intents WHERE operation_id=archive->>'operationId' AND octet_length(intent_text)<=8388608;
      SELECT value INTO old_mutation FROM jsonb_array_elements(old_bundle->'mutations') WHERE value->>'mutationId'=archive->>'mutationId';
      old_receipt:=old_row.receipt_text::jsonb;
      SELECT * INTO side FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=archive->>'operationId' AND octet_length(receipt_text)<=2097152;
      SELECT count(*),encode(sha256(convert_to('canvas.native-file-receipt-set.v1'||chr(10)||
        string_agg(mutation_id||chr(9)||receipt_digest,chr(10) ORDER BY mutation_id COLLATE "C"),'UTF8')),'hex')
        INTO members,native_proof FROM collaboration_native_file_operation_receipts WHERE operation_id=archive->>'operationId';
      restore_proof:=encode(sha256(convert_to('canvas.native-restore-receipt-set.v1'||chr(10)||NEW.mutation_id||chr(9)||NEW.receipt_digest,'UTF8')),'hex');
      IF b IS NULL OR q IS NULL OR old_q IS NULL OR old_row IS NULL OR old_bundle IS NULL OR old_mutation IS NULL OR side IS NULL
        OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(b) k WHERE k NOT IN('version','operationId','mutationId','requestId','actor','reviewDigest','workspaceType','source','lineageId','trashEntryId','before','archive'))
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN('version','operationId','mutationId','requestId','actor','reviewDigest','workspaceType','source','lineageId','trashEntryId','before','archive','requestDigest','changesBundleProof','beforeArchivedAt','after','projection'))
        OR b->>'version' IS DISTINCT FROM '1' OR r->>'version' IS DISTINCT FROM '1'
        OR b->>'operationId' IS DISTINCT FROM NEW.operation_id OR r->>'operationId' IS DISTINCT FROM NEW.operation_id
        OR b->>'mutationId' IS DISTINCT FROM NEW.mutation_id OR r->>'mutationId' IS DISTINCT FROM NEW.mutation_id
        OR b->>'requestId' IS DISTINCT FROM NEW.request_id OR r->>'requestId' IS DISTINCT FROM NEW.request_id
        OR r->>'changesBundleProof' IS DISTINCT FROM NEW.changes_bundle_proof
        OR NEW.changes_bundle_proof IS DISTINCT FROM (SELECT changes_bundle_proof FROM collaboration_native_restore_intents WHERE operation_id=NEW.operation_id)
        OR r->'actor' IS DISTINCT FROM b->'actor' OR r->>'reviewDigest' IS DISTINCT FROM b->>'reviewDigest'
        OR r->>'workspaceType' IS DISTINCT FROM b->>'workspaceType' OR b->>'workspaceType' NOT IN('personal','organization','team','project')
        OR r->'source' IS DISTINCT FROM b->'source' OR r->'before' IS DISTINCT FROM b->'before'
        OR r->>'lineageId' IS DISTINCT FROM b->>'lineageId' OR r->>'trashEntryId' IS DISTINCT FROM b->>'trashEntryId'
        OR r#>>'{source,documentId}' IS DISTINCT FROM NEW.document_id
        OR r->'archive' IS DISTINCT FROM (archive-'request')||jsonb_build_object('requestId',old_q.request_id,'requestDigest',old_q.request_digest)
        OR q.status IS DISTINCT FROM 'committed' OR q.intent_text::jsonb->>'action' IS DISTINCT FROM 'restore'
        OR q.intent_text::jsonb->>'actorId' IS DISTINCT FROM b#>>'{actor,actorId}'
        OR q.request_digest IS DISTINCT FROM r->>'requestDigest'
        OR (q.intent_text::jsonb->>'actionPayloadText')::jsonb IS DISTINCT FROM jsonb_build_object('kind','native_restore','version',1,
          'operationId',NEW.operation_id,'requestId',NEW.request_id,'actor',b->'actor','reviewDigest',b->'reviewDigest','changesBundleProof',NEW.changes_bundle_proof)
        OR q.outcome_text::jsonb#>>'{result,nativeRestoreReceiptSetProof}' IS DISTINCT FROM restore_proof
        OR q.outcome_text::jsonb->>'version' IS DISTINCT FROM '1'
        OR old_q.status IS DISTINCT FROM 'committed' OR old_q.intent_text::jsonb IS DISTINCT FROM archive->'request'
        OR old_q.intent_text::jsonb->>'action' IS DISTINCT FROM 'archive' OR old_bundle->>'action' IS DISTINCT FROM 'archive'
        OR old_bundle->>'requestId' IS DISTINCT FROM old_q.request_id OR old_row.request_id IS DISTINCT FROM old_q.request_id
        OR old_row.receipt_digest IS DISTINCT FROM archive->>'receiptDigest'
        OR old_mutation->>'kind' IS DISTINCT FROM 'archive' OR old_mutation->'prepared' IS DISTINCT FROM 'null'::jsonb
        OR old_mutation->>'trashEntryId' IS DISTINCT FROM b->>'trashEntryId' OR old_mutation->>'lineageId' IS DISTINCT FROM b->>'lineageId'
        OR old_receipt#>'{after,identity}' IS DISTINCT FROM b->'source' OR old_receipt#>>'{after,status}' IS DISTINCT FROM 'archived'
        OR old_receipt#>'{after,clock}' IS DISTINCT FROM b->'before' OR old_receipt#>>'{after,registryStateVersion}' IS DISTINCT FROM '0'
        OR old_receipt->>'kind' IS DISTINCT FROM 'archive' OR old_receipt->>'lineageId' IS DISTINCT FROM b->>'lineageId'
        OR members<>jsonb_array_length(old_bundle->'mutations') OR members NOT BETWEEN 1 AND 64
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(old_bundle->'mutations') m WHERE NOT EXISTS(
          SELECT 1 FROM collaboration_native_file_operation_receipts n WHERE n.operation_id=archive->>'operationId' AND n.mutation_id=m->>'mutationId'))
        OR native_proof IS DISTINCT FROM archive->>'nativeReceiptSetProof'
        OR old_q.outcome_text::jsonb#>>'{result,nativeFileReceiptSetProof}' IS DISTINCT FROM native_proof
        OR side.request_id IS DISTINCT FROM old_q.request_id OR side.native_receipt_set_proof IS DISTINCT FROM native_proof
        OR archive->>'sideEffectSetProof' IS DISTINCT FROM encode(sha256(convert_to('canvas.native-file-side-effects.v1'||chr(10)||side.receipt_digest,'UTF8')),'hex')
        OR old_q.outcome_text::jsonb#>>'{result,nativeFileSideEffectSetProof}' IS DISTINCT FROM archive->>'sideEffectSetProof'
        OR NOT EXISTS(SELECT 1 FROM collaboration_native_file_operation_side_effect_stages s WHERE s.operation_id=side.operation_id AND s.request_id=side.request_id AND s.stage_digest=side.stage_digest)
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(side.receipt_text::jsonb->'effects') e WHERE e->>'mutationId'=archive->>'mutationId'
          AND e->>'nativeReceiptDigest'=archive->>'receiptDigest' AND e->>'lineageId'=b->>'lineageId'
          AND e#>'{after,identity}'=b->'source' AND e#>>'{after,status}'='archived')
        OR r->'after' IS DISTINCT FROM jsonb_build_object('identity',(b->'source')||jsonb_build_object('lifecycleGeneration',(b#>>'{source,lifecycleGeneration}')::bigint+1),
          'status','active','clock',b->'before','registryStateVersion',0)
        OR r->'projection' IS DISTINCT FROM jsonb_build_object('status','pending','path',b#>>'{source,path}','filesystemComplete',false)
        OR jsonb_typeof(r->'beforeArchivedAt') IS DISTINCT FROM 'number' OR (r->>'beforeArchivedAt')::numeric NOT BETWEEN 0 AND 9007199254740990
        OR b#>>'{before,stateProof}' IS DISTINCT FROM 'yjs-snapshot-sha256-v1:'||encode(sha256(NEW.after_state_snapshot),'hex')
        OR NEW.after_state_snapshot IS DISTINCT FROM old_row.after_state_snapshot
        OR NOT EXISTS(SELECT 1 FROM collaboration_admission_targets t WHERE t.request_id=NEW.request_id AND t.document_id=NEW.document_id
          AND NOT t.active AND t.status='completed' AND t.quiescence_text IS NOT NULL AND t.outcome_snapshot_text IS NOT NULL
          AND t.quiescence_text::jsonb#>'{current,document}'=(b->'source')||jsonb_build_object('status','archived')
          AND t.quiescence_text::jsonb#>>'{current,documentSequence}'=b#>>'{before,documentSequence}'
          AND t.quiescence_text::jsonb#>>'{current,persistedUpdateHash}'=(SELECT encode(sha256(convert_to('canvas.room-release.v1','UTF8')||decode('00','hex')||convert_to('update','UTF8')||decode('00','hex')||s.yjs_state),'hex') FROM collaboration_yjs_states s WHERE s.document_id=NEW.document_id)
          AND t.quiescence_text::jsonb#>>'{current,persistedVectorHash}'=encode(sha256(convert_to('canvas.room-release.v1','UTF8')||decode('00','hex')||convert_to('vector','UTF8')||decode('00','hex')||decode(b#>>'{before,stateVector}','base64')),'hex')
          AND t.outcome_snapshot_text::jsonb->'document'=(r#>'{after,identity}')||jsonb_build_object('status','active')
          AND t.outcome_snapshot_text::jsonb->>'documentSequence'=b#>>'{before,documentSequence}'
          AND t.outcome_snapshot_text::jsonb->>'persistedUpdateHash'=t.quiescence_text::jsonb#>>'{current,persistedUpdateHash}'
          AND t.outcome_snapshot_text::jsonb->>'persistedVectorHash'=t.quiescence_text::jsonb#>>'{current,persistedVectorHash}'
          AND t.outcome_snapshot_text::jsonb->'ownerEpoch'=t.quiescence_text::jsonb#>'{current,ownerEpoch}'
          AND t.outcome_snapshot_text::jsonb->'ownerToken'='null'::jsonb)
        OR (SELECT count(*) FROM collaboration_admission_targets WHERE request_id=NEW.request_id)<>jsonb_array_length(q.intent_text::jsonb->'expectedDocuments')
        OR (SELECT count(*) FROM collaboration_admission_targets WHERE request_id=NEW.request_id)<>jsonb_array_length(q.outcome_text::jsonb->'targets')
        OR EXISTS(SELECT 1 FROM collaboration_admission_targets t WHERE t.request_id=NEW.request_id AND (
          t.active OR t.status IS DISTINCT FROM 'completed' OR t.quiescence_text IS NULL OR t.outcome_snapshot_text IS NULL
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.outcome_text::jsonb->'targets') ot WHERE ot->>'documentId'=t.document_id
            AND ot->>'snapshotText'=t.outcome_snapshot_text AND ot->>'snapshotDigest'=t.outcome_snapshot_digest
            AND ot->>'proofDigest'=encode(sha256(convert_to('canvas.admission-outcome.input.v1','UTF8')||decode('00','hex')||convert_to(t.quiescence_text,'UTF8')),'hex'))
          OR t.document_id<>NEW.document_id AND t.outcome_snapshot_text::jsonb IS DISTINCT FROM (t.quiescence_text::jsonb->'current')))
        OR EXISTS(SELECT 1 FROM collaboration_agent_operations WHERE document_id=NEW.document_id
          AND status NOT IN('persisted_yjs','checkpointed_file','cancelled','expired','superseded','failed','rejected','reverted'))
        OR NOT EXISTS(SELECT 1 FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
          JOIN collaboration_yjs_states s ON s.document_id=d.id JOIN collaboration_file_projections p ON p.document_id=d.id
          WHERE d.id=NEW.document_id AND d.lineage_id=b->>'lineageId' AND d.provider='yjs' AND d.yjs_state_lifecycle='initialized' AND d.state_version=0
            AND d.workspace_id=b#>>'{source,workspaceId}' AND d.workspace_type=b->>'workspaceType' AND d.organization_id IS NOT DISTINCT FROM b#>>'{source,organizationId}'
            AND d.path=b#>>'{source,path}' AND d.status='active' AND d.snapshot_revision_id IS NULL
            AND l.workspace_id=d.workspace_id AND l.workspace_type=d.workspace_type AND l.organization_id IS NOT DISTINCT FROM d.organization_id AND l.path=d.path AND l.status='active'
            AND l.archived_at IS NULL AND l.trash_entry_id IS NULL AND s.workspace_id=d.workspace_id AND s.organization_id IS NOT DISTINCT FROM d.organization_id
            AND s.path=d.path AND s.status='active' AND s.representation=b#>>'{source,representation}' AND s.schema_version=(b#>>'{source,schemaVersion}')::bigint
            AND s.newline_style IN('lf','crlf') AND s.has_bom IN(0,1) AND s.degraded IN(0,1)
            AND NOT(coalesce(s.projection_error_generation=s.lifecycle_generation AND s.projection_error_code IS NOT NULL AND s.projection_error_permanent=1,false)
              OR s.degraded=1 AND (CASE WHEN s.projection_error_generation=s.lifecycle_generation THEN s.projection_error_code ELSE NULL END) IS DISTINCT FROM 'COLLABORATION_YJS_PERSISTENCE_FAILED')
            AND s.lifecycle_generation=(b#>>'{source,lifecycleGeneration}')::bigint+1 AND s.document_sequence=(b#>>'{before,documentSequence}')::bigint
            AND s.persisted_at=(b#>>'{before,persistedAt}')::bigint AND encode(sha256(s.yjs_state),'hex')=b#>>'{before,binaryHash}'
            AND s.state_vector=decode(b#>>'{before,stateVector}','base64') AND s.checkpoint_sequence=0 AND s.checkpointed_at IS NULL
            AND s.canonical_hash IS NULL AND s.serialized_hash IS NULL AND s.room_owner_token IS NULL AND s.room_owner_backend_pid IS NULL AND s.room_owner_backend_start IS NULL
            AND p.lifecycle_generation=s.lifecycle_generation AND p.projected_sequence=s.document_sequence AND p.finalized=0
            AND p.revision_id IS NULL AND p.canonical_hash IS NULL AND p.serialized_hash IS NULL)
        OR EXISTS(SELECT 1 FROM collaboration_documents d WHERE d.workspace_id=b#>>'{source,workspaceId}' AND d.status='active' AND d.id<>NEW.document_id
          AND (d.path=b#>>'{source,path}' OR left(d.path,length(b#>>'{source,path}')+1)=(b#>>'{source,path}')||'/' OR left(b#>>'{source,path}',length(d.path)+1)=d.path||'/'))
        OR EXISTS(SELECT 1 FROM file_collaboration_lineages l WHERE l.workspace_id=b#>>'{source,workspaceId}' AND l.status='active' AND l.id<>b->>'lineageId'
          AND (l.path=b#>>'{source,path}' OR left(l.path,length(b#>>'{source,path}')+1)=(b#>>'{source,path}')||'/' OR left(b#>>'{source,path}',length(l.path)+1)=l.path||'/')) THEN
        RAISE EXCEPTION 'Native restore endstate is unavailable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_restore_intents'::regclass AND tgname='native_restore_intent_immutable') THEN
      CREATE TRIGGER native_restore_intent_immutable BEFORE UPDATE OR DELETE ON collaboration_native_restore_intents FOR EACH ROW EXECUTE FUNCTION immutable_native_restore_record();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_restore_receipts'::regclass AND tgname='native_restore_receipt_immutable') THEN
      CREATE TRIGGER native_restore_receipt_immutable BEFORE UPDATE OR DELETE ON collaboration_native_restore_receipts FOR EACH ROW EXECUTE FUNCTION immutable_native_restore_record();
      CREATE CONSTRAINT TRIGGER native_restore_receipt_endstate AFTER INSERT ON collaboration_native_restore_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_native_restore_endstate();
    END IF;
  END $$`,
] as const;

/** Caller owns actual schema selection and migration transaction. */
export async function runNativeFileRestoreMigration(database: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of NATIVE_FILE_RESTORE_STATEMENTS) await database.run(statement);
}
