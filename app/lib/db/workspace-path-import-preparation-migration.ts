/** Additive B0 original-import preparation only. Wiring/activation belongs to
 * the genuine coordinator. No old plan, import receipt or owner is redefined. */
export const WORKSPACE_PATH_IMPORT_PREPARATION_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspace_path_import_preparations (
    workspace_id text NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 256),
    batch_id text NOT NULL CHECK (batch_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512 AND octet_length(operation_id)<=2048),
    version integer NOT NULL CHECK (version=1),
    preview_plan_id text NOT NULL CHECK (preview_plan_id ~ '^[a-f0-9]{64}$'),
    native_plan_id text NOT NULL CHECK (native_plan_id ~ '^[a-f0-9]{64}$'),
    record_text text NOT NULL CHECK (octet_length(record_text) BETWEEN 1 AND 16777216),
    record_digest text NOT NULL CHECK (record_digest ~ '^[a-f0-9]{64}$'),
    b0_xid text NOT NULL CHECK (b0_xid ~ '^[1-9][0-9]{0,19}$' AND b0_xid::numeric<=18446744073709551615),
    created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(workspace_id,batch_id)
  )`,
  `CREATE OR REPLACE FUNCTION validate_workspace_path_import_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE original jsonb; origin jsonb; scope jsonb; realm jsonb; preview jsonb; native_plan jsonb; native_evidence jsonb;
      imports jsonb; requirements jsonb; item jsonb; requirement jsonb; receipt jsonb; target jsonb; native_binding jsonb;
      actual_receipt record; actual_native record; actual_workspace record; indexed record; value text; child_digest text;
      current_xid text; current_xmin text; schema_oid oid; database_oid oid; bound_count bigint;
      expected_review text; selection_bytes text; expected_batch text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Workspace path import preparations are immutable' USING ERRCODE='55000';
      END IF;
      PERFORM pg_catalog.set_config('search_path',pg_catalog.quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      current_xid:=pg_catalog.pg_current_xact_id()::text;
      current_xmin:=(current_xid::numeric % 4294967296)::text;
      IF NEW.version<>1 OR NEW.workspace_id IS NULL OR length(NEW.workspace_id) NOT BETWEEN 1 AND 256
        OR NEW.workspace_id<>btrim(NEW.workspace_id) OR NEW.workspace_id ~ '[[:cntrl:]]'
        OR NEW.batch_id IS NULL OR NEW.batch_id !~ '^[A-Za-z0-9_-]{16,128}$'
        OR NEW.operation_id IS NULL OR length(NEW.operation_id) NOT BETWEEN 1 AND 512
        OR pg_catalog.octet_length(NEW.operation_id)>2048 OR NEW.operation_id ~ '[[:cntrl:]]'
        OR NEW.preview_plan_id IS NULL OR NEW.preview_plan_id !~ '^[a-f0-9]{64}$'
        OR NEW.native_plan_id IS NULL OR NEW.native_plan_id !~ '^[a-f0-9]{64}$'
        OR NEW.record_digest IS NULL OR NEW.record_digest !~ '^[a-f0-9]{64}$'
        OR NEW.record_text IS NULL OR pg_catalog.octet_length(NEW.record_text) NOT BETWEEN 1 AND 16777216
        OR NEW.record_digest IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.record_text,'UTF8')),'hex')
        OR NEW.b0_xid IS DISTINCT FROM current_xid OR NEW.created_at IS NULL
        OR NEW.created_at NOT BETWEEN 0 AND 9007199254740991 THEN
        RAISE EXCEPTION 'Workspace path import preparation header is unavailable' USING ERRCODE='23514';
      END IF;
      original:=NEW.record_text::jsonb;
      IF pg_catalog.jsonb_typeof(original) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Workspace path import preparation record is unavailable' USING ERRCODE='23514';
      END IF;
      origin:=original->'origin'; scope:=origin->'scope'; realm:=origin->'realm'; preview:=original->'previewPlan';
      native_plan:=original->'nativePlan'; imports:=original->'imports'; requirements:=preview->'importRequirements';
      IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(original))<>10
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(original) k WHERE k NOT IN
          ('version','operationId','batchId','origin','previewPlan','imports','nativePlan','b0TransactionId','preparedAt','recordProof'))
        OR original->'version' IS DISTINCT FROM '1'::jsonb
        OR original->'operationId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.operation_id)
        OR original->'batchId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.batch_id)
        OR original->'b0TransactionId' IS DISTINCT FROM pg_catalog.to_jsonb(current_xid)
        OR original->'preparedAt' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.created_at)
        OR pg_catalog.jsonb_typeof(original->'recordProof') IS DISTINCT FROM 'string'
        OR (original->>'recordProof') !~ '^[a-f0-9]{64}$'
        OR pg_catalog.jsonb_typeof(origin) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(scope) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(realm) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(preview) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(native_plan) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(imports) IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_typeof(requirements) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Workspace path import preparation fields are unavailable' USING ERRCODE='23514';
      END IF;
      -- The TS codec serializes recursively sorted exact JSON. recordProof is
      -- the SHA of that canonical body without its one top-level proof field.
      -- It is never an authority token. Historical readers repeat the codec.
      -- Anchor the canonical root suffix: a similarly named nested attr must
      -- never be mistaken for this envelope's proof field.
      IF NEW.record_text !~ ',"recordProof":"[a-f0-9]{64}","version":1[}]$'
        OR original->>'recordProof' IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.regexp_replace(NEW.record_text,',"recordProof":"[a-f0-9]{64}","version":1[}]$',',"version":1}'),'UTF8')),'hex')
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(origin))<>8
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(origin) k WHERE k NOT IN
          ('version','kind','userId','sessionId','clientId','tool','scope','realm'))
        OR origin->'version' IS DISTINCT FROM '1'::jsonb OR origin->>'kind' NOT IN ('request','direct-mcp')
        OR pg_catalog.jsonb_typeof(origin->'kind') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(origin->'tool') IS DISTINCT FROM 'string' OR origin->>'tool' NOT IN ('move','rename','delete')
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(realm))<>3
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(realm) k WHERE k NOT IN ('schemaName','schemaOid','databaseOid'))
        OR scope->'version' IS DISTINCT FROM '1'::jsonb OR scope->'workspaceId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.workspace_id)
        OR scope->'legacy' IS DISTINCT FROM 'false'::jsonb
        OR origin->'tool' IS DISTINCT FROM preview#>'{request,kind}' OR preview->'version' IS DISTINCT FROM '1'::jsonb
        OR preview->'kind' IS DISTINCT FROM '"native-path-import-preparation"'::jsonb
        OR preview->'executionReady' IS DISTINCT FROM 'false'::jsonb
        OR preview->'readiness' IS DISTINCT FROM '"requires-import-rebinding"'::jsonb
        OR preview->'planId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.preview_plan_id) OR preview->'scope' IS DISTINCT FROM scope
        OR native_plan->'planId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.native_plan_id)
        OR native_plan->'workspaceId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.workspace_id)
        OR native_plan->'readiness' IS DISTINCT FROM '"ready"'::jsonb
        OR native_plan->'planIdentityVersion' NOT IN ('2'::jsonb,'3'::jsonb)
        OR pg_catalog.jsonb_typeof(native_plan->'planIdentityVersion') IS DISTINCT FROM 'number'
        OR native_plan#>'{sourceEvidence,workspaceScope}' IS DISTINCT FROM scope
        OR pg_catalog.jsonb_typeof(native_plan->'actions') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_array_length(native_plan->'actions')<>1
        OR native_plan#>'{actions,0,kind}' IS DISTINCT FROM origin->'tool'
        OR native_plan#>'{actions,0,selections}' IS DISTINCT FROM preview#>'{request,selections}'
        OR (origin->>'tool'='delete' AND native_plan->'version' IS DISTINCT FROM '2'::jsonb)
        OR (origin->>'tool'<>'delete' AND native_plan->'version' IS DISTINCT FROM '3'::jsonb)
        OR pg_catalog.jsonb_array_length(imports) NOT BETWEEN 1 AND 10000
        OR pg_catalog.jsonb_array_length(imports)<>pg_catalog.jsonb_array_length(requirements) THEN
        RAISE EXCEPTION 'Workspace path import preparation original scope is unavailable' USING ERRCODE='23514';
      END IF;
      FOREACH value IN ARRAY ARRAY['userId','sessionId'] LOOP
        IF pg_catalog.jsonb_typeof(origin->value) IS DISTINCT FROM 'string' OR length(origin->>value) NOT BETWEEN 1 AND 256
          OR origin->>value<>btrim(origin->>value) OR origin->>value ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'Workspace path import preparation actor is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      IF origin->>'kind'='request' AND origin->'clientId' IS DISTINCT FROM 'null'::jsonb
        OR origin->>'kind'='direct-mcp' AND (pg_catalog.jsonb_typeof(origin->'clientId') IS DISTINCT FROM 'string'
          OR length(origin->>'clientId') NOT BETWEEN 1 AND 256 OR origin->>'clientId'<>btrim(origin->>'clientId')
          OR origin->>'clientId' ~ '[[:cntrl:]]' OR NEW.operation_id !~ '^[A-Za-z0-9_-]{16,128}$') THEN
        RAISE EXCEPTION 'Workspace path import preparation transport is unavailable' USING ERRCODE='23514';
      END IF;
      expected_batch:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        CASE WHEN origin->>'kind'='request' THEN '["workspace-path-operation-id-v1",'||pg_catalog.to_json(NEW.workspace_id)::text||','||
          pg_catalog.to_json(origin->>'userId')::text||','||pg_catalog.to_json(NEW.operation_id)::text||']'
        ELSE '["workspace-path-operation-direct-mcp-id-v1",'||pg_catalog.to_json(origin->>'userId')::text||','||
          pg_catalog.to_json(origin->>'clientId')::text||','||pg_catalog.to_json(NEW.workspace_id)::text||','||
          pg_catalog.to_json(CASE WHEN origin->>'tool'='delete' THEN 'delete_knowledge_source' ELSE 'move_knowledge_source' END)::text||','||
          pg_catalog.to_json(NEW.operation_id)::text||']' END,'UTF8')),'hex');
      IF NEW.batch_id IS DISTINCT FROM expected_batch THEN
        RAISE EXCEPTION 'Workspace path import preparation original batch differs' USING ERRCODE='23514';
      END IF;
      SELECT '['||coalesce(pg_catalog.string_agg('{"sourcePath":'||pg_catalog.to_json(s.value->>'sourcePath')::text||
        CASE WHEN origin->>'tool'='delete' THEN '' ELSE ',"destinationPath":'||pg_catalog.to_json(s.value->>'destinationPath')::text END||'}',
        ',' ORDER BY s.ordinality),'')||']' INTO selection_bytes
        FROM pg_catalog.jsonb_array_elements(preview#>'{request,selections}') WITH ORDINALITY s(value,ordinality);
      expected_review:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('["workspace-path-action-v1",'||
        pg_catalog.to_json(NEW.workspace_id)::text||','||pg_catalog.to_json(origin->>'tool')::text||','||selection_bytes||',false,false]','UTF8')),'hex')||'-request';
      IF native_plan#>>'{actions,0,reviewId}' IS DISTINCT FROM expected_review THEN
        RAISE EXCEPTION 'Workspace path import preparation native action differs' USING ERRCODE='23514';
      END IF;
      SELECT n.oid INTO schema_oid FROM pg_catalog.pg_namespace n WHERE n.nspname=TG_TABLE_SCHEMA;
      SELECT d.oid INTO database_oid FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database();
      IF realm->'schemaName' IS DISTINCT FROM pg_catalog.to_jsonb(TG_TABLE_SCHEMA::text)
        OR realm->'schemaOid' IS DISTINCT FROM pg_catalog.to_jsonb(schema_oid::bigint)
        OR realm->'databaseOid' IS DISTINCT FROM pg_catalog.to_jsonb(database_oid::bigint) THEN
        RAISE EXCEPTION 'Workspace path import preparation actual realm is unavailable' USING ERRCODE='23514';
      END IF;
      SELECT id,type,organization_id,customer_id,project_id,owner_user_id,root_relative_path,status INTO actual_workspace
        FROM canvas_workspaces WHERE id=NEW.workspace_id FOR SHARE;
      IF NOT FOUND OR actual_workspace.status<>'active'
        OR scope->'workspaceType' IS DISTINCT FROM pg_catalog.to_jsonb(actual_workspace.type)
        OR scope->'organizationId' IS DISTINCT FROM coalesce(pg_catalog.to_jsonb(actual_workspace.organization_id),'null'::jsonb)
        OR scope->'customerId' IS DISTINCT FROM coalesce(pg_catalog.to_jsonb(actual_workspace.customer_id),'null'::jsonb)
        OR scope->'projectId' IS DISTINCT FROM coalesce(pg_catalog.to_jsonb(actual_workspace.project_id),'null'::jsonb)
        OR scope->'ownerUserId' IS DISTINCT FROM coalesce(pg_catalog.to_jsonb(actual_workspace.owner_user_id),'null'::jsonb)
        OR scope->'rootRelativePath' IS DISTINCT FROM pg_catalog.to_jsonb(actual_workspace.root_relative_path) THEN
        RAISE EXCEPTION 'Workspace path import preparation actual workspace is unavailable' USING ERRCODE='23514';
      END IF;
      native_evidence:=CASE WHEN native_plan#>'{sourceEvidence,evidenceVersion}'='3'::jsonb
        THEN native_plan#>'{sourceEvidence,nativeComponent}' ELSE native_plan->'sourceEvidence' END;
      IF native_evidence->'evidenceVersion' IS DISTINCT FROM '2'::jsonb
        OR pg_catalog.jsonb_typeof(native_evidence->'nativeBindings') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Workspace path import preparation native witness is unavailable' USING ERRCODE='23514';
      END IF;
      IF (SELECT count(DISTINCT e#>>'{receipt,operationId}') FROM pg_catalog.jsonb_array_elements(imports) e)<>pg_catalog.jsonb_array_length(imports)
        OR (SELECT count(DISTINCT e#>>'{receipt,target,documentId}') FROM pg_catalog.jsonb_array_elements(imports) e)<>pg_catalog.jsonb_array_length(imports)
        OR (SELECT count(DISTINCT e#>>'{receipt,target,lineageId}') FROM pg_catalog.jsonb_array_elements(imports) e)<>pg_catalog.jsonb_array_length(imports) THEN
        RAISE EXCEPTION 'Workspace path import preparation cohort is not unique' USING ERRCODE='23514';
      END IF;
      FOR indexed IN SELECT e.value,e.ordinality FROM pg_catalog.jsonb_array_elements(imports) WITH ORDINALITY e(value,ordinality) LOOP
        item:=indexed.value; requirement:=requirements->((indexed.ordinality-1)::integer); receipt:=item->'receipt'; target:=receipt->'target';
        IF pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(item))<>5
          OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(item) k WHERE k NOT IN
            ('requirementIndex','receipt','bindingProof','initialBinaryHash','initialVectorHash'))
          OR item->'requirementIndex' IS DISTINCT FROM pg_catalog.to_jsonb(indexed.ordinality-1)
          OR pg_catalog.jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(target) IS DISTINCT FROM 'object'
          OR pg_catalog.jsonb_typeof(requirement) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'Workspace path import preparation ordered import is unavailable' USING ERRCODE='23514';
        END IF;
        FOREACH value IN ARRAY ARRAY['bindingProof','initialBinaryHash','initialVectorHash'] LOOP
          IF pg_catalog.jsonb_typeof(item->value) IS DISTINCT FROM 'string' OR item->>value !~ '^[a-f0-9]{64}$' THEN
            RAISE EXCEPTION 'Workspace path import preparation import proof is unavailable' USING ERRCODE='23514';
          END IF;
        END LOOP;
        -- Match the exact JS child-ID JSON bytes; JSON array text here is
        -- assembled without jsonb's display spaces or object key reordering.
        child_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          '["workspace-path-original-markdown-import-v1",'||pg_catalog.to_json(NEW.operation_id)::text||','||
          pg_catalog.to_json(NEW.preview_plan_id)::text||','||(indexed.ordinality-1)::text||']','UTF8')),'hex');
        SELECT version,organization_id,actor_user_id,actor_session_id,request_id,request_fingerprint,private_result,created_at,
          live_yjs_state_sha256,live_state_vector_sha256,xmin::text AS xmin,
          CASE WHEN pg_catalog.octet_length(after_state_snapshot) BETWEEN 1 AND 8388608
            THEN 'yjs-snapshot-sha256-v1:'||pg_catalog.encode(pg_catalog.sha256(after_state_snapshot),'hex') END AS snapshot_proof
          INTO actual_receipt FROM collaboration_markdown_file_import_receipts
          WHERE workspace_id=NEW.workspace_id AND operation_id='path-import-'||child_digest FOR SHARE;
        IF NOT FOUND OR actual_receipt.version<>1 OR actual_receipt.xmin<>current_xmin
          OR actual_receipt.actor_user_id IS DISTINCT FROM origin->>'userId'
          OR actual_receipt.actor_session_id IS DISTINCT FROM origin->>'sessionId'
          OR actual_receipt.request_id IS DISTINCT FROM 'path-original-import:'||child_digest
          OR actual_receipt.private_result IS DISTINCT FROM receipt
          OR receipt->'operationId' IS DISTINCT FROM pg_catalog.to_jsonb('path-import-'||child_digest)
          OR receipt->'requestFingerprint' IS DISTINCT FROM pg_catalog.to_jsonb(actual_receipt.request_fingerprint)
          OR actual_receipt.live_yjs_state_sha256 IS NULL OR actual_receipt.live_state_vector_sha256 IS NULL
          OR item->'initialBinaryHash' IS DISTINCT FROM pg_catalog.to_jsonb(actual_receipt.live_yjs_state_sha256)
          OR item->'initialVectorHash' IS DISTINCT FROM pg_catalog.to_jsonb(actual_receipt.live_state_vector_sha256)
          OR actual_receipt.snapshot_proof IS DISTINCT FROM target->>'initialStateProof'
          OR target->'workspaceId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.workspace_id)
          OR target->'organizationId' IS DISTINCT FROM scope->'organizationId'
          OR scope->'organizationId' IS DISTINCT FROM coalesce(pg_catalog.to_jsonb(actual_receipt.organization_id),'null'::jsonb)
          OR target->'path' IS DISTINCT FROM requirement->'path' OR requirement->'workspaceId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.workspace_id)
          OR receipt->'sourceHash' IS DISTINCT FROM requirement#>'{physical,byteHash}'
          OR receipt->'sourceBytes' IS DISTINCT FROM requirement#>'{physical,byteLength}'
          OR receipt->'sourceHash' IS DISTINCT FROM requirement#>'{preparation,sourceHash}'
          OR receipt->'sourceBytes' IS DISTINCT FROM requirement#>'{preparation,sourceBytes}'
          OR target->'representation' IS DISTINCT FROM requirement#>'{preparation,representation}'
          OR target->'newlineStyle' IS DISTINCT FROM requirement#>'{preparation,newlineStyle}'
          OR target->'hasBom' IS DISTINCT FROM requirement#>'{preparation,hasBom}'
          OR target->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR target->'lifecycleGeneration' IS DISTINCT FROM '1'::jsonb
          OR target->'initialSequence' IS DISTINCT FROM '0'::jsonb
          OR target->'persistedAt' IS DISTINCT FROM pg_catalog.to_jsonb(actual_receipt.created_at)
          OR actual_receipt.created_at>NEW.created_at THEN
          RAISE EXCEPTION 'Workspace path import preparation actual receipt is unavailable' USING ERRCODE='23514';
        END IF;
        SELECT count(*) INTO bound_count FROM pg_catalog.jsonb_array_elements(native_evidence->'nativeBindings') b
          WHERE b#>'{expected,documentId}'=target->'documentId';
        SELECT b INTO native_binding FROM pg_catalog.jsonb_array_elements(native_evidence->'nativeBindings') b
          WHERE b#>'{expected,documentId}'=target->'documentId' LIMIT 1;
        IF bound_count<>1 OR native_binding#>'{expected,lineageId}' IS DISTINCT FROM target->'lineageId'
          OR native_binding#>'{expected,workspaceId}' IS DISTINCT FROM target->'workspaceId'
          OR native_binding#>'{expected,organizationId}' IS DISTINCT FROM target->'organizationId'
          OR native_binding#>'{expected,path}' IS DISTINCT FROM target->'path'
          OR native_binding#>'{expected,representation}' IS DISTINCT FROM target->'representation'
          OR native_binding#>'{expected,lifecycleGeneration}' IS DISTINCT FROM target->'lifecycleGeneration'
          OR native_binding#>'{expected,schemaVersion}' IS DISTINCT FROM target->'schemaVersion'
          OR native_binding#>'{expected,registryStateVersion}' IS DISTINCT FROM '0'::jsonb
          OR native_binding#>'{expected,documentSequence}' IS DISTINCT FROM target->'initialSequence'
          OR native_binding#>'{expected,persistedAt}' IS DISTINCT FROM target->'persistedAt'
          OR native_binding#>'{expected,stateProof}' IS DISTINCT FROM target->'initialStateProof'
          OR native_binding#>'{expected,binaryHash}' IS DISTINCT FROM item->'initialBinaryHash'
          OR native_binding#>'{expected,vectorHash}' IS DISTINCT FROM item->'initialVectorHash'
          OR native_binding#>'{byteProfile,newlineStyle}' IS DISTINCT FROM target->'newlineStyle'
          OR native_binding#>'{byteProfile,hasBom}' IS DISTINCT FROM target->'hasBom' THEN
          RAISE EXCEPTION 'Workspace path import preparation initial native witness differs' USING ERRCODE='23514';
        END IF;
        SELECT d.xmin::text AS d_xmin,s.xmin::text AS s_xmin,s.document_sequence,s.persisted_at,
          pg_catalog.encode(pg_catalog.sha256(s.yjs_state),'hex') AS binary_hash,
          pg_catalog.encode(pg_catalog.sha256(s.state_vector),'hex') AS vector_hash,
          s.room_owner_epoch,s.room_owner_token,s.room_owner_backend_pid,s.room_owner_backend_start
          INTO actual_native FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
          JOIN file_collaboration_lineages l ON l.id=d.lineage_id
          WHERE d.id=target->>'documentId' AND d.lineage_id=target->>'lineageId' AND d.workspace_id=NEW.workspace_id
            AND d.organization_id IS NOT DISTINCT FROM actual_receipt.organization_id AND d.path=target->>'path'
            AND d.provider='yjs' AND d.status='active' AND d.yjs_state_lifecycle='initialized' AND d.state_version=0
            AND d.workspace_type=scope->>'workspaceType'
            AND coalesce(pg_catalog.to_jsonb(d.customer_id),'null'::jsonb)=native_binding#>'{registry,customerId}'
            AND coalesce(pg_catalog.to_jsonb(d.project_id),'null'::jsonb)=native_binding#>'{registry,projectId}'
            AND l.workspace_id=NEW.workspace_id AND l.organization_id IS NOT DISTINCT FROM d.organization_id AND l.path=d.path AND l.status='active'
            AND l.workspace_type=d.workspace_type AND l.archived_at IS NULL
            AND coalesce(pg_catalog.to_jsonb(l.customer_id),'null'::jsonb)=native_binding#>'{lineage,customerId}'
            AND coalesce(pg_catalog.to_jsonb(l.project_id),'null'::jsonb)=native_binding#>'{lineage,projectId}'
            AND coalesce(pg_catalog.to_jsonb(l.trash_entry_id),'null'::jsonb)=native_binding#>'{lineage,trashEntryId}'
            AND s.workspace_id=NEW.workspace_id AND s.organization_id IS NOT DISTINCT FROM d.organization_id AND s.path=d.path AND s.status='active'
            AND s.representation=target->>'representation' AND s.schema_version=1 AND s.lifecycle_generation=1 AND s.document_sequence=0
            AND s.persisted_at=actual_receipt.created_at AND s.newline_style=target->>'newlineStyle' AND pg_catalog.to_jsonb(s.has_bom<>0)=target->'hasBom'
            AND pg_catalog.octet_length(s.yjs_state) BETWEEN 1 AND 67108864 AND pg_catalog.octet_length(s.state_vector) BETWEEN 1 AND 1048576
          FOR SHARE OF d,s,l;
        IF NOT FOUND OR actual_native.d_xmin<>current_xmin OR actual_native.s_xmin<>current_xmin
          OR actual_native.binary_hash IS DISTINCT FROM actual_receipt.live_yjs_state_sha256
          OR actual_native.vector_hash IS DISTINCT FROM actual_receipt.live_state_vector_sha256
          OR actual_native.room_owner_epoch IS DISTINCT FROM 0::bigint OR actual_native.room_owner_token IS NOT NULL
          OR actual_native.room_owner_backend_pid IS NOT NULL OR actual_native.room_owner_backend_start IS NOT NULL THEN
          RAISE EXCEPTION 'Workspace path import preparation actual initial rows differ' USING ERRCODE='23514';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='workspace_path_import_preparations'::regclass
      AND tgname='workspace_path_import_preparation_guard') THEN
      CREATE TRIGGER workspace_path_import_preparation_guard BEFORE INSERT OR UPDATE OR DELETE
        ON workspace_path_import_preparations FOR EACH ROW EXECUTE FUNCTION validate_workspace_path_import_preparation();
    END IF;
  END $$`,
] as const;
