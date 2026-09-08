import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';

const RUNTIME_SOURCE_ROOTS = ['app', 'server'] as const;
const PROVIDER_NEUTRAL_USER_QUERY_FILES = [
  'app/lib/agent-runtime-policy/bootstrap-service.ts',
  'app/lib/memory/approval-attention.ts',
  'app/lib/memory/legacy-migration.ts',
] as const;
const SQL_STATEMENT_PATTERN = /\b(?:DELETE|INSERT|SELECT|UPDATE|WITH)\b/iu;
const SQL_RUNTIME_METHODS = new Set(['all', 'get', 'run', 'query']);
const SQL_QUESTION_MARK_PATTERN = /\?/u;
const BARE_PARAMETER_PATTERN = String.raw`(?:\?|\$\d+)`;
const UNSAFE_CASE_PATTERNS = [
  new RegExp(
    String.raw`\bCASE\b(?:(?!\bEND\b)[\s\S])*?\bTHEN\s+NULL\s+ELSE\s+${BARE_PARAMETER_PATTERN}\s*\bEND\b`,
    'iu',
  ),
  new RegExp(
    String.raw`\bCASE\b(?:(?!\bEND\b)[\s\S])*?\bTHEN\s+${BARE_PARAMETER_PATTERN}\s+ELSE\s+NULL\s*\bEND\b`,
    'iu',
  ),
];
const UNSAFE_SUBSTRING_PATTERN = new RegExp(
  String.raw`\bSUBSTRING\s*\((?:(?!\))[\s\S])*?\bFROM\s+${BARE_PARAMETER_PATTERN}(?:\s+FOR\b(?:(?!\))[\s\S])*)?\s*\)`,
  'iu',
);

type SqlFinding = {
  file: string;
  line: number;
  reason: string;
};

async function runtimeSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return runtimeSourceFiles(absolutePath);
    return /\.tsx?$/u.test(entry.name) ? [absolutePath] : [];
  }));
  return nested.flat();
}

function literalSql(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;

  let value = node.head.text;
  for (const span of node.templateSpans) {
    value += span.literal.text;
  }
  return value;
}

function sourceFindings(file: string, source: string): SqlFinding[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: SqlFinding[] = [];

  function visit(node: ts.Node): void {
    const sql = literalSql(node);
    if (sql && SQL_STATEMENT_PATTERN.test(sql)) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      if (UNSAFE_SUBSTRING_PATTERN.test(sql)) {
        findings.push({
          file,
          line: location.line + 1,
          reason: 'SUBSTRING FROM parameter needs an explicit integer cast',
        });
      }
      if (UNSAFE_CASE_PATTERNS.some((pattern) => pattern.test(sql))) {
        findings.push({
          file,
          line: location.line + 1,
          reason: 'CASE parameter paired only with NULL needs an explicit target-type cast',
        });
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const firstArgument = node.arguments[0];
      const runtimeSql = firstArgument ? literalSql(firstArgument) : null;
      if (SQL_RUNTIME_METHODS.has(method) && runtimeSql && SQL_STATEMENT_PATTERN.test(runtimeSql)
        && SQL_QUESTION_MARK_PATTERN.test(runtimeSql)) {
        const location = sourceFile.getLineAndCharacterOfPosition(firstArgument!.getStart(sourceFile));
        findings.push({
          file,
          line: location.line + 1,
          reason: 'Runtime SQL must use native PostgreSQL $n parameters; found ? placeholder',
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function assertDetectorCatchesRegressions(): void {
  assert.equal(
    sourceFindings('runtime-question.ts', 'database.all("SELECT * FROM jobs WHERE id = ?", [jobId])')[0]?.reason,
    'Runtime SQL must use native PostgreSQL $n parameters; found ? placeholder',
  );
  assert.deepEqual(
    sourceFindings(
      'runtime-template-expression.ts',
      'db.get(`SELECT * FROM jobs WHERE id = $1${activeOnly ? " AND active" : ""}`, [jobId])',
    ),
    [],
  );
  assert.equal(
    sourceFindings(
      'runtime-template-question.ts',
      'db.get(`SELECT * FROM jobs WHERE id = ?${activeOnly ? " AND active" : ""}`, [jobId])',
    )[0]?.reason,
    'Runtime SQL must use native PostgreSQL $n parameters; found ? placeholder',
  );
  assert.deepEqual(sourceFindings('typescript-question.ts', 'const value = record?.value ?? "?";'), []);
  assert.deepEqual(sourceFindings('ordinary-string.ts', 'const value = "A question?";'), []);
  const unsafeCase = sourceFindings(
    'unsafe-case.ts',
    '`UPDATE jobs SET next_attempt_at = CASE WHEN failed = 1 THEN NULL ELSE ? END`',
  );
  assert.deepEqual(
    unsafeCase.map((finding) => finding.reason),
    ['CASE parameter paired only with NULL needs an explicit target-type cast'],
  );

  const unsafeSubstring = sourceFindings(
    'unsafe-substring.ts',
    '`UPDATE files SET path = SUBSTRING(path FROM $1)`',
  );
  assert.deepEqual(
    unsafeSubstring.map((finding) => finding.reason),
    ['SUBSTRING FROM parameter needs an explicit integer cast'],
  );

  assert.deepEqual(
    sourceFindings(
      'safe-casts.ts',
      '`UPDATE jobs SET next_attempt_at = CASE WHEN failed = 1 THEN NULL ELSE CAST(? AS BIGINT) END, path = SUBSTRING(path FROM CAST($1 AS INTEGER))`',
    ),
    [],
  );
}

async function assertRuntimeSqlIsUnambiguous(): Promise<void> {
  const root = process.cwd();
  const files = (await Promise.all(
    RUNTIME_SOURCE_ROOTS.map((directory) => runtimeSourceFiles(path.join(root, directory))),
  )).flat();
  const findings = (await Promise.all(files.map(async (file) => (
    sourceFindings(path.relative(root, file), await fs.readFile(file, 'utf8'))
  )))).flat();

  assert.deepEqual(
    findings,
    [],
    `Unsafe PostgreSQL parameter inference found:\n${findings
      .map((finding) => `${finding.file}:${finding.line} ${finding.reason}`)
      .join('\n')}`,
  );
}

async function assertProviderNeutralUserQueriesAreQuoted(): Promise<void> {
  const root = process.cwd();
  const findings = (await Promise.all(PROVIDER_NEUTRAL_USER_QUERY_FILES.map(async (file) => {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    return /\b(?:FROM|JOIN)\s+user\b/iu.test(source) ? file : null;
  }))).filter((file) => file !== null);

  assert.deepEqual(
    findings,
    [],
    `PostgreSQL reserves USER; quote the table name in provider-neutral SQL:\n${findings.join('\n')}`,
  );
}

async function assertPostgresFailureModes(): Promise<void> {
  const postgres = new PGlite();
  try {
    await postgres.exec('CREATE TABLE compatibility_probe (path TEXT, timestamp_value BIGINT)');
    await postgres.exec("INSERT INTO compatibility_probe VALUES ('folder/file.md', 0)");

    const ambiguousSubstring = await postgres.query<{ value: string | null }>(
      'SELECT SUBSTRING(path FROM $1) AS value FROM compatibility_probe',
      [8],
    );
    assert.equal(ambiguousSubstring.rows[0]?.value, null);

    const typedSubstring = await postgres.query<{ value: string | null }>(
      'SELECT SUBSTRING(path FROM CAST($1 AS INTEGER)) AS value FROM compatibility_probe',
      [8],
    );
    assert.equal(typedSubstring.rows[0]?.value, 'file.md');

    await assert.rejects(
      postgres.query(
        `UPDATE compatibility_probe
         SET timestamp_value = CASE WHEN timestamp_value > 0 THEN NULL ELSE $1 END`,
        [1_000],
      ),
      /column "timestamp_value" is of type bigint but expression is of type text/iu,
    );

    await postgres.query(
      `UPDATE compatibility_probe
       SET timestamp_value = CASE
         WHEN timestamp_value > 0 THEN NULL
         ELSE CAST($1 AS BIGINT)
       END`,
      [1_000],
    );
    const typedCase = await postgres.query<{ timestamp_value: string }>(
      'SELECT timestamp_value::text AS timestamp_value FROM compatibility_probe',
    );
    assert.equal(typedCase.rows[0]?.timestamp_value, '1000');

    await postgres.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
    await postgres.exec("INSERT INTO \"user\" (id) VALUES ('user-a'), ('user-b')");
    const reservedUserExpression = await postgres.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM user');
    const quotedUserTable = await postgres.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM "user"');
    assert.equal(reservedUserExpression.rows[0]?.count, 1);
    assert.equal(quotedUserTable.rows[0]?.count, 2);
    await assert.rejects(
      postgres.query('SELECT creator.id FROM user creator'),
      /column creator\.id does not exist/iu,
    );

    const foldedAlias = await postgres.query<Record<string, string>>("SELECT 'org-1' AS organizationId");
    const quotedAlias = await postgres.query<Record<string, string>>('SELECT \'org-1\' AS "organizationId"');
    assert.equal(foldedAlias.rows[0]?.organizationId, undefined);
    assert.equal(foldedAlias.rows[0]?.organizationid, 'org-1');
    assert.equal(quotedAlias.rows[0]?.organizationId, 'org-1');
  } finally {
    await postgres.close();
  }
}

async function main(): Promise<void> {
  assertDetectorCatchesRegressions();
  await assertRuntimeSqlIsUnambiguous();
  await assertProviderNeutralUserQueriesAreQuoted();
  await assertPostgresFailureModes();
  console.log('postgres-runtime-sql-compatibility-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
