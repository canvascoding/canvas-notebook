/** Additive Raw-Copy B1 facts. No original CloneReceipt shape is extended. */
export const NATIVE_COPY_MARKDOWN_BIRTH_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_native_copy_markdown_births (
    workspace_id text NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
    parent_operation_id text NOT NULL CHECK(length(parent_operation_id) BETWEEN 1 AND 256),
    requirement_index integer NOT NULL CHECK(requirement_index BETWEEN 0 AND 9999),
    version integer NOT NULL CHECK(version=1),
    import_operation_id text NOT NULL CHECK(length(import_operation_id) BETWEEN 1 AND 256),
    document_id text NOT NULL CHECK(length(document_id) BETWEEN 1 AND 256),
    lineage_id text NOT NULL CHECK(length(lineage_id) BETWEEN 1 AND 256),
    plan_id text NOT NULL CHECK(plan_id ~ '^[a-f0-9]{64}$'),
    stage_digest text NOT NULL CHECK(stage_digest ~ '^[a-f0-9]{64}$'),
    request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
    requirement_key text NOT NULL CHECK(length(requirement_key) BETWEEN 1 AND 4096),
    requirement_proof text NOT NULL CHECK(requirement_proof ~ '^[a-f0-9]{64}$'),
    birth_text text NOT NULL CHECK(octet_length(birth_text) BETWEEN 1 AND 16777216),
    birth_digest text NOT NULL CHECK(birth_digest ~ '^[a-f0-9]{64}$'),
    b1_transaction_id text NOT NULL CHECK(b1_transaction_id ~ '^[1-9][0-9]{0,31}$'),
    created_at bigint NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(workspace_id,parent_operation_id,requirement_index),
    UNIQUE(document_id), UNIQUE(workspace_id,import_operation_id),
    FOREIGN KEY(workspace_id,parent_operation_id) REFERENCES collaboration_native_copy_receipts(workspace_id,operation_id),
    FOREIGN KEY(workspace_id,import_operation_id) REFERENCES collaboration_markdown_file_import_receipts(workspace_id,operation_id)
  )`,
  `CREATE OR REPLACE FUNCTION validate_native_copy_markdown_birth() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE birth jsonb; parent jsonb; origin jsonb; binding jsonb; receipt jsonb; target jsonb; source jsonb;
      actual record; xid text; xmin32 text; value text; actual_count bigint; previous_bytes bigint;
    BEGIN
      IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'Raw Markdown Copy births are immutable' USING ERRCODE='55000';
      END IF;
      IF pg_catalog.current_setting('transaction_isolation')<>'read committed'
        OR pg_catalog.current_setting('transaction_read_only')<>'off'
        OR pg_catalog.current_setting('session_replication_role')<>'origin' THEN
        RAISE EXCEPTION 'Raw Markdown Copy birth requires its actual write transaction' USING ERRCODE='23514';
      END IF;
      xid:=pg_catalog.pg_current_xact_id()::text;
      xmin32:=(xid::numeric % 4294967296)::text;
      IF NEW.version<>1 OR NEW.b1_transaction_id<>xid
        OR NEW.birth_digest IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.birth_text,'UTF8')),'hex') THEN
        RAISE EXCEPTION 'Raw Markdown Copy birth transaction or bytes changed' USING ERRCODE='23514';
      END IF;
      FOREACH value IN ARRAY ARRAY[NEW.workspace_id,NEW.parent_operation_id,NEW.import_operation_id,NEW.document_id,NEW.lineage_id] LOOP
        IF value IS NULL OR length(value) NOT BETWEEN 1 AND 256 OR value<>btrim(value) OR value ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'Raw Markdown Copy birth identity changed' USING ERRCODE='23514';
        END IF;
      END LOOP;
      birth:=NEW.birth_text::jsonb;
      parent:=birth->'parent'; origin:=birth->'origin'; binding:=birth->'binding';
      receipt:=binding->'receipt'; target:=receipt->'target'; source:=binding->'source';
      IF pg_catalog.jsonb_typeof(birth) IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(birth))<>6
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(birth) k WHERE k NOT IN
          ('version','parent','origin','binding','b1TransactionId','birthProof'))
        OR birth->'version' IS DISTINCT FROM '1'::jsonb
        OR birth->>'b1TransactionId' IS DISTINCT FROM xid
        OR pg_catalog.jsonb_typeof(parent) IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(parent))<>7
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(parent) k WHERE k NOT IN
          ('operationId','planId','stageDigest','requestHash','requirementIndex','entityKey','requirementProof'))
        OR parent->>'operationId' IS DISTINCT FROM NEW.parent_operation_id
        OR parent->>'planId' IS DISTINCT FROM NEW.plan_id OR parent->>'stageDigest' IS DISTINCT FROM NEW.stage_digest
        OR parent->>'requestHash' IS DISTINCT FROM NEW.request_hash OR parent->>'requirementIndex' IS DISTINCT FROM NEW.requirement_index::text
        OR parent->>'entityKey' IS DISTINCT FROM NEW.requirement_key OR parent->>'requirementProof' IS DISTINCT FROM NEW.requirement_proof
        OR pg_catalog.jsonb_typeof(binding) IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(binding))<>8
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(binding) k WHERE k NOT IN
          ('version','source','receipt','nativeInventory','nativeBinaryHash','nativeVectorHash','links','bindingProof'))
        OR binding->'version' IS DISTINCT FROM '1'::jsonb
        OR pg_catalog.jsonb_typeof(binding->'nativeBinaryHash') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(binding->'nativeVectorHash') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(binding->'bindingProof') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(birth->'birthProof') IS DISTINCT FROM 'string'
        OR ((binding->>'nativeBinaryHash') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
        OR ((binding->>'nativeVectorHash') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
        OR ((binding->>'bindingProof') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
        OR ((birth->>'birthProof') ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
        OR pg_catalog.jsonb_typeof(binding->'links') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_array_length(binding->'links')>20000
        OR pg_catalog.jsonb_typeof(origin) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(source) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(target) IS DISTINCT FROM 'object'
        OR receipt->>'operationId' IS DISTINCT FROM NEW.import_operation_id
        OR target->>'documentId' IS DISTINCT FROM NEW.document_id OR target->>'lineageId' IS DISTINCT FROM NEW.lineage_id
        OR target->>'workspaceId' IS DISTINCT FROM NEW.workspace_id OR target->'lifecycleGeneration' IS DISTINCT FROM '1'::jsonb
        OR target->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR target->'initialSequence' IS DISTINCT FROM '0'::jsonb
        OR target->>'persistedAt' IS DISTINCT FROM NEW.created_at::text
        OR source->'workspaceId' IS DISTINCT FROM origin->'sourceScope'->'workspaceId'
        OR source->'organizationId' IS DISTINCT FROM origin->'sourceScope'->'organizationId'
        OR target->'workspaceId' IS DISTINCT FROM origin->'destinationScope'->'workspaceId'
        OR target->'organizationId' IS DISTINCT FROM origin->'destinationScope'->'organizationId'
        OR source->'sourceHash' IS DISTINCT FROM receipt->'sourceHash'
        OR source->'sourceBytes' IS DISTINCT FROM receipt->'sourceBytes'
        OR binding->'nativeInventory'->'document'->>'documentId' IS DISTINCT FROM NEW.document_id
        OR binding->'nativeInventory'->'document'->>'path' IS DISTINCT FROM target->>'path'
        OR binding->'nativeInventory'->'contractVersion' IS DISTINCT FROM '2'::jsonb
        OR binding->'nativeInventory'->'parserVersion' IS DISTINCT FROM '3'::jsonb
        OR binding->'nativeInventory'->'version'->'documentSequence' IS DISTINCT FROM '0'::jsonb
        OR binding->'nativeInventory'->'version'->'stateProof' IS DISTINCT FROM target->'initialStateProof'
        OR binding->'nativeInventory'->'coverage'->'complete' IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION 'Raw Markdown Copy birth data changed' USING ERRCODE='23514';
      END IF;
      EXECUTE pg_catalog.format('SELECT coalesce(sum(octet_length(birth_text)),0)::bigint
        FROM %I.collaboration_native_copy_markdown_births WHERE workspace_id=$1 AND parent_operation_id=$2',TG_TABLE_SCHEMA)
        INTO previous_bytes USING NEW.workspace_id,NEW.parent_operation_id;
      IF previous_bytes+pg_catalog.octet_length(NEW.birth_text)>67108864 THEN
        RAISE EXCEPTION 'Raw Markdown Copy birth history exceeds its bounded protocol' USING ERRCODE='23514';
      END IF;
      -- Every relation is qualified with this table's real schema. No local
      -- search_path mutation can invalidate the owner's fixed B/XID witness.
      EXECUTE pg_catalog.format('SELECT p.kind,p.version,p.actor_user_id,p.actor_session_id,p.organization_id,
        p.publication_status,p.publication_fingerprint,p.xmin::text AS parent_xmin,
        o.plan_id,o.request_hash,o.source_workspace_id,o.destination_workspace_id,o.request_json,
        r.private_result,r.request_id,r.actor_user_id AS import_user,r.actor_session_id AS import_sid,
        r.live_yjs_state_sha256,r.live_state_vector_sha256,r.xmin::text AS import_xmin,
        d.workspace_type,d.customer_id,d.project_id,d.xmin::text AS document_xmin,
        s.xmin::text AS state_xmin,l.xmin::text AS lineage_xmin,
        s.document_sequence,s.lifecycle_generation,s.schema_version,s.room_owner_epoch,s.room_owner_token,
        s.room_owner_backend_pid,s.room_owner_backend_start,s.yjs_state,s.state_vector,
        d.workspace_id,d.organization_id AS document_org,d.path,d.lineage_id,s.representation,s.newline_style,s.has_bom,s.persisted_at
        FROM %I.collaboration_native_copy_receipts p JOIN %I.workspace_file_operations o ON o.operation_id=p.operation_id
        JOIN %I.collaboration_markdown_file_import_receipts r ON r.workspace_id=p.workspace_id AND r.operation_id=$3
        JOIN %I.collaboration_documents d ON d.id=$4 AND d.workspace_id=p.workspace_id AND d.provider=''yjs'' AND d.status=''active''
          AND d.yjs_state_lifecycle=''initialized''
        JOIN %I.collaboration_yjs_states s ON s.document_id=d.id AND s.status=''active'' AND s.workspace_id=d.workspace_id
          AND s.organization_id IS NOT DISTINCT FROM d.organization_id AND s.path=d.path
        JOIN %I.file_collaboration_lineages l ON l.id=d.lineage_id AND l.status=''active'' AND l.workspace_id=d.workspace_id
          AND l.organization_id IS NOT DISTINCT FROM d.organization_id AND l.path=d.path
        WHERE p.workspace_id=$1 AND p.operation_id=$2',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,
        TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
        INTO actual USING NEW.workspace_id,NEW.parent_operation_id,NEW.import_operation_id,NEW.document_id;
      GET DIAGNOSTICS actual_count = ROW_COUNT;
      IF actual_count<>1 OR actual.kind<>'native_clone' OR actual.version<>1 OR actual.publication_status<>'native_committed'
        OR actual.parent_xmin<>xmin32 OR actual.import_xmin<>xmin32 OR actual.document_xmin<>xmin32
        OR actual.state_xmin<>xmin32 OR actual.lineage_xmin<>xmin32
        OR actual.publication_fingerprint IS DISTINCT FROM NEW.stage_digest OR actual.plan_id IS DISTINCT FROM NEW.plan_id
        OR actual.request_hash IS DISTINCT FROM NEW.request_hash OR actual.destination_workspace_id IS DISTINCT FROM NEW.workspace_id
        OR actual.source_workspace_id IS DISTINCT FROM origin->'sourceScope'->>'workspaceId'
        OR actual.request_json::jsonb->'origin' IS DISTINCT FROM origin
        OR actual.actor_user_id IS DISTINCT FROM origin->'actor'->>'userId'
        OR actual.actor_session_id IS DISTINCT FROM origin->'actor'->>'sessionId'
        OR actual.import_user IS DISTINCT FROM actual.actor_user_id OR actual.import_sid IS DISTINCT FROM actual.actor_session_id
        OR actual.private_result IS DISTINCT FROM receipt
        OR actual.live_yjs_state_sha256 IS DISTINCT FROM binding->>'nativeBinaryHash'
        OR actual.live_state_vector_sha256 IS DISTINCT FROM binding->>'nativeVectorHash'
        OR actual.live_yjs_state_sha256 IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(actual.yjs_state),'hex')
        OR actual.live_state_vector_sha256 IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(actual.state_vector),'hex')
        OR actual.document_sequence<>0 OR actual.lifecycle_generation<>1 OR actual.schema_version<>1 OR actual.room_owner_epoch<>0
        OR actual.room_owner_token IS NOT NULL OR actual.room_owner_backend_pid IS NOT NULL OR actual.room_owner_backend_start IS NOT NULL
        OR actual.path IS DISTINCT FROM target->>'path' OR actual.lineage_id IS DISTINCT FROM NEW.lineage_id
        OR actual.document_org IS DISTINCT FROM target->>'organizationId' OR actual.organization_id IS DISTINCT FROM actual.document_org
        OR actual.workspace_type IS DISTINCT FROM origin->'destinationScope'->>'workspaceType'
        OR actual.customer_id IS DISTINCT FROM origin->'destinationScope'->>'customerId'
        OR actual.project_id IS DISTINCT FROM origin->'destinationScope'->>'projectId'
        OR actual.representation IS DISTINCT FROM target->>'representation' OR actual.newline_style IS DISTINCT FROM target->>'newlineStyle'
        OR pg_catalog.to_jsonb(actual.has_bom<>0) IS DISTINCT FROM target->'hasBom' OR actual.persisted_at<>NEW.created_at THEN
        RAISE EXCEPTION 'Raw Markdown Copy birth actual rows changed' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER native_copy_markdown_birth_guard
    BEFORE INSERT OR UPDATE OR DELETE ON collaboration_native_copy_markdown_births
    FOR EACH ROW EXECUTE FUNCTION validate_native_copy_markdown_birth()`,
] as const;
