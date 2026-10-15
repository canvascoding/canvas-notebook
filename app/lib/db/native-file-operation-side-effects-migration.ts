import type { SqlConnection } from '../db';
import { FILE_GUEST_TARGET_BINDING_CHECK_SQL } from './file-guest-target-migration';

const safeClock = (column: string) => `${column} BETWEEN 0 AND 9007199254740990`;
const safeId = (column: string, nullable = false) => `${nullable ? `${column} IS NULL OR ` : ''}(length(${column}) BETWEEN 1 AND 256 AND ${column}!~'[[:cntrl:]]')`;
const boundedField = (column: string, max = 256) => `(${column} IS NULL OR octet_length(${column})<=${max})`;
const optionalClock = (column: string) => `(${column} IS NULL OR ${safeClock(column)})`;
const preserved = (table: string, excluded: string[]) => `encode(sha256(convert_to('canvas.native-side-preserved-row.v1'||chr(10)||'${table}'||chr(10)||
  (to_jsonb(${table})-ARRAY[${excluded.map(column => `'${column}'`).join(',')}]::text[])::text,'UTF8')),'hex')`;

/** Internal projection allowlist. Credentials and other users' rows never leave
 * the private lifecycle ledger. These expressions contain only fixed SQL names. */
export const NATIVE_FILE_SIDE_EFFECT_ROW_SPECS = [
  { key: 'metadata', table: 'workspace_file_metadata', path: 'path', active: '', id: null,
    order: 'path', columns: ['workspace_id','path','title','created_at','updated_at'],
    json: "jsonb_build_object('workspaceId',workspace_id,'path',path,'title',title,'createdAt',created_at,'updatedAt',updated_at)",
    bounds: `(title IS NULL OR octet_length(title)<=640) AND ${safeClock('created_at')} AND ${safeClock('updated_at')}` },
  { key: 'userStates', table: 'workspace_file_user_states', path: 'path', active: '', id: null,
    order: "path||chr(31)||user_id", columns: ['workspace_id','user_id','path','is_favorite','pinned_at','created_at','updated_at'],
    json: "jsonb_build_object('workspaceId',workspace_id,'userId',user_id,'path',path,'isFavorite',is_favorite<>0,'pinnedAt',pinned_at,'createdAt',created_at,'updatedAt',updated_at)",
    bounds: `${safeId('user_id')} AND is_favorite IN(0,1) AND (pinned_at IS NULL OR ${safeClock('pinned_at')}) AND ${safeClock('created_at')} AND ${safeClock('updated_at')}` },
  { key: 'guests', table: 'file_guest_invitations', path: 'path', active: "status='active'", id: 'id',
    order: 'id', columns: ['id','workspace_id','path','document_id','lifecycle_generation','lineage_id','email','permission','status','policy_revision','created_by_user_id','assets_json','expires_at',
      'created_at','updated_at','challenge_id','challenge_hash','challenge_expires_at','challenge_attempts','challenge_sent_at','challenge_window_at','challenge_send_count'],
    // Freeze the legacy private projection: adding nullable binding columns must
    // not change an old unbound row's JSON or V1 preserved-row digest. A bound
    // row adds an explicit versioned binding, covered by stage/receipt digests.
    json: `jsonb_build_object('id',id,'workspaceId',workspace_id,'documentId',document_id,'path',path,'status',status,'policyRevision',policy_revision,
      'challengeCleared',challenge_hash IS NULL,'updatedAt',updated_at,'preservedRowProof',${preserved('file_guest_invitations',['status','policy_revision','challenge_hash','updated_at','lifecycle_generation','lineage_id'])})
      || CASE WHEN lifecycle_generation IS NULL AND lineage_id IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('guestBinding',jsonb_build_object('version',1,'lineageId',lineage_id,'lifecycleGeneration',lifecycle_generation)) END`,
    bounds: `${FILE_GUEST_TARGET_BINDING_CHECK_SQL} AND ${safeId('id')} AND ${safeId('document_id')} AND ${safeId('created_by_user_id')} AND ${boundedField('email',320)}
      AND ${boundedField('permission',64)} AND ${boundedField('assets_json',65536)} AND ${boundedField('challenge_id')} AND ${boundedField('challenge_hash')}
      AND ${optionalClock('expires_at')} AND ${optionalClock('challenge_expires_at')} AND ${optionalClock('challenge_sent_at')} AND ${optionalClock('challenge_window_at')}
      AND ${safeClock('challenge_attempts')} AND ${safeClock('challenge_send_count')} AND ${safeClock('created_at')}
      AND policy_revision BETWEEN 1 AND 9007199254740989 AND ${safeClock('updated_at')}` },
  { key: 'publicShares', table: 'public_file_shares', path: 'workspace_path', active: "status='active'", id: 'id',
    order: 'id', columns: ['id','token','token_hash','token_preview','short_code','organization_id','customer_id','project_id','workspace_id','workspace_type',
      'workspace_root_relative_path','workspace_path','file_name','file_identity','target_revision_policy','last_known_revision','mime_type','size_bytes','status',
      'created_by_user_id','created_by_agent_id','source_session_id','source','security_mode','reason','created_at','updated_at','expires_at','revoked_at',
      'revoked_reason','password_enabled','password_hash','last_accessed_at','access_count','policy_revision'],
    json: `jsonb_build_object('id',id,'workspaceId',workspace_id,'organizationId',organization_id,'path',workspace_path,'status',status,'policyRevision',policy_revision,
      'revokedAt',revoked_at,'revokedReason',revoked_reason,'updatedAt',updated_at,'preservedRowProof',${preserved('public_file_shares',['status','policy_revision','revoked_at','revoked_reason','updated_at'])})`,
    bounds: `${safeId('id')} AND (${safeId('organization_id', true)}) AND ${safeId('created_by_user_id')}
      AND ${['token','token_hash','token_preview','short_code','customer_id','project_id','workspace_type','mime_type','created_by_agent_id','source_session_id','source','security_mode','password_hash','revoked_reason','target_revision_policy'].map(column => boundedField(column)).join(' AND ')}
      AND ${['workspace_root_relative_path','workspace_path','file_name','file_identity','last_known_revision','reason'].map(column => boundedField(column,4096)).join(' AND ')}
      AND ${safeClock('size_bytes')} AND ${safeClock('access_count')} AND password_enabled IN(0,1) AND ${safeClock('created_at')}
      AND ${optionalClock('expires_at')} AND ${optionalClock('last_accessed_at')} AND ${optionalClock('revoked_at')}
      AND policy_revision BETWEEN 1 AND 9007199254740989 AND ${safeClock('updated_at')}` },
  { key: 'locks', table: 'file_locks', path: 'path', active: "status='active'", id: 'id',
    order: 'id', columns: ['id','organization_id','customer_id','project_id','workspace_id','workspace_type','path','lineage_id','revision_id',
      'locked_by_user_id','locked_by_session_id','lock_type','status','expires_at','created_at','updated_at'],
    json: `jsonb_build_object('id',id,'workspaceId',workspace_id,'organizationId',organization_id,'path',path,'lineageId',lineage_id,'revisionId',revision_id,
      'lockedByUserId',locked_by_user_id,'lockedBySessionId',locked_by_session_id,'lockType',lock_type,'status',status,'expiresAt',expires_at,
      'createdAt',created_at,'updatedAt',updated_at,'preservedRowProof',${preserved('file_locks',['path','status','updated_at'])})`,
    bounds: `${safeId('id')} AND (${safeId('organization_id', true)}) AND (${safeId('customer_id', true)}) AND (${safeId('project_id', true)})
      AND ${boundedField('workspace_type',64)} AND (${safeId('lineage_id', true)}) AND (${safeId('revision_id', true)}) AND (${safeId('locked_by_user_id', true)})
      AND (${safeId('locked_by_session_id', true)}) AND lock_type IN('edit','upload','agent_write') AND ${safeClock('expires_at')} AND ${safeClock('created_at')} AND ${safeClock('updated_at')}` },
] as const;

const rowChecks = NATIVE_FILE_SIDE_EFFECT_ROW_SPECS.map(spec => `
  IF jsonb_typeof(p_rows->'${spec.key}') IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows->'${spec.key}')>256 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows->'${spec.key}') WHERE jsonb_typeof(value) IS DISTINCT FROM 'object') THEN RETURN false; END IF;
  ${spec.columns.length ? `IF (SELECT array_agg(column_name::text ORDER BY column_name COLLATE "C") FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='${spec.table}') IS DISTINCT FROM ARRAY[${[...spec.columns].sort().map(column => `'${column}'`).join(',')}]::text[] THEN RETURN false; END IF;` : ''}
  IF (SELECT count(*) FROM (SELECT 1 FROM ${spec.table} WHERE workspace_id=p_workspace AND (
    ${spec.path}=ANY(p_paths) ${spec.active ? `AND ${spec.active}` : ''}
    ${spec.id ? `OR p_after AND ${spec.id} IN(SELECT value->>'id' FROM jsonb_array_elements(p_rows->'${spec.key}'))` : ''}) LIMIT 257) limited)>256 THEN RETURN false; END IF;
  SELECT coalesce(sum(CASE WHEN ${spec.bounds} THEN ${spec.columns.map(column => `coalesce(octet_length(${column}::text),0)`).join('+')}
    ELSE 8388609 END),0) INTO private_bytes FROM ${spec.table} WHERE workspace_id=p_workspace AND (
    ${spec.path}=ANY(p_paths) ${spec.active ? `AND ${spec.active}` : ''}
    ${spec.id ? `OR p_after AND ${spec.id} IN(SELECT value->>'id' FROM jsonb_array_elements(p_rows->'${spec.key}'))` : ''});
  total_bytes:=total_bytes+private_bytes; IF total_bytes>8388608 THEN RETURN false; END IF;
  SELECT coalesce(jsonb_agg(row_json ORDER BY row_key COLLATE "C"),'[]'::jsonb) INTO actual FROM (
    SELECT CASE WHEN ${spec.bounds} THEN ${spec.json} ELSE NULL END AS row_json,${spec.order} AS row_key
    FROM ${spec.table} WHERE workspace_id=p_workspace AND (
      ${spec.path}=ANY(p_paths) ${spec.active ? `AND ${spec.active}` : ''}
      ${spec.id ? `OR p_after AND ${spec.id} IN(SELECT value->>'id' FROM jsonb_array_elements(p_rows->'${spec.key}'))` : ''})
  ) scoped;
  IF actual IS DISTINCT FROM p_rows->'${spec.key}' THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM ${spec.table} WHERE workspace_id=p_workspace ${spec.active ? `AND ${spec.active}` : ''}
    AND EXISTS(SELECT 1 FROM unnest(p_paths) scope WHERE left(${spec.path},length(scope)+1)=scope||'/')) THEN RETURN false; END IF;
`).join('\n');

/** Additive private DDL. Startup registration does not activate the dispatcher. */
export const NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS collaboration_native_file_operation_side_effect_stages (
    operation_id text PRIMARY KEY REFERENCES collaboration_native_file_operation_intents(operation_id),
    request_id text NOT NULL UNIQUE REFERENCES collaboration_admission_requests(request_id),
    stage_text text NOT NULL CHECK(octet_length(stage_text) BETWEEN 1 AND 1048576),
    stage_digest text NOT NULL CHECK(stage_digest=encode(sha256(convert_to(stage_text,'UTF8')),'hex')),
    CHECK(length(operation_id) BETWEEN 1 AND 256)
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_native_file_operation_side_effect_receipts (
    operation_id text PRIMARY KEY REFERENCES collaboration_native_file_operation_side_effect_stages(operation_id),
    request_id text NOT NULL UNIQUE REFERENCES collaboration_admission_requests(request_id),
    stage_digest text NOT NULL,
    native_receipt_set_proof text NOT NULL CHECK(native_receipt_set_proof ~ '^[a-f0-9]{64}$'),
    receipt_text text NOT NULL CHECK(octet_length(receipt_text) BETWEEN 1 AND 2097152),
    receipt_digest text NOT NULL CHECK(receipt_digest=encode(sha256(convert_to(receipt_text,'UTF8')),'hex'))
  )`,
  `CREATE OR REPLACE FUNCTION native_file_side_effect_rows_match(p_rows jsonb,p_workspace text,p_paths text[],p_after boolean)
    RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE actual jsonb; private_bytes numeric; total_bytes numeric:=0;
    BEGIN
      IF jsonb_typeof(p_rows) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_rows) k
        WHERE k NOT IN('metadata','userStates','guests','publicShares','locks')) OR cardinality(p_paths) NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM public_file_shares WHERE workspace_id IS NULL AND status='active' AND workspace_path=ANY(p_paths)) THEN RETURN false; END IF;
      ${rowChecks}
      RETURN true;
    END $$`,
  `CREATE OR REPLACE FUNCTION native_file_side_effect_expected_rows(p_before jsonb,p_kind text,p_destination text,p_now bigint)
    RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE result jsonb:='{}'::jsonb; k text; rows jsonb;
    BEGIN
      FOREACH k IN ARRAY ARRAY['metadata','userStates','guests','publicShares','locks'] LOOP
        SELECT coalesce(jsonb_agg(CASE
          WHEN k IN('metadata','userStates') THEN value||jsonb_build_object('path',p_destination)
          WHEN k='guests' THEN value||jsonb_build_object('status','revoked','policyRevision',(value->>'policyRevision')::bigint+1,'challengeCleared',true,'updatedAt',p_now)
          WHEN k='publicShares' THEN value||jsonb_build_object('status','revoked','policyRevision',(value->>'policyRevision')::bigint+1,
            'revokedAt',p_now,'revokedReason',CASE WHEN p_kind='archive' THEN 'target_deleted' ELSE 'target_moved' END,'updatedAt',p_now)
          ELSE value||jsonb_build_object('path',CASE WHEN (value->>'expiresAt')::bigint>p_now AND p_kind='move' THEN p_destination ELSE value->>'path' END,
            'status',CASE WHEN (value->>'expiresAt')::bigint<=p_now THEN 'expired' WHEN p_kind='archive' THEN 'released' ELSE 'active' END,'updatedAt',p_now)
          END ORDER BY ordinal),'[]'::jsonb) INTO rows FROM jsonb_array_elements(p_before->k) WITH ORDINALITY items(value,ordinal);
        IF p_kind='archive' AND k IN('metadata','userStates') THEN rows:='[]'::jsonb; END IF;
        result:=result||jsonb_build_object(k,rows);
      END LOOP;
      RETURN result;
    END $$`,
  `CREATE OR REPLACE FUNCTION validate_native_file_side_effect_stage() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE stage jsonb; bundle jsonb; mutation jsonb; effect jsonb; request record; paths text[];
    BEGIN
      PERFORM set_config('search_path',quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      stage:=NEW.stage_text::jsonb;
      SELECT intent_text::jsonb INTO bundle FROM collaboration_native_file_operation_intents WHERE operation_id=NEW.operation_id FOR SHARE;
      SELECT * INTO request FROM collaboration_admission_requests WHERE request_id=NEW.request_id FOR SHARE;
      IF jsonb_typeof(stage) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(stage) k WHERE k NOT IN
        ('version','operationId','requestId','requestDigest','action','changesBundleProof','actor','reviewDigest','capturedAt','mutationIds','effects'))
        OR stage->'version' IS DISTINCT FROM '1'::jsonb OR stage->>'operationId' IS DISTINCT FROM NEW.operation_id
        OR stage->>'requestId' IS DISTINCT FROM NEW.request_id OR request.status NOT IN('reserved','draining')
        OR stage->>'requestDigest' IS DISTINCT FROM request.request_digest OR bundle IS NULL
        OR stage->>'changesBundleProof' IS DISTINCT FROM encode(sha256(convert_to((SELECT intent_text FROM collaboration_native_file_operation_intents WHERE operation_id=NEW.operation_id),'UTF8')),'hex')
        OR stage->'actor' IS DISTINCT FROM bundle->'actor' OR stage->>'reviewDigest' IS DISTINCT FROM bundle->>'reviewDigest'
        OR stage->>'action' IS DISTINCT FROM bundle->>'action' OR stage->>'action' NOT IN('move','rename','archive')
        OR jsonb_typeof(stage->'capturedAt') IS DISTINCT FROM 'number' OR (stage->>'capturedAt') !~ '^(0|[1-9][0-9]*)$'
        OR (stage->>'capturedAt')::numeric<floor(extract(epoch FROM transaction_timestamp())*1000)
        OR (stage->>'capturedAt')::numeric>floor(extract(epoch FROM clock_timestamp())*1000)
        OR request.intent_text::jsonb->>'actorId' IS DISTINCT FROM bundle#>>'{actor,actorId}'
        OR (request.intent_text::jsonb->>'actionPayloadText')::jsonb->>'changesBundleProof' IS DISTINCT FROM stage->>'changesBundleProof'
        OR jsonb_typeof(stage->'mutationIds') IS DISTINCT FROM 'array' OR jsonb_array_length(stage->'mutationIds') NOT BETWEEN 1 AND 64
        OR stage->'mutationIds' IS DISTINCT FROM (SELECT jsonb_agg(value->'mutationId' ORDER BY value->>'mutationId' COLLATE "C") FROM jsonb_array_elements(bundle->'mutations'))
        OR jsonb_typeof(stage->'effects') IS DISTINCT FROM 'array' OR jsonb_array_length(stage->'effects') NOT BETWEEN 1 AND 16
        OR jsonb_array_length(stage->'effects')<>(SELECT count(*) FROM jsonb_array_elements(bundle->'mutations') WHERE value->>'kind' IN('move','archive')) THEN
        RAISE EXCEPTION 'Native file side-effect stage binding is unavailable' USING ERRCODE='23514';
      END IF;
      FOR effect IN SELECT value FROM jsonb_array_elements(stage->'effects') LOOP
        SELECT value INTO mutation FROM jsonb_array_elements(bundle->'mutations') WHERE value->>'mutationId'=effect->>'mutationId';
        paths:=ARRAY[effect#>>'{source,path}']; IF effect->>'destinationPath' IS NOT NULL THEN paths:=paths||ARRAY[effect->>'destinationPath']; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_object_keys(effect) k WHERE k NOT IN('mutationId','kind','source','lineageId','destinationPath','beforeRows'))
          OR mutation IS NULL OR mutation->>'kind' NOT IN('move','archive') OR effect->>'kind' IS DISTINCT FROM mutation->>'kind'
          OR effect->'source' IS DISTINCT FROM mutation->'source' OR effect->>'lineageId' IS DISTINCT FROM mutation->>'lineageId'
          OR effect->'destinationPath' IS DISTINCT FROM mutation->'destinationPath'
          OR NOT native_file_side_effect_rows_match(effect->'beforeRows',effect#>>'{source,workspaceId}',paths,false)
          OR EXISTS(SELECT 1 FROM jsonb_each(effect->'beforeRows') fields(k,rows),jsonb_array_elements(rows) r WHERE k<>'locks' AND (
            r->>'path' IS DISTINCT FROM effect#>>'{source,path}' OR r->>'workspaceId' IS DISTINCT FROM effect#>>'{source,workspaceId}'
            OR k='guests' AND (r->>'documentId' IS DISTINCT FROM effect#>>'{source,documentId}'
              OR r ? 'guestBinding' AND (jsonb_typeof(r->'guestBinding') IS DISTINCT FROM 'object'
                OR r#>'{guestBinding,version}' IS DISTINCT FROM '1'::jsonb
                OR r#>>'{guestBinding,lineageId}' IS DISTINCT FROM effect->>'lineageId'
                OR CASE WHEN jsonb_typeof(r#>'{guestBinding,lifecycleGeneration}')='number'
                    AND r#>>'{guestBinding,lifecycleGeneration}' ~ '^[1-9][0-9]*$'
                  THEN (r#>>'{guestBinding,lifecycleGeneration}')::numeric BETWEEN 1 AND (effect#>>'{source,lifecycleGeneration}')::numeric
                  ELSE false END IS NOT TRUE))
            OR k='publicShares' AND r->'organizationId' IS DISTINCT FROM effect#>'{source,organizationId}'))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(effect#>'{beforeRows,locks}') r WHERE
            r->>'workspaceId' IS DISTINCT FROM effect#>>'{source,workspaceId}' OR r->'organizationId' IS DISTINCT FROM effect#>'{source,organizationId}'
            OR r->>'path'=effect#>>'{source,path}' AND r->>'lineageId' IS NOT NULL AND r->>'lineageId' IS DISTINCT FROM effect->>'lineageId'
            OR (r->>'expiresAt')::bigint>(stage->>'capturedAt')::bigint AND (
              r->>'path' IS DISTINCT FROM effect#>>'{source,path}' OR r->>'lockedByUserId' IS DISTINCT FROM stage#>>'{actor,actorUserId}'
              OR r->'lockedBySessionId' IS DISTINCT FROM stage#>'{actor,actorSessionId}'))
          OR NOT EXISTS(SELECT 1 FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
            JOIN file_collaboration_lineages l ON l.id=d.lineage_id WHERE d.id=effect#>>'{source,documentId}'
            AND d.lineage_id=effect->>'lineageId' AND d.provider='yjs' AND d.yjs_state_lifecycle='initialized'
            AND d.workspace_id=effect#>>'{source,workspaceId}' AND d.organization_id IS NOT DISTINCT FROM effect#>>'{source,organizationId}'
            AND d.path=effect#>>'{source,path}' AND d.status='active' AND l.path=d.path AND l.workspace_id=d.workspace_id
            AND l.organization_id IS NOT DISTINCT FROM d.organization_id AND l.status='active'
            AND s.path=d.path AND s.workspace_id=d.workspace_id AND s.organization_id IS NOT DISTINCT FROM d.organization_id AND s.status='active'
            AND s.representation=effect#>>'{source,representation}' AND s.schema_version=(effect#>>'{source,schemaVersion}')::bigint
            AND s.lifecycle_generation=(effect#>>'{source,lifecycleGeneration}')::bigint
            AND s.document_sequence=(mutation#>>'{before,documentSequence}')::bigint AND s.persisted_at=(mutation#>>'{before,persistedAt}')::bigint
            AND encode(sha256(s.yjs_state),'hex')=mutation#>>'{before,binaryHash}' AND s.state_vector=decode(mutation#>>'{before,stateVector}','base64')) THEN
          RAISE EXCEPTION 'Native file side-effect before scope is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'mutationId') FROM jsonb_array_elements(stage->'effects'))<>jsonb_array_length(stage->'effects') THEN
        RAISE EXCEPTION 'Native file side-effect membership is unavailable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE FUNCTION validate_native_file_side_effect_endstate() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE stage jsonb; receipt jsonb; effect jsonb; before_effect jsonb; native jsonb; q record; paths text[]; native_proof text; n bigint;
    BEGIN
      PERFORM set_config('search_path',quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      SELECT stage_text::jsonb INTO stage FROM collaboration_native_file_operation_side_effect_stages WHERE operation_id=NEW.operation_id;
      SELECT * INTO q FROM collaboration_admission_requests WHERE request_id=NEW.request_id;
      receipt:=NEW.receipt_text::jsonb;
      SELECT count(*),encode(sha256(convert_to('canvas.native-file-receipt-set.v1'||chr(10)||string_agg(mutation_id||chr(9)||receipt_digest,chr(10) ORDER BY mutation_id COLLATE "C"),'UTF8')),'hex')
        INTO n,native_proof FROM collaboration_native_file_operation_receipts WHERE operation_id=NEW.operation_id;
      IF stage IS NULL OR q.status IS DISTINCT FROM 'committed' OR receipt->'version' IS DISTINCT FROM '1'::jsonb
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(receipt) k WHERE k NOT IN('version','operationId','requestId','requestDigest','action','changesBundleProof','actor','reviewDigest','capturedAt','mutationIds','effects','stageDigest','nativeReceiptSetProof','createdAt'))
        OR receipt-'effects'-'stageDigest'-'nativeReceiptSetProof'-'createdAt' IS DISTINCT FROM stage-'effects'
        OR NEW.stage_digest IS DISTINCT FROM (SELECT stage_digest FROM collaboration_native_file_operation_side_effect_stages WHERE operation_id=NEW.operation_id)
        OR receipt->>'stageDigest' IS DISTINCT FROM NEW.stage_digest OR receipt->>'nativeReceiptSetProof' IS DISTINCT FROM NEW.native_receipt_set_proof
        OR native_proof IS DISTINCT FROM NEW.native_receipt_set_proof OR n<>jsonb_array_length(stage->'mutationIds')
        OR q.outcome_text::jsonb#>>'{result,nativeFileReceiptSetProof}' IS DISTINCT FROM native_proof
        OR q.outcome_text::jsonb#>>'{result,nativeFileSideEffectSetProof}' IS DISTINCT FROM
          encode(sha256(convert_to('canvas.native-file-side-effects.v1'||chr(10)||NEW.receipt_digest,'UTF8')),'hex')
        OR jsonb_typeof(receipt->'effects') IS DISTINCT FROM 'array' OR jsonb_array_length(receipt->'effects')<>jsonb_array_length(stage->'effects')
        OR jsonb_typeof(receipt->'createdAt') IS DISTINCT FROM 'number' OR (receipt->>'createdAt') !~ '^(0|[1-9][0-9]*)$'
        OR (receipt->>'createdAt')::numeric>9007199254740990 OR (receipt->>'createdAt')::numeric<(stage->>'capturedAt')::numeric
        OR (receipt->>'createdAt')::numeric>floor(extract(epoch FROM clock_timestamp())*1000) THEN
        RAISE EXCEPTION 'Native file side-effect receipt binding is unavailable' USING ERRCODE='23514';
      END IF;
      FOR effect IN SELECT value FROM jsonb_array_elements(receipt->'effects') LOOP
        SELECT value INTO before_effect FROM jsonb_array_elements(stage->'effects') WHERE value->>'mutationId'=effect->>'mutationId';
        SELECT receipt_text::jsonb INTO native FROM collaboration_native_file_operation_receipts WHERE operation_id=NEW.operation_id AND mutation_id=effect->>'mutationId';
        paths:=ARRAY[effect#>>'{source,path}']; IF native#>>'{after,identity,path}'<>effect#>>'{source,path}' THEN paths:=paths||ARRAY[native#>>'{after,identity,path}']; END IF;
        IF before_effect IS NULL OR native IS NULL OR effect->'source' IS DISTINCT FROM before_effect->'source'
          OR effect->>'lineageId' IS DISTINCT FROM before_effect->>'lineageId' OR effect->'beforeRows' IS DISTINCT FROM before_effect->'beforeRows'
          OR effect->>'nativeReceiptDigest' IS DISTINCT FROM (SELECT receipt_digest FROM collaboration_native_file_operation_receipts WHERE operation_id=NEW.operation_id AND mutation_id=effect->>'mutationId')
          OR effect->'after' IS DISTINCT FROM jsonb_build_object('identity',native#>'{after,identity}','status',native#>'{after,status}')
          OR EXISTS(SELECT 1 FROM jsonb_object_keys(effect) k WHERE k NOT IN('mutationId','source','lineageId','nativeReceiptDigest','after','beforeRows','afterRows'))
          OR effect->'afterRows' IS DISTINCT FROM native_file_side_effect_expected_rows(before_effect->'beforeRows',before_effect->>'kind',before_effect->>'destinationPath',(receipt->>'createdAt')::bigint)
          OR NOT native_file_side_effect_rows_match(effect->'afterRows',effect#>>'{source,workspaceId}',paths,true)
          OR EXISTS(SELECT 1 FROM collaboration_agent_operations WHERE document_id=effect#>>'{source,documentId}'
            AND status NOT IN('persisted_yjs','checkpointed_file','cancelled','expired','superseded','failed','rejected','reverted')) THEN
          RAISE EXCEPTION 'Native file side-effect after scope is unavailable' USING ERRCODE='23514';
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'mutationId') FROM jsonb_array_elements(receipt->'effects'))<>jsonb_array_length(receipt->'effects') THEN
        RAISE EXCEPTION 'Native file side-effect receipt membership is unavailable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE FUNCTION native_file_side_effect_stage_complete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM set_config('search_path',quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      IF NOT EXISTS(SELECT 1 FROM collaboration_native_file_operation_side_effect_receipts WHERE operation_id=NEW.operation_id AND request_id=NEW.request_id AND stage_digest=NEW.stage_digest) THEN
        RAISE EXCEPTION 'Native file side-effect stage has no complete receipt' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE FUNCTION immutable_native_file_side_effect_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Native file side-effect records are immutable' USING ERRCODE='55000'; END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_file_operation_side_effect_stages'::regclass AND tgname='native_file_side_effect_stage_guard') THEN
      CREATE TRIGGER native_file_side_effect_stage_guard BEFORE INSERT ON collaboration_native_file_operation_side_effect_stages FOR EACH ROW EXECUTE FUNCTION validate_native_file_side_effect_stage();
      CREATE TRIGGER native_file_side_effect_stage_immutable BEFORE UPDATE OR DELETE ON collaboration_native_file_operation_side_effect_stages FOR EACH ROW EXECUTE FUNCTION immutable_native_file_side_effect_record();
      CREATE CONSTRAINT TRIGGER native_file_side_effect_stage_complete AFTER INSERT ON collaboration_native_file_operation_side_effect_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION native_file_side_effect_stage_complete();
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='collaboration_native_file_operation_side_effect_receipts'::regclass AND tgname='native_file_side_effect_receipt_guard') THEN
      CREATE TRIGGER native_file_side_effect_receipt_immutable BEFORE UPDATE OR DELETE ON collaboration_native_file_operation_side_effect_receipts FOR EACH ROW EXECUTE FUNCTION immutable_native_file_side_effect_record();
      CREATE CONSTRAINT TRIGGER native_file_side_effect_receipt_guard AFTER INSERT ON collaboration_native_file_operation_side_effect_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_native_file_side_effect_endstate();
    END IF;
  END $$`,
] as const;

export async function runNativeFileOperationSideEffectMigration(database: Pick<SqlConnection, 'run'>): Promise<void> {
  for (const statement of NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS) await database.run(statement);
}
