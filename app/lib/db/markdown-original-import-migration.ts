/** Additive private original-import binding only; activation is wired separately.
 * No historical receipt, create-birth, or bootstrap contract is reinterpreted. */
export const MARKDOWN_ORIGINAL_IMPORT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_original_markdown_imports (
    workspace_id text NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 256),
    operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
    version integer NOT NULL CHECK (version=1),
    request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    original_text text NOT NULL CHECK (octet_length(original_text) BETWEEN 1 AND 65536),
    original_digest text NOT NULL CHECK (original_digest ~ '^[a-f0-9]{64}$'),
    import_fingerprint text NOT NULL CHECK (import_fingerprint ~ '^[a-f0-9]{64}$'),
    created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(workspace_id,operation_id),
    FOREIGN KEY(workspace_id,operation_id) REFERENCES collaboration_markdown_file_import_receipts(workspace_id,operation_id)
  )`,
  `CREATE OR REPLACE FUNCTION validate_original_markdown_import() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE original jsonb; selection jsonb; origin jsonb; receipt jsonb; target jsonb;
      actual_receipt record; value text; actual_schema_oid oid; actual_database_oid oid;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Original Markdown import bindings are immutable' USING ERRCODE='55000';
      END IF;
      -- Resolve the original receipt in this actual table's schema, never in a
      -- caller's shadow schema or an implicitly preferred temporary namespace.
      PERFORM pg_catalog.set_config('search_path',pg_catalog.quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      IF NEW.version<>1 OR NEW.workspace_id IS NULL OR length(NEW.workspace_id) NOT BETWEEN 1 AND 256
        OR NEW.workspace_id<>btrim(NEW.workspace_id) OR NEW.workspace_id ~ '[[:cntrl:]]'
        OR NEW.operation_id IS NULL OR NEW.operation_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
        OR NEW.request_digest IS NULL OR NEW.request_digest !~ '^[a-f0-9]{64}$'
        OR NEW.original_digest IS NULL OR NEW.original_digest !~ '^[a-f0-9]{64}$'
        OR NEW.import_fingerprint IS NULL OR NEW.import_fingerprint !~ '^[a-f0-9]{64}$'
        OR NEW.original_text IS NULL OR pg_catalog.octet_length(NEW.original_text) NOT BETWEEN 1 AND 65536
        OR NEW.created_at IS NULL OR NEW.created_at NOT BETWEEN 0 AND 9007199254740991
        OR NEW.original_digest IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.original_text,'UTF8')),'hex') THEN
        RAISE EXCEPTION 'Original Markdown import binding is unavailable' USING ERRCODE='23514';
      END IF;
      original:=NEW.original_text::jsonb;
      IF pg_catalog.jsonb_typeof(original) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Original Markdown import record is unavailable' USING ERRCODE='23514';
      END IF;
      selection:=original->'selection'; origin:=original->'origin'; receipt:=original->'receipt'; target:=receipt->'target';
      IF pg_catalog.jsonb_typeof(selection) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(origin) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(receipt) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(target) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Original Markdown import record scope is unavailable' USING ERRCODE='23514';
      END IF;
      IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(original))<>4
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(original) k WHERE k NOT IN ('version','selection','origin','receipt'))
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(selection))<>6
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(selection) k WHERE k NOT IN
          ('apiVersion','workspaceId','path','operationId','expectedFileVersion','initialRepresentation'))
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(origin))<>16
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(origin) k WHERE k NOT IN
          ('userId','sessionId','workspaceId','workspaceType','organizationId','projectId','customerId','ownerUserId',
           'rootPath','rootRelativePath','legacy','status','schema','schemaOid','databaseOid','searchPath'))
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(receipt))<>7
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(receipt) k WHERE k NOT IN
          ('version','operationId','requestFingerprint','sourceHash','sourceBytes','target','checkpointRequired'))
        OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(target))<>13
        OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(target) k WHERE k NOT IN
          ('documentId','workspaceId','organizationId','path','representation','schemaVersion','lifecycleGeneration',
           'newlineStyle','hasBom','lineageId','initialSequence','initialStateProof','persistedAt'))
        OR original->'version' IS DISTINCT FROM '1'::jsonb OR selection->'apiVersion' IS DISTINCT FROM '1'::jsonb
        OR selection->'workspaceId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.workspace_id)
        OR selection->'operationId' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.operation_id)
        OR origin->'workspaceId' IS DISTINCT FROM selection->'workspaceId'
        OR origin->'legacy' IS DISTINCT FROM 'false'::jsonb OR origin->'status' IS DISTINCT FROM '"active"'::jsonb
        OR pg_catalog.jsonb_typeof(origin->'workspaceType') IS DISTINCT FROM 'string'
        OR origin->>'workspaceType' NOT IN ('personal','organization','team','project')
        OR pg_catalog.jsonb_typeof(selection->'path') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(selection->'expectedFileVersion') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(selection->'initialRepresentation') IS DISTINCT FROM 'string'
        OR selection->>'initialRepresentation' NOT IN ('auto','plain_text','tiptap_xml','tiptap_blocks') THEN
        RAISE EXCEPTION 'Original Markdown import record fields are unavailable' USING ERRCODE='23514';
      END IF;
      value:=selection->>'path';
      IF length(value) NOT BETWEEN 1 AND 4096 OR value LIKE '/%' OR position(chr(92) IN value)>0 OR value ~ '[[:cntrl:]]'
        OR value !~* '[.](md|markdown)$'
        OR EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(value,'/')) part WHERE part IN ('','.','..'))
        OR length(selection->>'expectedFileVersion') NOT BETWEEN 1 AND 1024
        OR (selection->>'expectedFileVersion') !~ '^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+([.][0-9]+)?:-?[0-9]+([.][0-9]+)?$' THEN
        RAISE EXCEPTION 'Original Markdown import source is unavailable' USING ERRCODE='23514';
      END IF;
      FOREACH value IN ARRAY ARRAY['userId','sessionId','schema'] LOOP
        IF pg_catalog.jsonb_typeof(origin->value) IS DISTINCT FROM 'string'
          OR length(origin->>value) NOT BETWEEN 1 AND (CASE WHEN value='schema' THEN 63 ELSE 256 END)
          OR origin->>value<>btrim(origin->>value) OR origin->>value ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'Original Markdown import actor or schema is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      FOREACH value IN ARRAY ARRAY['organizationId','projectId','customerId','ownerUserId'] LOOP
        IF origin->value IS DISTINCT FROM 'null'::jsonb AND
          (pg_catalog.jsonb_typeof(origin->value) IS DISTINCT FROM 'string' OR length(origin->>value) NOT BETWEEN 1 AND 256
           OR origin->>value<>btrim(origin->>value) OR origin->>value ~ '[[:cntrl:]]') THEN
          RAISE EXCEPTION 'Original Markdown import workspace scope is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      IF pg_catalog.jsonb_typeof(origin->'rootPath') IS DISTINCT FROM 'string' OR length(origin->>'rootPath') NOT BETWEEN 1 AND 8192
        OR pg_catalog.jsonb_typeof(origin->'rootRelativePath') IS DISTINCT FROM 'string' OR length(origin->>'rootRelativePath')>4096
        OR pg_catalog.jsonb_typeof(origin->'searchPath') IS DISTINCT FROM 'string' OR length(origin->>'searchPath') NOT BETWEEN 1 AND 4096
        OR origin->>'rootPath' ~ '[[:cntrl:]]' OR origin->>'rootRelativePath' ~ '[[:cntrl:]]' OR origin->>'searchPath' ~ '[[:cntrl:]]'
        OR pg_catalog.jsonb_typeof(origin->'schemaOid') IS DISTINCT FROM 'number' OR (origin->>'schemaOid') !~ '^[1-9][0-9]*$'
        OR pg_catalog.jsonb_typeof(origin->'databaseOid') IS DISTINCT FROM 'number' OR (origin->>'databaseOid') !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'Original Markdown import realm is unavailable' USING ERRCODE='23514';
      END IF;
      SELECT n.oid INTO actual_schema_oid FROM pg_catalog.pg_namespace n WHERE n.nspname=TG_TABLE_SCHEMA;
      SELECT d.oid INTO actual_database_oid FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database();
      IF origin->'schema' IS DISTINCT FROM pg_catalog.to_jsonb(TG_TABLE_SCHEMA::text)
        OR (origin->>'schemaOid')::numeric IS DISTINCT FROM actual_schema_oid::bigint::numeric
        OR (origin->>'databaseOid')::numeric IS DISTINCT FROM actual_database_oid::bigint::numeric THEN
        RAISE EXCEPTION 'Original Markdown import actual namespace is unavailable' USING ERRCODE='23514';
      END IF;
      -- The receipt trigger already certifies the exact initial Yjs binary and
      -- vector. This row adds original request facts, never a replacement receipt.
      SELECT r.version,r.organization_id,r.actor_user_id,r.actor_session_id,r.request_id,r.request_fingerprint,r.private_result,r.created_at
        INTO actual_receipt FROM collaboration_markdown_file_import_receipts r
        WHERE r.workspace_id=NEW.workspace_id AND r.operation_id=NEW.operation_id FOR SHARE OF r;
      IF NOT FOUND OR actual_receipt.version<>1
        OR actual_receipt.actor_user_id IS DISTINCT FROM origin->>'userId'
        OR actual_receipt.actor_session_id IS DISTINCT FROM origin->>'sessionId'
        OR actual_receipt.request_id IS DISTINCT FROM 'original-import:'||NEW.operation_id
        OR actual_receipt.request_fingerprint IS DISTINCT FROM NEW.import_fingerprint
        OR actual_receipt.private_result IS DISTINCT FROM receipt
        OR actual_receipt.created_at IS DISTINCT FROM NEW.created_at
        OR origin->'organizationId' IS DISTINCT FROM coalesce(pg_catalog.to_jsonb(actual_receipt.organization_id),'null'::jsonb)
        OR receipt->'version' IS DISTINCT FROM '1'::jsonb
        OR receipt->'operationId' IS DISTINCT FROM selection->'operationId'
        OR receipt->'requestFingerprint' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.import_fingerprint)
        OR receipt->'checkpointRequired' IS DISTINCT FROM 'true'::jsonb
        OR target->'workspaceId' IS DISTINCT FROM selection->'workspaceId'
        OR target->'organizationId' IS DISTINCT FROM origin->'organizationId'
        OR target->'path' IS DISTINCT FROM selection->'path'
        OR target->'schemaVersion' IS DISTINCT FROM '1'::jsonb
        OR target->'lifecycleGeneration' IS DISTINCT FROM '1'::jsonb
        OR target->'initialSequence' IS DISTINCT FROM '0'::jsonb
        OR target->'persistedAt' IS DISTINCT FROM pg_catalog.to_jsonb(NEW.created_at)
        OR selection->>'initialRepresentation'<>'auto' AND selection->'initialRepresentation' IS DISTINCT FROM target->'representation' THEN
        RAISE EXCEPTION 'Original Markdown import actual receipt is unavailable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='collaboration_original_markdown_imports'::regclass
      AND tgname='original_markdown_import_guard') THEN
      CREATE TRIGGER original_markdown_import_guard BEFORE INSERT OR UPDATE OR DELETE
        ON collaboration_original_markdown_imports FOR EACH ROW EXECUTE FUNCTION validate_original_markdown_import();
    END IF;
  END $$`,
] as const;
