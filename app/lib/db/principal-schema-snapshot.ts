import 'server-only';

/** Facts only. Callers retain their own authentication and phase decisions. */
export const realmSql = `SELECT pg_catalog.current_schema() AS schema,
  pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
  (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
  CASE WHEN octet_length(pg_catalog.current_setting('search_path'))<=16384 THEN pg_catalog.current_setting('search_path') END AS search_path`;

/** Fixed catalog queries shared by genuine transports; all values stay bound. */
export function principalSchemaSnapshotSql(schemaParameter = 1, relationsParameter = 2, relationLimit = 32): string {
  if (![schemaParameter, relationsParameter, relationLimit].every(value => Number.isInteger(value) && value >= 1 && value <= 32)) {
    throw new RangeError('Invalid principal schema snapshot parameter ordinal or relation limit.');
  }
  const schema = '$' + schemaParameter, relations = '$' + relationsParameter;
  return `SELECT r.*,pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    CASE WHEN pg_catalog.current_setting('transaction_isolation')='read committed'
      AND pg_catalog.current_setting('transaction_read_only')='off' THEN pg_catalog.pg_current_xact_id()::text END AS xid,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(facts)),'[]'::jsonb)
      FROM (SELECT name,
    pg_catalog.to_regclass(name)::oid=pg_catalog.to_regclass(${schema}||'.'||pg_catalog.quote_ident(name))::oid AS same_relation
    FROM pg_catalog.unnest(${relations}::text[]) names(name) LIMIT ${relationLimit}) facts) AS schema_relations
    FROM (${realmSql}) r JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_catalog.pg_backend_pid()`;
}
