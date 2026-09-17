/**
 * Additive, repeatable proposal storage. One simple-query batch is atomic on
 * PostgreSQL; PGlite uses exec for the same transaction semantics. Production
 * rollback disables graph mutations and retains data; DOWN is operator/test only.
 */
export const PROPOSAL_GRAPH_STORAGE_UP_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_document_scope
  ON collaboration_documents (id, workspace_id, lineage_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_operation_scope
  ON collaboration_agent_operations
  (operation_id, workspace_id, document_id, document_lifecycle_generation, schema_version);

CREATE TABLE IF NOT EXISTS file_proposal_graphs (
  graph_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  lineage_id text NOT NULL,
  document_id text NOT NULL,
  lifecycle_generation bigint NOT NULL CHECK (lifecycle_generation BETWEEN 1 AND 9007199254740991),
  schema_version bigint NOT NULL CHECK (schema_version BETWEEN 1 AND 9007199254740991),
  graph_revision bigint NOT NULL DEFAULT 0 CHECK (graph_revision BETWEEN 0 AND 9007199254740991),
  active_action_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (workspace_id, lineage_id, document_id, lifecycle_generation, schema_version),
  UNIQUE (graph_id, workspace_id, lineage_id, document_id, lifecycle_generation, schema_version),
  FOREIGN KEY (lineage_id, workspace_id) REFERENCES file_collaboration_lineages (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, workspace_id, lineage_id) REFERENCES collaboration_documents (id, workspace_id, lineage_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS file_proposal_artifacts (
  graph_id text NOT NULL REFERENCES file_proposal_graphs (graph_id) ON DELETE RESTRICT,
  artifact_ref text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  encoding text NOT NULL CHECK (encoding IN ('yjs_full_update_v1', 'json_v1')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 8388608),
  payload bytea NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (graph_id, artifact_ref),
  UNIQUE (graph_id, sha256, encoding),
  CHECK (size_bytes = octet_length(payload)),
  CHECK (sha256 = encode(sha256(payload), 'hex')),
  CHECK (CASE WHEN encoding = 'json_v1' THEN jsonb_typeof(convert_from(payload, 'UTF8')::jsonb) IS NOT NULL ELSE true END)
);

CREATE TABLE IF NOT EXISTS file_proposal_choice_groups (
  graph_id text NOT NULL REFERENCES file_proposal_graphs (graph_id) ON DELETE RESTRICT,
  group_id text NOT NULL,
  group_revision bigint NOT NULL CHECK (group_revision BETWEEN 0 AND 9007199254740991),
  dependency_proposal_id text,
  chosen_proposal_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (graph_id, group_id)
);

CREATE TABLE IF NOT EXISTS file_change_proposals (
  proposal_id text PRIMARY KEY,
  graph_id text NOT NULL,
  operation_id text NOT NULL UNIQUE,
  cas_version bigint NOT NULL CHECK (cas_version BETWEEN 1 AND 9007199254740991),
  lifecycle text NOT NULL CHECK (lifecycle IN ('open', 'applied', 'included', 'rejected', 'superseded', 'alternative_not_selected', 'satisfied_elsewhere', 'expired')),
  node_json jsonb NOT NULL CHECK (jsonb_typeof(node_json) = 'object' AND octet_length(node_json::text) <= 1048576),
  dependency_proposal_id text,
  replaces_proposal_id text,
  choice_group_id text,
  workspace_id text GENERATED ALWAYS AS (node_json #>> '{scope,workspaceId}') STORED NOT NULL,
  lineage_id text GENERATED ALWAYS AS (node_json #>> '{scope,lineageId}') STORED NOT NULL,
  document_id text GENERATED ALWAYS AS (node_json #>> '{scope,documentId}') STORED NOT NULL,
  lifecycle_generation bigint GENERATED ALWAYS AS ((node_json #>> '{scope,lifecycleGeneration}')::bigint) STORED NOT NULL,
  schema_version bigint GENERATED ALWAYS AS ((node_json #>> '{scope,schemaVersion}')::bigint) STORED NOT NULL,
  source_evaluation_id text GENERATED ALWAYS AS (node_json #>> '{source,evaluationId}') STORED,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (graph_id, proposal_id),
  FOREIGN KEY (graph_id, workspace_id, lineage_id, document_id, lifecycle_generation, schema_version)
    REFERENCES file_proposal_graphs (graph_id, workspace_id, lineage_id, document_id, lifecycle_generation, schema_version) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, workspace_id, document_id, lifecycle_generation, schema_version)
    REFERENCES collaboration_agent_operations (operation_id, workspace_id, document_id, document_lifecycle_generation, schema_version) ON DELETE RESTRICT,
  FOREIGN KEY (graph_id, dependency_proposal_id) REFERENCES file_change_proposals (graph_id, proposal_id) ON DELETE RESTRICT,
  FOREIGN KEY (graph_id, replaces_proposal_id) REFERENCES file_change_proposals (graph_id, proposal_id) ON DELETE RESTRICT,
  FOREIGN KEY (graph_id, choice_group_id) REFERENCES file_proposal_choice_groups (graph_id, group_id) ON DELETE RESTRICT,
  CHECK (proposal_id IS DISTINCT FROM dependency_proposal_id AND proposal_id IS DISTINCT FROM replaces_proposal_id),
  CHECK (dependency_proposal_id IS NULL OR dependency_proposal_id IS DISTINCT FROM replaces_proposal_id),
  CHECK (source_evaluation_id IS NULL OR dependency_proposal_id IS NOT NULL),
  CHECK ((node_json ->> 'contractVersion') IS NOT DISTINCT FROM '1'),
  CHECK ((node_json ->> 'proposalId' = proposal_id AND node_json ->> 'operationId' = operation_id) IS TRUE),
  CHECK ((node_json #> '{source,scope}' = node_json -> 'scope') IS TRUE),
  CHECK ((node_json #>> '{relationships,dependency,proposalId}') IS NOT DISTINCT FROM dependency_proposal_id),
  CHECK ((node_json #>> '{relationships,replacesProposalId}') IS NOT DISTINCT FROM replaces_proposal_id)
);
CREATE INDEX IF NOT EXISTS idx_proposal_nodes_graph_status ON file_change_proposals (graph_id, lifecycle, created_at, proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_nodes_dependency ON file_change_proposals (graph_id, dependency_proposal_id);

CREATE TABLE IF NOT EXISTS file_proposal_choice_memberships (
  graph_id text NOT NULL,
  group_id text NOT NULL,
  proposal_id text NOT NULL,
  PRIMARY KEY (graph_id, group_id, proposal_id),
  UNIQUE (graph_id, proposal_id),
  FOREIGN KEY (graph_id, group_id) REFERENCES file_proposal_choice_groups (graph_id, group_id) ON DELETE RESTRICT,
  FOREIGN KEY (graph_id, proposal_id) REFERENCES file_change_proposals (graph_id, proposal_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS file_proposal_evaluations (
  evaluation_id text PRIMARY KEY,
  graph_id text NOT NULL,
  proposal_id text NOT NULL,
  evaluation_json jsonb NOT NULL CHECK (jsonb_typeof(evaluation_json) = 'object' AND octet_length(evaluation_json::text) <= 1048576),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > created_at),
  UNIQUE (graph_id, evaluation_id),
  UNIQUE (graph_id, evaluation_id, proposal_id),
  FOREIGN KEY (graph_id, proposal_id) REFERENCES file_change_proposals (graph_id, proposal_id) ON DELETE RESTRICT,
  CHECK ((evaluation_json ->> 'evaluationId' = evaluation_id AND evaluation_json ->> 'proposalId' = proposal_id) IS TRUE),
  CHECK ((evaluation_json ->> 'contractVersion') IS NOT DISTINCT FROM '1'),
  CHECK (((evaluation_json ->> 'evaluatedAt')::bigint = created_at AND (evaluation_json ->> 'expiresAt')::bigint = expires_at) IS TRUE)
);
CREATE INDEX IF NOT EXISTS idx_proposal_evaluation_expiry ON file_proposal_evaluations (graph_id, expires_at);

CREATE TABLE IF NOT EXISTS file_proposal_action_receipts (
  action_id text PRIMARY KEY,
  graph_id text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL CHECK (phase IN ('prepared', 'applying', 'awaiting_durability', 'recovery_required', 'succeeded', 'failed')),
  operation_id text,
  request_json jsonb NOT NULL CHECK (jsonb_typeof(request_json) = 'object' AND octet_length(request_json::text) <= 1048576),
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json) = 'object' AND octet_length(receipt_json::text) <= 1048576),
  workspace_id text GENERATED ALWAYS AS (receipt_json #>> '{scope,workspaceId}') STORED NOT NULL,
  lineage_id text GENERATED ALWAYS AS (receipt_json #>> '{scope,lineageId}') STORED NOT NULL,
  document_id text GENERATED ALWAYS AS (receipt_json #>> '{scope,documentId}') STORED NOT NULL,
  lifecycle_generation bigint GENERATED ALWAYS AS ((receipt_json #>> '{scope,lifecycleGeneration}')::bigint) STORED NOT NULL,
  schema_version bigint GENERATED ALWAYS AS ((receipt_json #>> '{scope,schemaVersion}')::bigint) STORED NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (graph_id, action_id),
  CONSTRAINT proposal_action_idempotency UNIQUE (actor_id, idempotency_key_hash),
  FOREIGN KEY (graph_id, workspace_id, lineage_id, document_id, lifecycle_generation, schema_version)
    REFERENCES file_proposal_graphs (graph_id, workspace_id, lineage_id, document_id, lifecycle_generation, schema_version) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, workspace_id, document_id, lifecycle_generation, schema_version)
    REFERENCES collaboration_agent_operations (operation_id, workspace_id, document_id, document_lifecycle_generation, schema_version) ON DELETE RESTRICT,
  CHECK ((receipt_json ->> 'contractVersion') IS NOT DISTINCT FROM '1'),
  CHECK ((receipt_json ->> 'actionId' = action_id AND receipt_json ->> 'actorId' = actor_id) IS TRUE),
  CHECK ((receipt_json ->> 'phase' = phase AND receipt_json ->> 'requestDigest' = request_digest AND receipt_json ->> 'idempotencyKeyHash' = idempotency_key_hash) IS TRUE),
  CHECK ((receipt_json ->> 'operationId') IS NOT DISTINCT FROM operation_id),
  CHECK (((receipt_json ->> 'createdAt')::bigint = created_at AND (receipt_json ->> 'updatedAt')::bigint = updated_at) IS TRUE),
  CHECK (((phase = 'succeeded' AND jsonb_typeof(receipt_json -> 'result') = 'object') OR (phase <> 'succeeded' AND receipt_json -> 'result' = 'null'::jsonb)) IS TRUE),
  CHECK ((request_json ?& ARRAY['fence','creation']) AND (request_json - ARRAY['fence','creation']) = '{}'::jsonb),
  CHECK ((request_json #>> '{fence,requestDigest}') IS NOT DISTINCT FROM request_digest),
  CHECK ((request_json #> '{fence,scope}') IS NOT DISTINCT FROM (receipt_json -> 'scope')),
  CHECK (phase NOT IN ('applying', 'awaiting_durability') OR operation_id IS NOT NULL)
);
-- A reservation survives lease expiry and process death, including across generations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_one_active_action ON file_proposal_action_receipts (document_id)
  WHERE phase IN ('prepared', 'applying', 'awaiting_durability', 'recovery_required');

CREATE TABLE IF NOT EXISTS file_revision_proposal_bindings (
  graph_id text NOT NULL,
  revision_id text NOT NULL,
  proposal_id text NOT NULL UNIQUE,
  action_id text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('applied', 'included', 'batch_applied', 'satisfied_elsewhere')),
  application_order bigint NOT NULL CHECK (application_order BETWEEN 0 AND 127),
  PRIMARY KEY (graph_id, revision_id, proposal_id),
  UNIQUE (graph_id, revision_id, application_order),
  FOREIGN KEY (graph_id, proposal_id) REFERENCES file_change_proposals (graph_id, proposal_id) ON DELETE RESTRICT,
  FOREIGN KEY (graph_id, action_id) REFERENCES file_proposal_action_receipts (graph_id, action_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id) REFERENCES file_revisions (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS file_proposal_artifact_pins (
  graph_id text NOT NULL,
  artifact_ref text NOT NULL,
  proposal_id text,
  evaluation_id text,
  action_id text,
  created_at bigint NOT NULL,
  CHECK (num_nonnulls(proposal_id, evaluation_id, action_id) = 1),
  FOREIGN KEY (graph_id, artifact_ref) REFERENCES file_proposal_artifacts (graph_id, artifact_ref) ON DELETE RESTRICT,
  FOREIGN KEY (graph_id, proposal_id) REFERENCES file_change_proposals (graph_id, proposal_id) ON DELETE CASCADE,
  FOREIGN KEY (graph_id, evaluation_id) REFERENCES file_proposal_evaluations (graph_id, evaluation_id) ON DELETE CASCADE,
  FOREIGN KEY (graph_id, action_id) REFERENCES file_proposal_action_receipts (graph_id, action_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_pin_node ON file_proposal_artifact_pins (graph_id, artifact_ref, proposal_id) WHERE proposal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_pin_evaluation ON file_proposal_artifact_pins (graph_id, artifact_ref, evaluation_id) WHERE evaluation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_pin_action ON file_proposal_artifact_pins (graph_id, artifact_ref, action_id) WHERE action_id IS NOT NULL;

DO $proposal_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_graph_active_action_fk' AND conrelid = 'file_proposal_graphs'::regclass) THEN
    ALTER TABLE file_proposal_graphs ADD CONSTRAINT proposal_graph_active_action_fk FOREIGN KEY (graph_id, active_action_id)
      REFERENCES file_proposal_action_receipts (graph_id, action_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_choice_dependency_fk' AND conrelid = 'file_proposal_choice_groups'::regclass) THEN
    ALTER TABLE file_proposal_choice_groups ADD CONSTRAINT proposal_choice_dependency_fk FOREIGN KEY (graph_id, dependency_proposal_id)
      REFERENCES file_change_proposals (graph_id, proposal_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_choice_selected_member_fk' AND conrelid = 'file_proposal_choice_groups'::regclass) THEN
    ALTER TABLE file_proposal_choice_groups ADD CONSTRAINT proposal_choice_selected_member_fk FOREIGN KEY (graph_id, group_id, chosen_proposal_id)
      REFERENCES file_proposal_choice_memberships (graph_id, group_id, proposal_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposal_source_evaluation_fk' AND conrelid = 'file_change_proposals'::regclass) THEN
    ALTER TABLE file_change_proposals ADD CONSTRAINT proposal_source_evaluation_fk FOREIGN KEY (graph_id, source_evaluation_id, dependency_proposal_id)
      REFERENCES file_proposal_evaluations (graph_id, evaluation_id, proposal_id) ON DELETE RESTRICT;
  END IF;
END
$proposal_constraints$;

CREATE OR REPLACE FUNCTION file_proposal_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Immutable proposal provenance' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION file_proposal_node_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.node_json ->> 'lifecycle') IS DISTINCT FROM NEW.lifecycle
      OR (NEW.node_json ->> 'casVersion')::bigint IS DISTINCT FROM NEW.cas_version
      OR (NEW.node_json #>> '{relationships,choiceGroupId}') IS DISTINCT FROM NEW.choice_group_id
    THEN RAISE EXCEPTION 'Proposal initial state mismatch' USING ERRCODE = '23514'; END IF;
  ELSE
    IF ROW(NEW.proposal_id,NEW.graph_id,NEW.operation_id,NEW.node_json,NEW.dependency_proposal_id,NEW.replaces_proposal_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.proposal_id,OLD.graph_id,OLD.operation_id,OLD.node_json,OLD.dependency_proposal_id,OLD.replaces_proposal_id,OLD.created_at)
      OR NEW.cas_version <> OLD.cas_version + 1 OR NEW.updated_at < OLD.updated_at
      OR (OLD.lifecycle <> 'open' AND (NEW.lifecycle <> OLD.lifecycle OR NEW.choice_group_id IS DISTINCT FROM OLD.choice_group_id))
      OR (OLD.choice_group_id IS NOT NULL AND NEW.choice_group_id IS DISTINCT FROM OLD.choice_group_id)
    THEN RAISE EXCEPTION 'Invalid proposal state transition' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION file_proposal_graph_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE old_phase text;
BEGIN
  IF ROW(NEW.graph_id,NEW.workspace_id,NEW.lineage_id,NEW.document_id,NEW.lifecycle_generation,NEW.schema_version,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.graph_id,OLD.workspace_id,OLD.lineage_id,OLD.document_id,OLD.lifecycle_generation,OLD.schema_version,OLD.created_at)
    OR NEW.graph_revision NOT BETWEEN OLD.graph_revision AND OLD.graph_revision + 1 OR NEW.updated_at < OLD.updated_at
  THEN RAISE EXCEPTION 'Invalid proposal graph identity or revision' USING ERRCODE = '23514'; END IF;
  IF OLD.active_action_id IS NOT NULL AND NEW.active_action_id IS DISTINCT FROM OLD.active_action_id THEN
    SELECT phase INTO old_phase FROM file_proposal_action_receipts WHERE action_id = OLD.active_action_id;
    IF NEW.active_action_id IS NOT NULL OR old_phase NOT IN ('succeeded', 'failed') OR old_phase IS NULL THEN
      RAISE EXCEPTION 'Unresolved action reservation cannot be replaced' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION file_proposal_choice_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ROW(NEW.graph_id,NEW.group_id,NEW.dependency_proposal_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.graph_id,OLD.group_id,OLD.dependency_proposal_id,OLD.created_at)
    OR NEW.group_revision <> OLD.group_revision + 1 OR NEW.updated_at < OLD.updated_at
    OR (OLD.chosen_proposal_id IS NOT NULL AND NEW.chosen_proposal_id IS DISTINCT FROM OLD.chosen_proposal_id)
  THEN RAISE EXCEPTION 'Invalid proposal choice transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION file_proposal_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE node_group text; node_dependency text; group_dependency text; chosen text;
BEGIN
  SELECT choice_group_id, dependency_proposal_id INTO node_group, node_dependency
    FROM file_change_proposals WHERE graph_id = NEW.graph_id AND proposal_id = NEW.proposal_id;
  SELECT dependency_proposal_id, chosen_proposal_id INTO group_dependency, chosen
    FROM file_proposal_choice_groups WHERE graph_id = NEW.graph_id AND group_id = NEW.group_id;
  IF node_group IS DISTINCT FROM NEW.group_id OR node_dependency IS DISTINCT FROM group_dependency OR chosen IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid or already resolved proposal choice membership' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION file_proposal_scoped_payload_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE graph_scope jsonb; actual_scope jsonb; revision_workspace text; revision_lineage text;
BEGIN
  SELECT jsonb_build_object('workspaceId',workspace_id,'lineageId',lineage_id,'documentId',document_id,
    'lifecycleGeneration',lifecycle_generation,'schemaVersion',schema_version)
    INTO graph_scope FROM file_proposal_graphs WHERE graph_id = NEW.graph_id;
  IF TG_TABLE_NAME = 'file_proposal_evaluations' THEN
    actual_scope := NEW.evaluation_json -> 'scope';
    IF actual_scope IS DISTINCT FROM graph_scope THEN RAISE EXCEPTION 'Evaluation scope mismatch' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT workspace_id,lineage_id INTO revision_workspace,revision_lineage FROM file_revisions WHERE id = NEW.revision_id;
    IF revision_workspace IS DISTINCT FROM graph_scope ->> 'workspaceId' OR revision_lineage IS DISTINCT FROM graph_scope ->> 'lineageId'
    THEN RAISE EXCEPTION 'Proposal revision binding scope mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION file_proposal_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ROW(NEW.action_id,NEW.graph_id,NEW.actor_id,NEW.idempotency_key_hash,NEW.request_digest,NEW.request_json,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.action_id,OLD.graph_id,OLD.actor_id,OLD.idempotency_key_hash,OLD.request_digest,OLD.request_json,OLD.created_at)
    OR (NEW.receipt_json - ARRAY['phase','result','errorCode','operationId','updatedAt'])
      IS DISTINCT FROM (OLD.receipt_json - ARRAY['phase','result','errorCode','operationId','updatedAt'])
    OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id)
    OR NEW.updated_at < OLD.updated_at
  THEN RAISE EXCEPTION 'Immutable action identity changed' USING ERRCODE = '23514'; END IF;
  IF OLD.phase IN ('succeeded','failed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal action receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.phase <> OLD.phase AND NOT (
    (OLD.phase = 'prepared' AND NEW.phase IN ('applying','succeeded','failed')) OR
    (OLD.phase = 'applying' AND NEW.phase IN ('awaiting_durability','recovery_required')) OR
    (OLD.phase = 'awaiting_durability' AND NEW.phase IN ('succeeded','recovery_required')) OR
    (OLD.phase = 'recovery_required' AND NEW.phase IN ('awaiting_durability','succeeded','failed'))
  ) THEN RAISE EXCEPTION 'Invalid action receipt transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS proposal_artifact_immutable ON file_proposal_artifacts;
CREATE TRIGGER proposal_artifact_immutable BEFORE UPDATE ON file_proposal_artifacts FOR EACH ROW EXECUTE FUNCTION file_proposal_immutable_row();
DROP TRIGGER IF EXISTS proposal_node_guard ON file_change_proposals;
CREATE TRIGGER proposal_node_guard BEFORE INSERT OR UPDATE ON file_change_proposals FOR EACH ROW EXECUTE FUNCTION file_proposal_node_guard();
DROP TRIGGER IF EXISTS proposal_graph_guard ON file_proposal_graphs;
CREATE TRIGGER proposal_graph_guard BEFORE UPDATE ON file_proposal_graphs FOR EACH ROW EXECUTE FUNCTION file_proposal_graph_guard();
DROP TRIGGER IF EXISTS proposal_choice_guard ON file_proposal_choice_groups;
CREATE TRIGGER proposal_choice_guard BEFORE UPDATE ON file_proposal_choice_groups FOR EACH ROW EXECUTE FUNCTION file_proposal_choice_guard();
DROP TRIGGER IF EXISTS proposal_membership_immutable ON file_proposal_choice_memberships;
CREATE TRIGGER proposal_membership_immutable BEFORE UPDATE ON file_proposal_choice_memberships FOR EACH ROW EXECUTE FUNCTION file_proposal_immutable_row();
DROP TRIGGER IF EXISTS proposal_membership_guard ON file_proposal_choice_memberships;
CREATE TRIGGER proposal_membership_guard BEFORE INSERT ON file_proposal_choice_memberships FOR EACH ROW EXECUTE FUNCTION file_proposal_membership_guard();
DROP TRIGGER IF EXISTS proposal_evaluation_scope ON file_proposal_evaluations;
CREATE TRIGGER proposal_evaluation_scope BEFORE INSERT ON file_proposal_evaluations FOR EACH ROW EXECUTE FUNCTION file_proposal_scoped_payload_guard();
DROP TRIGGER IF EXISTS proposal_evaluation_immutable ON file_proposal_evaluations;
CREATE TRIGGER proposal_evaluation_immutable BEFORE UPDATE ON file_proposal_evaluations FOR EACH ROW EXECUTE FUNCTION file_proposal_immutable_row();
DROP TRIGGER IF EXISTS proposal_receipt_guard ON file_proposal_action_receipts;
CREATE TRIGGER proposal_receipt_guard BEFORE UPDATE ON file_proposal_action_receipts FOR EACH ROW EXECUTE FUNCTION file_proposal_receipt_guard();
DROP TRIGGER IF EXISTS proposal_binding_scope ON file_revision_proposal_bindings;
CREATE TRIGGER proposal_binding_scope BEFORE INSERT ON file_revision_proposal_bindings FOR EACH ROW EXECUTE FUNCTION file_proposal_scoped_payload_guard();
DROP TRIGGER IF EXISTS proposal_binding_immutable ON file_revision_proposal_bindings;
CREATE TRIGGER proposal_binding_immutable BEFORE UPDATE ON file_revision_proposal_bindings FOR EACH ROW EXECUTE FUNCTION file_proposal_immutable_row();
`;

export const PROPOSAL_GRAPH_STORAGE_DOWN_SQL = `
ALTER TABLE IF EXISTS file_proposal_graphs DROP CONSTRAINT IF EXISTS proposal_graph_active_action_fk;
ALTER TABLE IF EXISTS file_proposal_choice_groups DROP CONSTRAINT IF EXISTS proposal_choice_dependency_fk;
ALTER TABLE IF EXISTS file_proposal_choice_groups DROP CONSTRAINT IF EXISTS proposal_choice_selected_member_fk;
ALTER TABLE IF EXISTS file_change_proposals DROP CONSTRAINT IF EXISTS proposal_source_evaluation_fk;
DROP TABLE IF EXISTS file_proposal_artifact_pins;
DROP TABLE IF EXISTS file_revision_proposal_bindings;
DROP TABLE IF EXISTS file_proposal_action_receipts;
DROP TABLE IF EXISTS file_proposal_evaluations;
DROP TABLE IF EXISTS file_proposal_choice_memberships;
DROP TABLE IF EXISTS file_change_proposals;
DROP TABLE IF EXISTS file_proposal_choice_groups;
DROP TABLE IF EXISTS file_proposal_artifacts;
DROP TABLE IF EXISTS file_proposal_graphs;
DROP FUNCTION IF EXISTS file_proposal_receipt_guard();
DROP FUNCTION IF EXISTS file_proposal_scoped_payload_guard();
DROP FUNCTION IF EXISTS file_proposal_choice_guard();
DROP FUNCTION IF EXISTS file_proposal_membership_guard();
DROP FUNCTION IF EXISTS file_proposal_graph_guard();
DROP FUNCTION IF EXISTS file_proposal_node_guard();
DROP FUNCTION IF EXISTS file_proposal_immutable_row();
DROP INDEX IF EXISTS idx_proposal_operation_scope;
DROP INDEX IF EXISTS idx_proposal_document_scope;
`;

type ProposalGraphMigrationQueryable = {
  query: (sql: string) => Promise<unknown>;
  exec?: (sql: string) => Promise<unknown>;
};

export async function runProposalGraphStorageMigration(postgres: ProposalGraphMigrationQueryable): Promise<void> {
  if (postgres.exec) await postgres.exec(PROPOSAL_GRAPH_STORAGE_UP_SQL);
  else await postgres.query(PROPOSAL_GRAPH_STORAGE_UP_SQL);
}

export async function rollbackProposalGraphStorageMigration(postgres: ProposalGraphMigrationQueryable): Promise<void> {
  if (postgres.exec) await postgres.exec(PROPOSAL_GRAPH_STORAGE_DOWN_SQL);
  else await postgres.query(PROPOSAL_GRAPH_STORAGE_DOWN_SQL);
}
