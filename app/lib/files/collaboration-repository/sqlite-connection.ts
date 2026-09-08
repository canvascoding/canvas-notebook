import type { SqlConnection } from '@/app/lib/db';

/**
 * The file collaboration repository also serves the supported single-user
 * SQLite runtime. This adapter covers its small, fixed SQL vocabulary only.
 * BEGIN IMMEDIATE supplies the transaction-wide write reservation that replaces
 * PostgreSQL row/advisory locks; canonical file operations additionally hold
 * the cross-process workspace mutex. Live Yjs still requires PostgreSQL.
 */
export function sqliteFileCollaborationConnection(connection: SqlConnection): SqlConnection {
  function translate(sql: string, params: unknown[] = []) {
    if (sql.trim() === 'BEGIN') return { sql: 'BEGIN IMMEDIATE', params: [] };
    let query = sql.replace(/\bFOR UPDATE\b/gu, '')
      .replace(/left\(path, char_length\((\$\d+)\) \+ 1\)/gu, 'substr(path, 1, length($1) + 1)')
      .replace(/substring\(path FROM char_length\((\$\d+)\) \+ 1\)/gu, 'substr(path, length($1) + 1)');
    query = query.replace(/SELECT DISTINCT ON \(lineage_id, provider\) id\s+FROM collaboration_documents\s+WHERE lineage_id = ANY\(\$1::text\[\]\)\s+AND status = 'archived'\s+ORDER BY lineage_id, provider, updated_at DESC, id DESC/u,
      `SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY lineage_id, provider ORDER BY updated_at DESC, id DESC) AS rank
        FROM collaboration_documents WHERE lineage_id = ANY($1::text[]) AND status = 'archived'
      ) WHERE rank = 1`);
    const arrays = new Set<number>();
    query = query.replace(/= ANY\(\$(\d+)::text\[\]\)/gu, (_token, index: string) => {
      arrays.add(Number(index) - 1);
      return `IN (SELECT value FROM json_each($${index}))`;
    });
    const bound: unknown[] = [];
    // Skip quoted SQL literals and identifiers while converting numbered binds.
    query = query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\$(\d+)/gu, (token, index: string | undefined) => {
      if (!index) return token;
      const position = Number(index) - 1;
      if (position >= params.length) throw new Error('Missing file collaboration SQL parameter.');
      bound.push(arrays.has(position) ? JSON.stringify(params[position]) : params[position]);
      return '?';
    });
    return { sql: query, params: bound.length ? bound : params };
  }
  return {
    get(sql, params) {
      if (/^\s*SELECT pg_advisory_xact_lock\(/u.test(sql)) return undefined;
      const translated = translate(sql, params);
      return connection.get(translated.sql, translated.params);
    },
    all(sql, params) {
      const translated = translate(sql, params);
      return connection.all(translated.sql, translated.params);
    },
    async run(sql, params) {
      // Live collaboration is a PostgreSQL capability. Its lifecycle projection
      // updates are empty in SQLite installations where those tables do not exist.
      const liveTable = /^\s*UPDATE (collaboration_agent_operations|collaboration_yjs_states|collaboration_excalidraw_states)\b/u.exec(sql)?.[1];
      if (liveTable && !await connection.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [liveTable])) {
        return { changes: 0 };
      }
      const translated = translate(sql, params);
      return connection.run(translated.sql, translated.params);
    },
    close: () => connection.close(),
  };
}
