import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';

// Mechanical header/SQL-shape regression only. Declared private phases and the
// declared Claim response below are not genuine request, job or SQL authority.
// No Auth/License service, public factory, PostgreSQL or Owner is initialized.
const sourcePath = path.resolve('app/lib/workspaces/request-principal.ts');
const ownPath = path.resolve('scripts/workspace-request-principal-header-test.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceHash = hash(source), ownHash = hash(fs.readFileSync(ownPath, 'utf8'));
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter({ removeComments: true });
const functions = ['active', 'parseIdentity', 'identity', 'checkIdentity', 'principalRelations', 'assertJobClaim', 'jobRequest', 'fail', 'guestFail'];
const variables = ['phases', 'tables', 'agentTables', 'quote', 'number', 'principalIdentitySql'];
const classes = ['WorkspaceRequestPrincipalError', 'FileGuestInvitationAuthorityError'];
const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) ? functions.includes(node.name?.text ?? '')
  : ts.isClassDeclaration(node) ? classes.includes(node.name?.text ?? '')
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && variables.includes(declaration.name.text)));
assert.equal(selected.length, functions.length + variables.length + classes.length);
const extracted = selected.map(node => printer.printNode(ts.EmitHint.Unspecified, node, ast)).join('\n');
const compiled = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const statementHash = (nodes: readonly ts.Node[]) => hash(nodes.map(node => printer.printNode(ts.EmitHint.Unspecified, node, ast)).join('\n'));
const body = (name: string) => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(node && ts.isFunctionDeclaration(node) && node.body); return node.body.statements;
};
const variable = (name: string) => {
  const node = ast.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert(node?.initializer); return node.initializer;
};
test('original identity SQL and all four original validator blocks retain their exact AST', () => {
  const literal = variable('principalIdentitySql'); assert(ts.isNoSubstitutionTemplateLiteral(literal));
  assert.equal(hash(literal.text), '93b9b85c18ec576a5389cfb3662c5fdc284cfdbb96988e670ac25aeb6afd7f75');
  const identityMatch = body('checkIdentity').filter(ts.isIfStatement)[0];
  const relationsGuard = body('checkIdentity').filter(ts.isIfStatement).at(-1)!;
  const jobRealmGuard = body('assertJobClaim').filter(ts.isIfStatement).at(-1)!;
  assert.deepEqual({ validation: statementHash(body('parseIdentity')), identityMatch: statementHash([identityMatch]),
    relationsGuard: statementHash([relationsGuard]), jobRealmGuard: statementHash([jobRealmGuard]) }, {
    // Original source SHA657ee0e0… before this single-file batching change.
    validation: 'e999ebbc3111fbcaffc6de92d1af65222f57981dce1831450066964a927cef0f',
    identityMatch: '4372947f2b172d128ed82181e1b68f2e32e6314961cd502a15ad9c5859cbc83e',
    relationsGuard: 'd348e81f6af9003def2f0df4c9fd52d623fd3bb546adc0578edab88748b27b8a',
    jobRealmGuard: 'b916503622c631e40c0d9cff0ce667e7ea34532375b141436f90d2c4605a4c6f',
  });
});

type Row = Record<string, unknown>;
type Identity = { schema: string; searchPath: string; database: number; backend: number; start: string; transaction: string };
type Kind = 'member' | 'agent_tool' | 'file_guest' | 'job_user' | 'job_agent';
type Phase = { active: boolean; deadline: number; failure?: unknown; database: SqlConnection; identity?: Identity;
  request: { active: boolean; kind: Kind; schema: string; database: number; failure?: unknown; expiresAt: number;
    license: { licensed: boolean; licenseState?: string; expiresAt?: string }; binding: Row; claim: object;
    policy: { schema: string; schemaOid: number; database: number; searchPath: string; failure?: unknown } } };
type HeaderModule = { phases: WeakMap<SqlConnection, Phase>; principalRelations: (phase: Phase) => string[];
  identity: (phase: Phase) => Promise<Identity>; checkIdentity: (phase: Phase) => Promise<Row>;
  assertJobClaim: (phase: Phase) => Promise<void> };
const coreTables = ['canvas_organization_settings', 'team_memberships', 'team_membership_sync_state', 'user', 'session',
  'organization_user_permissions', 'canvas_workspaces', 'canvas_projects', 'canvas_workspace_members', 'canvas_project_members'];
const agentTables = ['pi_sessions', 'agents', 'agent_members', 'agent_grants'];
const expectedTables = (kind: Kind) => kind === 'job_user' ? coreTables.filter(name => name !== 'session')
  : ['agent_tool', 'job_agent'].includes(kind) ? [...coreTables.filter(name => name !== 'session'), ...agentTables]
    : kind === 'file_guest' ? [...coreTables, 'file_guest_invitations'] : coreTables;
function harness(kind: Kind = 'member') {
  const originalIdentity: Identity = { schema: 'header_fixture', searchPath: '"header_fixture"', database: 31, backend: 42, start: '10.5', transaction: '91' };
  const binding = { source: { databaseOid: 31, schemaName: originalIdentity.schema, schemaOid: 21, searchPath: originalIdentity.searchPath } };
  const state = { row: { schema: originalIdentity.schema, search_path: originalIdentity.searchPath, database: '31', backend: '42', start: '10.5',
    transaction: '91', isolation: 'read committed', read_only: 'off', replication: 'origin', schema_oid: '21',
    relations: expectedTables(kind).map(name => ({ name, same: true })) } as Row | undefined,
  calls: [] as Array<{ sql: string; parameters: unknown[] }>, claimCalls: 0, claimResult: binding as Row,
  beforeResponse: undefined as (() => void | Promise<void>) | undefined, invocationChecks: 0 };
  const database: SqlConnection = {
    get: async (sql, parameters = []) => { state.calls.push({ sql, parameters }); await state.beforeResponse?.(); return structuredClone(state.row); },
    all: async () => { throw new Error('No second relation query is allowed.'); },
    run: async () => { throw new Error('Header inspection must not mutate SQL or transactions.'); },
    close: () => { throw new Error('Header inspection must not close borrowed SQL.'); },
  };
  const loaded = { exports: {} };
  const api = new Function('module', 'exports', 'performance', 'assertCurrentAgentToolInvocation', 'assertWorkspaceOperationBatchClaimOnConnection',
    `${compiled}\nreturn {phases,principalRelations,identity,checkIdentity,assertJobClaim};`)(loaded, loaded.exports, performance,
    () => { state.invocationChecks++; }, async (db: SqlConnection) => { assert.equal(db, database); state.claimCalls++; return state.claimResult; }) as HeaderModule;
  const phase: Phase = { active: true, deadline: performance.now() + 5000, database, identity: originalIdentity,
    request: { active: true, kind, schema: originalIdentity.schema, database: 31, expiresAt: Date.now() + 60_000,
      license: { licensed: false }, binding, claim: {}, policy: { schema: originalIdentity.schema, schemaOid: 21, database: 31, searchPath: originalIdentity.searchPath } } };
  api.phases.set(database, phase);
  return { api, phase, state, originalIdentity };
}

test('initial identity still uses its original single fresh SELECT and parser', async () => {
  const h = harness(); assert.deepEqual(await h.api.identity(h.phase), h.originalIdentity);
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.calls[0].parameters.length, 0);
});
for (const kind of ['member', 'agent_tool', 'file_guest', 'job_user', 'job_agent'] as const) test(`${kind}: one fresh SELECT covers its actual complete relation set`, async () => {
  const h = harness(kind); const result = await h.api.checkIdentity(h.phase);
  assert.equal(result.schema_oid, '21'); assert.equal(h.state.calls.length, 1);
  assert.deepEqual(h.api.principalRelations(h.phase), expectedTables(kind));
  assert.deepEqual(h.state.calls[0].parameters, ['"header_fixture"', expectedTables(kind)]);
  const sql = h.state.calls[0].sql;
  assert.match(sql, /FROM \(SELECT current_schema\(\)/u); assert.match(sql, /jsonb_agg\(to_jsonb\(r\)/u);
  assert.match(sql, /to_regclass\(name\)::oid=to_regclass/u); assert.match(sql, /unnest\(\$2::text\[\]\)/u);
  assert.match(sql, /to_regnamespace\(current_schema\(\)\)::oid::bigint AS schema_oid/u);
  assert.equal(sql.includes(';'), false);
  await h.api.checkIdentity(h.phase); assert.equal(h.state.calls.length, 2, 'Every call must inspect fresh facts.');
  if (kind === 'agent_tool') assert.equal(h.state.invocationChecks, 4);
});
const invalidHeaders: Array<[string, (h: ReturnType<typeof harness>) => void, string]> = [
  ['missing header', h => { h.state.row = undefined; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['database drift', h => { h.state.row!.database = 32; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['database overflow', h => { h.state.row!.database = '9007199254740992'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['schema drift', h => { h.state.row!.schema = 'other'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['backend drift', h => { h.state.row!.backend = 43; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['backend lifetime drift', h => { h.state.row!.start = '10.6'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['XID drift', h => { h.state.row!.transaction = '92'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['missing XID', h => { h.state.row!.transaction = null; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['malformed XID', h => { h.state.row!.transaction = '9x'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['search_path drift', h => { h.state.row!.search_path = 'public'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['wrong isolation', h => { h.state.row!.isolation = 'repeatable read'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['read-only TX', h => { h.state.row!.read_only = 'on'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['replica triggers', h => { h.state.row!.replication = 'replica'; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['missing original identity', h => { h.phase.identity = undefined; }, 'PRINCIPAL_SCOPE_CHANGED'],
  ['missing relation', h => { (h.state.row!.relations as Row[]).pop(); }, 'PRINCIPAL_SCHEMA_INVALID'],
  ['extra relation', h => { (h.state.row!.relations as Row[]).push({ name: 'extra', same: true }); }, 'PRINCIPAL_SCHEMA_INVALID'],
  ['unqualified shadow', h => { (h.state.row!.relations as Row[])[0].same = false; }, 'PRINCIPAL_SCHEMA_INVALID'],
  ['unresolved relation', h => { (h.state.row!.relations as Row[])[0].same = null; }, 'PRINCIPAL_SCHEMA_INVALID'],
  ['string true relation', h => { (h.state.row!.relations as Row[])[0].same = 'true'; }, 'PRINCIPAL_SCHEMA_INVALID'],
  ['null relation', h => { (h.state.row!.relations as unknown[])[0] = null; }, 'PRINCIPAL_SCHEMA_INVALID'],
  ['non-array relation group', h => { h.state.row!.relations = {}; }, 'PRINCIPAL_SCHEMA_INVALID'],
];
for (const [label, mutate, code] of invalidHeaders) test(`fresh header rejects ${label}`, async () => {
  const h = harness(); await h.api.checkIdentity(h.phase); mutate(h);
  await assert.rejects(h.api.checkIdentity(h.phase), { code }); assert.equal(h.state.calls.length, 2);
});
for (const kind of ['job_user', 'job_agent'] as const) test(`${kind}: original Claim-check boundary retained, job realm now shares its one header SELECT`, async () => {
  const h = harness(kind); await h.api.assertJobClaim(h.phase);
  assert.equal(h.state.claimCalls, 1); assert.equal(h.state.calls.length, 1);
  h.state.row!.schema_oid = 22;
  await assert.rejects(h.api.assertJobClaim(h.phase), { code: 'PRINCIPAL_SCOPE_CHANGED' });
  assert.equal(h.state.claimCalls, 2); assert.equal(h.state.calls.length, 2);
});
for (const value of [null, 0, '0', '21x', '9007199254740992']) test(`job rejects invalid fresh schema OID ${String(value)}`, async () => {
  const h = harness('job_user'); h.state.row!.schema_oid = value;
  await assert.rejects(h.api.assertJobClaim(h.phase), { code: 'PRINCIPAL_SCOPE_CHANGED' });
});
test('job rejects foreign Claim binding before header SQL and preserves a poisoned policy failure', async () => {
  const h = harness('job_user'); h.state.claimResult = structuredClone(h.state.claimResult);
  await assert.rejects(h.api.assertJobClaim(h.phase), { code: 'PRINCIPAL_SCOPE_CHANGED' }); assert.equal(h.state.calls.length, 0);
  const error = new Error('declared policy failure'); h.phase.request.policy.failure = error;
  await assert.rejects(h.api.assertJobClaim(h.phase), failure => failure === error); assert.equal(h.state.claimCalls, 1);
});
for (const [label, invalidate] of [
  ['phase', (h: ReturnType<typeof harness>) => { h.phase.active = false; }],
  ['outer lifetime', (h: ReturnType<typeof harness>) => { h.phase.request.active = false; }],
  ['foreign current phase', (h: ReturnType<typeof harness>) => { h.api.phases.set(h.phase.database, { ...h.phase }); }],
] as const) test(`actual active guard rejects ${label} ending during header await`, async () => {
  const h = harness(); h.state.beforeResponse = () => { invalidate(h); };
  await assert.rejects(h.api.checkIdentity(h.phase), { code: 'PRINCIPAL_REQUIRED' }); assert.equal(h.state.calls.length, 1);
});
test('actual active guard retains deadline, license expiry and poison before returning facts', async () => {
  const h = harness(); h.state.beforeResponse = () => { h.phase.deadline = performance.now() - 1; };
  await assert.rejects(h.api.checkIdentity(h.phase), { code: 'PRINCIPAL_EXPIRED' });
  h.phase.deadline = performance.now() + 5000; h.state.beforeResponse = undefined;
  h.phase.request.license = { licensed: true, licenseState: 'active', expiresAt: new Date(Date.now() - 1000).toISOString() };
  await assert.rejects(h.api.checkIdentity(h.phase), { code: 'PRINCIPAL_EXPIRED' }); assert.equal(h.state.calls.length, 1);
  const error = new Error('declared retained failure'); h.phase.failure = error;
  await assert.rejects(h.api.checkIdentity(h.phase), failure => failure === error); assert.equal(h.state.calls.length, 1);
});
test('query rejection preserves its original error and has no successful cached fallback', async () => {
  const h = harness(); await h.api.checkIdentity(h.phase);
  const error = new Error('declared transport failure'); h.state.beforeResponse = () => { throw error; };
  await assert.rejects(h.api.checkIdentity(h.phase), failure => failure === error); assert.equal(h.state.calls.length, 2);
});
after(() => {
  assert.equal(hash(fs.readFileSync(sourcePath, 'utf8')), sourceHash);
  assert.equal(hash(fs.readFileSync(ownPath, 'utf8')), ownHash);
});
