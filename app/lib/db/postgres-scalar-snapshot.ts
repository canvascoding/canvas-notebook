import 'server-only';

/** Data-only SQL for fixed internal columns, never an authorization decision.
 * NUMERIC must retain pg's exact string representation through JSON decoding.
 * DATE and domains are unsupported: their driver semantics need separate proof.
 * One JSONB result type also permits prepared plans across scalar type changes. */
export function postgresScalarSnapshotSql(sql: string, scalarColumns: readonly string[]): string {
  if (!scalarColumns.length || scalarColumns.length > 48 || new Set(scalarColumns).size !== scalarColumns.length
    || scalarColumns.some(name => !/^[a-z_][a-z0-9_]*$/u.test(name) || name === 'scalar_types_supported')) {
    throw new RangeError('Invalid scalar snapshot columns.');
  }
  const supportedTypes = '16,20,21,23,25,26,700,701,1042,1043,1114,1184,1700';
  return `SELECT pg_catalog.to_jsonb(facts)||pg_catalog.jsonb_build_object(
    'scalar_types_supported',${scalarColumns.map(name => `pg_catalog.pg_typeof(facts.${name})::oid IN (${supportedTypes})`).join(' AND ')},
    ${scalarColumns.map(name => `'${name}',CASE WHEN pg_catalog.pg_typeof(facts.${name})::oid=1700
      THEN pg_catalog.to_jsonb(facts.${name}::text) ELSE pg_catalog.to_jsonb(facts.${name}) END`).join(',')}
    ) AS facts FROM (${sql}) facts`;
}
