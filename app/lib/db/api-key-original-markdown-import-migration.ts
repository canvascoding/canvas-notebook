/** Additive key attribution to the existing native import receipt. Session V1
 * rows, guards, receipts and native snapshots are neither changed nor copied. */
export const API_KEY_ORIGINAL_MARKDOWN_IMPORT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_original_markdown_import_api_keys (
    workspace_id text NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
    operation_id text NOT NULL CHECK(operation_id ~ '^key-original-[a-f0-9]{64}$'),
    version integer NOT NULL CHECK(version=2),
    request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
    original_text text NOT NULL CHECK(octet_length(original_text) BETWEEN 1 AND 65536),
    original_digest text NOT NULL CHECK(original_digest ~ '^[a-f0-9]{64}$'),
    import_fingerprint text NOT NULL CHECK(import_fingerprint ~ '^[a-f0-9]{64}$'),
    created_at bigint NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(workspace_id,operation_id),
    FOREIGN KEY(workspace_id,operation_id) REFERENCES collaboration_markdown_file_import_receipts(workspace_id,operation_id)
  )`,
  `CREATE OR REPLACE FUNCTION validate_key_original_markdown_import() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE original jsonb; selection jsonb; origin jsonb; receipt jsonb; target jsonb;
    actual record; item text; schema_oid oid; database_oid oid;
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Key original import attribution is immutable' USING ERRCODE='55000';
    END IF;
    PERFORM pg_catalog.set_config('search_path',pg_catalog.quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
    IF NEW.version<>2 OR NEW.operation_id !~ '^key-original-[a-f0-9]{64}$'
      OR NEW.original_text IS NULL OR pg_catalog.octet_length(NEW.original_text) NOT BETWEEN 1 AND 65536
      OR NEW.original_digest IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.original_text,'UTF8')),'hex')
      OR NEW.request_digest !~ '^[a-f0-9]{64}$' OR NEW.import_fingerprint !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'Key original import attribution is unavailable' USING ERRCODE='23514';
    END IF;
    original:=NEW.original_text::jsonb;
    selection:=original->'selection'; origin:=original->'origin'; receipt:=original->'receipt'; target:=receipt->'target';
    IF pg_catalog.jsonb_typeof(original) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(selection) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(origin) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(receipt) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(target) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Key original import record is unavailable' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(original))<>5
      OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(original) k WHERE k NOT IN ('version','callerOperationId','selection','origin','receipt'))
      OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(selection))<>6
      OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(selection) k WHERE k NOT IN
        ('apiVersion','workspaceId','path','operationId','expectedFileVersion','initialRepresentation'))
      OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(origin))<>21
      OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(origin) k WHERE k NOT IN
        ('kind','userId','integrationId','instanceId','credentialId','workspaceId','workspaceType','organizationId','customerId','projectId',
         'ownerUserId','rootPath','rootRelativePath','legacy','status','schema','schemaOid','databaseOid','searchPath','purpose','entryPoint'))
      OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(receipt))<>7
      OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(receipt) k WHERE k NOT IN
        ('version','operationId','requestFingerprint','sourceHash','sourceBytes','target','checkpointRequired'))
      OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(target))<>13
      OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(target) k WHERE k NOT IN
        ('documentId','workspaceId','organizationId','path','representation','schemaVersion','lifecycleGeneration',
         'newlineStyle','hasBom','lineageId','initialSequence','initialStateProof','persistedAt'))
      OR original->'version' IS DISTINCT FROM '2'::jsonb
      OR pg_catalog.jsonb_typeof(original->'callerOperationId') IS DISTINCT FROM 'string'
      OR original->>'callerOperationId' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
      OR selection->'apiVersion' IS DISTINCT FROM '1'::jsonb
      OR selection->'workspaceId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.workspace_id)
      OR selection->'operationId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.operation_id)
      OR origin->'kind' IS DISTINCT FROM '"api_key"'::jsonb
      OR origin->'purpose' IS DISTINCT FROM '"import_existing"'::jsonb
      OR pg_catalog.jsonb_typeof(origin->'entryPoint') IS DISTINCT FROM 'string'
      OR origin->'entryPoint' NOT IN ('"request"'::jsonb,'"mcp"'::jsonb)
      OR origin->'workspaceId' IS DISTINCT FROM selection->'workspaceId'
      OR origin->'legacy' IS DISTINCT FROM 'false'::jsonb OR origin->'status' IS DISTINCT FROM '"active"'::jsonb
      OR pg_catalog.jsonb_typeof(origin->'workspaceType') IS DISTINCT FROM 'string'
      OR origin->>'workspaceType' NOT IN ('personal','organization','team','project') THEN
      RAISE EXCEPTION 'Key original import fields are unavailable' USING ERRCODE='23514';
    END IF;
    FOREACH item IN ARRAY ARRAY['userId','integrationId','instanceId','credentialId','workspaceId','schema'] LOOP
      IF pg_catalog.jsonb_typeof(origin->item) IS DISTINCT FROM 'string'
        OR length(origin->>item) NOT BETWEEN 1 AND (CASE WHEN item='schema' THEN 63 ELSE 256 END)
        OR origin->>item<>btrim(origin->>item) OR origin->>item ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Key original import identity is unavailable' USING ERRCODE='23514';
      END IF;
    END LOOP;
    FOREACH item IN ARRAY ARRAY['organizationId','customerId','projectId','ownerUserId'] LOOP
      IF origin->item IS DISTINCT FROM 'null'::jsonb AND (pg_catalog.jsonb_typeof(origin->item) IS DISTINCT FROM 'string'
        OR length(origin->>item) NOT BETWEEN 1 AND 256 OR origin->>item<>btrim(origin->>item) OR origin->>item ~ '[[:cntrl:]]') THEN
        RAISE EXCEPTION 'Key original import workspace is unavailable' USING ERRCODE='23514';
      END IF;
    END LOOP;
    IF pg_catalog.jsonb_typeof(selection->'path') IS DISTINCT FROM 'string'
      OR length(selection->>'path') NOT BETWEEN 1 AND 4096 OR selection->>'path' LIKE '/%'
      OR position(chr(92) IN selection->>'path')>0 OR selection->>'path' ~ '[[:cntrl:]]'
      OR selection->>'path' !~* '[.](md|markdown)$'
      OR EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(selection->>'path','/')) part WHERE part IN ('','.','..'))
      OR origin->>'entryPoint'='mcp' AND EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(selection->>'path','/')) part WHERE part LIKE '.%')
      OR pg_catalog.jsonb_typeof(selection->'expectedFileVersion') IS DISTINCT FROM 'string'
      OR length(selection->>'expectedFileVersion') NOT BETWEEN 1 AND 1024
      OR selection->>'expectedFileVersion' !~ '^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+([.][0-9]+)?:-?[0-9]+([.][0-9]+)?$'
      OR pg_catalog.jsonb_typeof(selection->'initialRepresentation') IS DISTINCT FROM 'string'
      OR selection->>'initialRepresentation' NOT IN ('auto','plain_text','tiptap_xml','tiptap_blocks')
      OR pg_catalog.jsonb_typeof(origin->'rootPath') IS DISTINCT FROM 'string' OR length(origin->>'rootPath') NOT BETWEEN 1 AND 8192
      OR pg_catalog.jsonb_typeof(origin->'rootRelativePath') IS DISTINCT FROM 'string' OR length(origin->>'rootRelativePath')>4096
      OR pg_catalog.jsonb_typeof(origin->'searchPath') IS DISTINCT FROM 'string' OR length(origin->>'searchPath') NOT BETWEEN 1 AND 4096
      OR origin->>'rootPath' ~ '[[:cntrl:]]' OR origin->>'rootRelativePath' ~ '[[:cntrl:]]' OR origin->>'searchPath' ~ '[[:cntrl:]]'
      OR pg_catalog.jsonb_typeof(origin->'schemaOid') IS DISTINCT FROM 'number' OR origin->>'schemaOid' !~ '^[1-9][0-9]*$'
      OR pg_catalog.jsonb_typeof(origin->'databaseOid') IS DISTINCT FROM 'number' OR origin->>'databaseOid' !~ '^[1-9][0-9]*$'
      OR (origin->>'schemaOid')::numeric>9007199254740991 OR (origin->>'databaseOid')::numeric>9007199254740991 THEN
      RAISE EXCEPTION 'Key original import source or realm is unavailable' USING ERRCODE='23514';
    END IF;
    SELECT n.oid INTO schema_oid FROM pg_catalog.pg_namespace n WHERE n.nspname=TG_TABLE_SCHEMA;
    SELECT d.oid INTO database_oid FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database();
    IF origin->'schema' IS DISTINCT FROM pg_catalog.to_jsonb(TG_TABLE_SCHEMA::text)
      OR (origin->>'schemaOid')::numeric IS DISTINCT FROM schema_oid::bigint::numeric
      OR (origin->>'databaseOid')::numeric IS DISTINCT FROM database_oid::bigint::numeric THEN
      RAISE EXCEPTION 'Key original import actual namespace is unavailable' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM canvas_api_keys k JOIN canvas_api_integrations i ON i.id=k.integration_id
      WHERE k.id=origin->>'credentialId' AND i.id=origin->>'integrationId' AND i.owner_user_id=origin->>'userId'
        AND i.instance_id=origin->>'instanceId' AND k.revoked_at IS NULL AND k.created_at<=NEW.created_at AND k.expires_at>NEW.created_at
      FOR SHARE OF k,i;
    IF NOT FOUND THEN RAISE EXCEPTION 'Key original import issuer is unavailable' USING ERRCODE='23514'; END IF;
    SELECT r.version,r.organization_id,r.actor_user_id,r.actor_session_id,r.request_id,r.request_fingerprint,r.private_result,r.created_at
      INTO actual FROM collaboration_markdown_file_import_receipts r
      WHERE r.workspace_id=NEW.workspace_id AND r.operation_id=NEW.operation_id FOR SHARE OF r;
    IF NOT FOUND OR actual.version<>1 OR actual.actor_user_id IS DISTINCT FROM origin->>'userId' OR actual.actor_session_id IS NOT NULL
      OR actual.request_id IS DISTINCT FROM 'key-original-import:'||NEW.operation_id
      OR actual.request_fingerprint IS DISTINCT FROM NEW.import_fingerprint OR actual.private_result IS DISTINCT FROM receipt
      OR actual.created_at IS DISTINCT FROM NEW.created_at
      OR origin->'organizationId' IS DISTINCT FROM coalesce(pg_catalog.to_jsonb(actual.organization_id),'null'::jsonb)
      OR receipt->'version' IS DISTINCT FROM '1'::jsonb OR receipt->'operationId' IS DISTINCT FROM selection->'operationId'
      OR receipt->'requestFingerprint' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.import_fingerprint)
      OR receipt->'checkpointRequired' IS DISTINCT FROM 'true'::jsonb
      OR target->'workspaceId' IS DISTINCT FROM selection->'workspaceId' OR target->'organizationId' IS DISTINCT FROM origin->'organizationId'
      OR target->'path' IS DISTINCT FROM selection->'path' OR target->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR target->'lifecycleGeneration' IS DISTINCT FROM '1'::jsonb OR target->'initialSequence' IS DISTINCT FROM '0'::jsonb
      OR target->'persistedAt' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.created_at)
      OR selection->>'initialRepresentation'<>'auto' AND selection->'initialRepresentation' IS DISTINCT FROM target->'representation' THEN
      RAISE EXCEPTION 'Key original import actual native receipt is unavailable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='collaboration_original_markdown_import_api_keys'::regclass
      AND tgname='key_original_markdown_import_guard') THEN
      CREATE TRIGGER key_original_markdown_import_guard BEFORE INSERT OR UPDATE OR DELETE
        ON collaboration_original_markdown_import_api_keys FOR EACH ROW EXECUTE FUNCTION validate_key_original_markdown_import();
    END IF;
  END $$`,
] as const;
