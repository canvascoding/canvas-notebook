/** Private atomic import ledger. Global migration/dispatch activation belongs
 * to the coordinating caller; no native payload is part of a public response. */
export const MARKDOWN_FILE_IMPORT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_markdown_file_import_receipts (
    workspace_id text NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 256),
    operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
    organization_id text CHECK (organization_id IS NULL OR length(organization_id) BETWEEN 1 AND 256),
    actor_user_id text NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 256),
    actor_session_id text CHECK (actor_session_id IS NULL OR length(actor_session_id) BETWEEN 1 AND 256),
    request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
    version integer NOT NULL CHECK (version=1),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    private_result jsonb NOT NULL CHECK (jsonb_typeof(private_result)='object' AND octet_length(private_result::text)<=32768),
    after_state_snapshot bytea NOT NULL CHECK (octet_length(after_state_snapshot)>0 AND octet_length(after_state_snapshot)<=8388608),
    created_at bigint NOT NULL CHECK (created_at>=0),
    PRIMARY KEY (workspace_id,operation_id),
    UNIQUE NULLS NOT DISTINCT (workspace_id,actor_user_id,actor_session_id,request_id)
  )`,
  // Historical receipts must never be backfilled from a later peer state.
  `ALTER TABLE collaboration_markdown_file_import_receipts
    ADD COLUMN IF NOT EXISTS live_yjs_state_sha256 text CHECK (live_yjs_state_sha256 ~ '^[a-f0-9]{64}$'),
    ADD COLUMN IF NOT EXISTS live_state_vector_sha256 text CHECK (live_state_vector_sha256 ~ '^[a-f0-9]{64}$')`,
  `CREATE OR REPLACE FUNCTION validate_markdown_file_import_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target jsonb; native_update bytea; native_vector bytea; value text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Markdown file import receipts are immutable' USING ERRCODE='55000';
      END IF;
      -- Scope lookup must use the receipt table's actual schema, never a
      -- caller's shadow relation or implicit pg_temp search-path precedence.
      PERFORM set_config('search_path',quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      FOREACH value IN ARRAY ARRAY[NEW.workspace_id,NEW.operation_id,NEW.actor_user_id,NEW.request_id] LOOP
        IF value IS NULL OR length(value) NOT BETWEEN 1 AND 256 OR value<>btrim(value) OR value ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'Markdown file import receipt identity is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      FOREACH value IN ARRAY ARRAY[NEW.organization_id,NEW.actor_session_id] LOOP
        IF value IS NOT NULL AND (length(value) NOT BETWEEN 1 AND 256 OR value<>btrim(value) OR value ~ '[[:cntrl:]]') THEN
          RAISE EXCEPTION 'Markdown file import receipt identity is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      target:=NEW.private_result->'target';
      IF NEW.version<>1 OR jsonb_typeof(NEW.private_result) IS DISTINCT FROM 'object'
        OR octet_length(NEW.private_result::text)>32768 OR jsonb_typeof(target) IS DISTINCT FROM 'object'
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.private_result) k WHERE k NOT IN
          ('version','operationId','requestFingerprint','sourceHash','sourceBytes','target','checkpointRequired'))
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(target) k WHERE k NOT IN
          ('documentId','workspaceId','organizationId','path','representation','schemaVersion','lifecycleGeneration',
           'newlineStyle','hasBom','lineageId','initialSequence','initialStateProof','persistedAt'))
        OR NEW.private_result->'version' IS DISTINCT FROM '1'::jsonb
        OR NEW.private_result->'checkpointRequired' IS DISTINCT FROM 'true'::jsonb
        OR NEW.private_result->'operationId' IS DISTINCT FROM to_jsonb(NEW.operation_id)
        OR NEW.private_result->'requestFingerprint' IS DISTINCT FROM to_jsonb(NEW.request_fingerprint)
        OR NEW.request_fingerprint !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(NEW.private_result->'sourceHash') IS DISTINCT FROM 'string'
        OR (NEW.private_result->>'sourceHash') !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(NEW.private_result->'sourceBytes') IS DISTINCT FROM 'number'
        OR (NEW.private_result->>'sourceBytes') !~ '^(0|[1-9][0-9]*)$'
        OR target->'workspaceId' IS DISTINCT FROM to_jsonb(NEW.workspace_id)
        OR target->'organizationId' IS DISTINCT FROM coalesce(to_jsonb(NEW.organization_id),'null'::jsonb)
        OR jsonb_typeof(target->'documentId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(target->'lineageId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(target->'path') IS DISTINCT FROM 'string'
        OR jsonb_typeof(target->'representation') IS DISTINCT FROM 'string'
        OR (target->>'representation') NOT IN ('plain_text','tiptap_xml','tiptap_blocks')
        OR target->'schemaVersion' IS DISTINCT FROM '1'::jsonb
        OR jsonb_typeof(target->'lifecycleGeneration') IS DISTINCT FROM 'number'
        OR (target->>'lifecycleGeneration') !~ '^[1-9][0-9]*$'
        OR jsonb_typeof(target->'initialSequence') IS DISTINCT FROM 'number'
        OR (target->>'initialSequence') !~ '^(0|[1-9][0-9]*)$'
        OR jsonb_typeof(target->'persistedAt') IS DISTINCT FROM 'number'
        OR (target->>'persistedAt') !~ '^(0|[1-9][0-9]*)$'
        OR target->'initialStateProof' IS DISTINCT FROM to_jsonb('yjs-snapshot-sha256-v1:' || encode(sha256(NEW.after_state_snapshot),'hex'))
        OR jsonb_typeof(target->'newlineStyle') IS DISTINCT FROM 'string'
        OR (target->>'newlineStyle') NOT IN ('lf','crlf') OR jsonb_typeof(target->'hasBom') IS DISTINCT FROM 'boolean'
        OR octet_length(NEW.after_state_snapshot) NOT BETWEEN 1 AND 8388608 THEN
        RAISE EXCEPTION 'Markdown file import receipt payload is unavailable' USING ERRCODE='23514';
      END IF;
      FOREACH value IN ARRAY ARRAY[target->>'documentId',target->>'lineageId'] LOOP
        IF length(value) NOT BETWEEN 1 AND 256 OR value<>btrim(value) OR value ~ '[[:cntrl:]]' THEN
          RAISE EXCEPTION 'Markdown file import receipt target is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      value:=target->>'path';
      IF length(value) NOT BETWEEN 1 AND 4096 OR value LIKE '/%' OR position(chr(92) IN value)>0 OR value ~ '[[:cntrl:]]'
        OR EXISTS(SELECT 1 FROM unnest(string_to_array(value,'/')) part WHERE part IN ('','.','..'))
        OR (NEW.private_result->>'sourceBytes')::numeric>8388608
        OR (target->>'lifecycleGeneration')::numeric>9007199254740991
        OR (target->>'initialSequence')::numeric>9007199254740991
        OR (target->>'persistedAt')::numeric>9007199254740991
        OR (target->>'persistedAt')::numeric<>NEW.created_at THEN
        RAISE EXCEPTION 'Markdown file import receipt target is unavailable' USING ERRCODE='23514';
      END IF;
      SELECT s.yjs_state,s.state_vector INTO native_update,native_vector
        FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
        JOIN file_collaboration_lineages l ON l.id=d.lineage_id
        WHERE d.id=target->>'documentId' AND d.lineage_id=target->>'lineageId' AND d.provider='yjs'
          AND d.status='active' AND d.yjs_state_lifecycle='initialized' AND d.workspace_id=NEW.workspace_id
          AND d.organization_id IS NOT DISTINCT FROM NEW.organization_id AND d.path=target->>'path'
          AND l.status='active' AND l.workspace_id=NEW.workspace_id AND l.organization_id IS NOT DISTINCT FROM NEW.organization_id
          AND l.path=target->>'path' AND s.status='active' AND s.workspace_id=NEW.workspace_id
          AND s.organization_id IS NOT DISTINCT FROM NEW.organization_id AND s.path=target->>'path'
          AND s.representation=target->>'representation' AND s.schema_version=(target->>'schemaVersion')::bigint
          AND s.lifecycle_generation=(target->>'lifecycleGeneration')::bigint
          AND s.document_sequence=(target->>'initialSequence')::bigint AND d.state_version<=s.document_sequence
          AND s.persisted_at=(target->>'persistedAt')::bigint AND s.newline_style=target->>'newlineStyle'
          AND to_jsonb(s.has_bom<>0)=target->'hasBom' FOR SHARE OF d,s,l;
      IF NOT FOUND OR native_update IS NULL OR native_vector IS NULL THEN
        RAISE EXCEPTION 'Markdown file import receipt live scope is unavailable' USING ERRCODE='23514';
      END IF;
      -- SQL certifies this exact persisted binary/vector at INSERT. Snapshot
      -- derivation/containment requires the caller's existing native Yjs validator.
      IF NEW.live_yjs_state_sha256 IS NOT NULL AND NEW.live_yjs_state_sha256<>encode(sha256(native_update),'hex')
        OR NEW.live_state_vector_sha256 IS NOT NULL AND NEW.live_state_vector_sha256<>encode(sha256(native_vector),'hex') THEN
        RAISE EXCEPTION 'Markdown file import receipt binary scope is unavailable' USING ERRCODE='23514';
      END IF;
      NEW.live_yjs_state_sha256:=encode(sha256(native_update),'hex');
      NEW.live_state_vector_sha256:=encode(sha256(native_vector),'hex');
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_markdown_file_import_receipts'::regclass
      AND tgname='markdown_file_import_receipt_guard') THEN
      CREATE TRIGGER markdown_file_import_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
        ON collaboration_markdown_file_import_receipts FOR EACH ROW EXECUTE FUNCTION validate_markdown_file_import_receipt();
    END IF;
  END $$`,
  'CREATE INDEX IF NOT EXISTS idx_markdown_file_import_receipts_actor ON collaboration_markdown_file_import_receipts (workspace_id,actor_user_id,created_at)',
] as const;
