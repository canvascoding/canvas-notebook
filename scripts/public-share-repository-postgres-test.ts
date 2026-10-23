import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { PublicShareRow } from '../app/lib/public-sharing/public-file-shares';

const sourcePaths = ['scripts/public-share-repository-postgres-test.ts','app/lib/public-sharing/repository.ts'];
const sourceHashes = async () => Promise.all(sourcePaths.map(async file => crypto.createHash('sha256').update(await readFile(file)).digest('hex')));
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
type Row = Record<string, unknown>;

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  const sources = await sourceHashes();
  console.log('Public share repository source pins:', JSON.stringify(sources));
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost','127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `public_repository_${crypto.randomUUID().replaceAll('-', '')}`, nonce = crypto.randomUUID();
  assert.match(schema, /^public_repository_[a-f0-9]{32}$/u);
  const table = `"${schema}".public_file_shares`, environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-public-share-repository-'))), rootIdentity = await stat(dataRoot);
  assert.equal(rootIdentity.uid, process.getuid!()); assert.equal(rootIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  let created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false, fetches = 0, repositoryCloses = 0;
  let repositoryTransactionCommands = 0, primary: { error: unknown } | undefined, timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true; process.exitCode = 1;
    console.error('Public share repository completion deadline exceeded:', JSON.stringify({ stage, passed }));
  }, 120000);
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=10000 -c lock_timeout=5000 -c application_name=public-repository-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); passed++; console.log('Public share repository case passed:', JSON.stringify({ passed, name }));
  };
  // A direct real-client adapter, not a SQL mock. Repository calls must neither
  // close the borrowed connection nor own the outer BEGIN/COMMIT/ROLLBACK.
  const borrowed = (client: Client): SqlConnection => {
    const query = async (sql: string, values?: unknown[]) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)\s*;?$/iu.test(sql.trim())) repositoryTransactionCommands++;
      return client.query(sql, values);
    };
    return { get: async (sql, values) => (await query(sql, values)).rows[0],
      all: async (sql, values) => (await query(sql, values)).rows,
      run: async (sql, values) => query(sql, values),
      close: async () => { repositoryCloses++; await endClient(client); } };
  };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot });
    delete process.env.NEXT_PHASE;
    globalThis.fetch = async () => { fetches++; throw new Error('No HTTP is permitted in the owned repository fixture.'); };
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query(`SELECT current_database() AS database,current_schema() AS schema,
        current_setting('search_path') AS path,n.oid,obj_description(n.oid,'pg_namespace') AS nonce,
        n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner
        FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(row.database, 'canvas_notebook'); assert.equal(row.schema, schema);
      assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema,'pg_catalog']);
    };
    stage = 'original migrations in owned schema';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('repository-owner','Owner','owner@repository.test',1,'user',0,100,100)`);
    await admin.query('CREATE SEQUENCE fixture_repository_write_attempts');
    await admin.query(`CREATE FUNCTION fixture_repository_count() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('fixture_repository_write_attempts'); RETURN NULL; END $$`);
    await admin.query(`CREATE TRIGGER fixture_repository_count BEFORE INSERT OR UPDATE OR DELETE ON public_file_shares
      FOR EACH STATEMENT EXECUTE FUNCTION fixture_repository_count()`);
    const proof = async () => (await admin.query('SELECT last_value::text AS value,is_called FROM fixture_repository_write_attempts')).rows[0];
    const advanced = (before: Row, after: Row, count = 1) => {
      assert.equal(BigInt(String(after.value)), BigInt(String(before.value)) + BigInt(count) - (before.is_called ? BigInt(0) : BigInt(1)));
      assert.equal(after.is_called, true);
    };
    const repository = await import('../app/lib/public-sharing/repository');
    const shortCodeConstraints = (await admin.query(`SELECT c.relname AS name FROM pg_index i
      JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
      WHERE i.indrelid=$1::regclass AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indnkeyatts=1 AND i.indpred IS NULL AND a.attname='short_code'`,[table])).rows.map(row => String(row.name));
    assert(shortCodeConstraints.length>0);
    const connection = await ownClient(), database = borrowed(connection);
    const transaction = async <T>(operation: () => Promise<T>): Promise<T> => {
      await connection.query('BEGIN');
      try { const result = await operation(); await connection.query('COMMIT'); return result; }
      catch (error) { await connection.query('ROLLBACK'); throw error; }
    };
    const candidate = (overrides: Partial<PublicShareRow> = {}): PublicShareRow => {
      const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const shortCode = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
      return { id, token, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), tokenPreview: token.slice(0,8), shortCode,
        organizationId:'repository-org',customerId:'repository-customer',projectId:'repository-project',workspaceId:'repository-space',
        workspaceType:'organization',workspaceRootRelativePath:'organizations/repository-org/shared',workspacePath:`file-${id}.md`,
        documentId:null,lineageId:null,lifecycleGeneration:null,fileName:`file-${id}.md`,fileIdentity:`physical-${id}`,
        targetRevisionPolicy:'latest',lastKnownRevision:'fixture-revision',mimeType:'text/markdown',sizeBytes:123,
        status:'active',createdByUserId:'repository-owner',createdByAgentId:'repository-agent',sourceSessionId:'repository-session',
        source:'agent',securityMode:'strict',reason:'owned repository fixture',createdAt:new Date(100),updatedAt:new Date(150),
        expiresAt:new Date(Date.now()+3600000),revokedAt:null,revokedReason:null,passwordEnabled:1,passwordHash:'fixture-hash',
        lastAccessedAt:new Date(200),accessCount:7,policyRevision:3,...overrides };
    };
    const insert = (row: PublicShareRow, on = database) => repository.insertPublicShareOnConnection(on,{table,row});
    const read = (row: PublicShareRow, on = database) => repository.readPublicShareOnConnection(on,{table,workspaceId:row.workspaceId!,id:row.id});
    const active = (row: PublicShareRow, lock?: true, on = database) => repository.readActivePublicShareAtPathOnConnection(on,
      {table,workspaceId:row.workspaceId!,path:row.workspacePath,...(lock ? {forUpdate:lock} : {})});

    await check('complete physical row and canonical small millisecond timestamps round-trip on one borrowed transaction', async () => {
      const row = candidate(), writes = await proof();
      await transaction(async () => {
        const identity = (await connection.query('SELECT pg_current_xact_id()::text AS id,pg_backend_pid() AS backend')).rows[0];
        assert.deepEqual(await insert(row),row); assert.deepEqual(await read(row),row); assert.deepEqual(await active(row,true),row);
        assert.deepEqual((await connection.query('SELECT pg_current_xact_id()::text AS id,pg_backend_pid() AS backend')).rows[0],identity);
      });
      advanced(writes,await proof());
      const actual = (await admin.query('SELECT created_at,updated_at,last_accessed_at FROM public_file_shares WHERE id=$1',[row.id])).rows[0];
      assert.deepEqual(Object.values(actual).map(Number),[100,150,200]);
    });
    await check('all nullable physical fields remain actual NULL without native rebinding', async () => {
      const row = candidate({shortCode:null,organizationId:null,customerId:null,projectId:null,workspaceType:null,workspaceRootRelativePath:null,
        lastKnownRevision:null,createdByAgentId:null,sourceSessionId:null,source:'ui',reason:null,expiresAt:null,passwordEnabled:0,passwordHash:null,lastAccessedAt:null});
      await transaction(async () => { assert.deepEqual(await insert(row),row); assert.deepEqual(await read(row),row); });
    });
    await check('full native pins and non-default revoked metadata round-trip without claiming target authority', async () => {
      const row = candidate({documentId:crypto.randomUUID(),lineageId:crypto.randomUUID(),lifecycleGeneration:5,
        fileIdentity:'native:fixture-metadata-only',targetRevisionPolicy:'fixed',status:'revoked',revokedAt:new Date(250),revokedReason:'manual'});
      await transaction(async () => { assert.deepEqual(await insert(row),row); assert.deepEqual(await read(row),row); assert.equal(await active(row),null); });
    });
    await check('active selection preserves exact spaces, workspace boundaries and expired occupied slots', async () => {
      const row = candidate({workspacePath:` exact-${crypto.randomUUID()}.md `,expiresAt:new Date(100)});
      const neighbor = candidate({workspacePath:row.workspacePath.trim()}), foreign = candidate({workspacePath:row.workspacePath,workspaceId:'foreign-space'});
      await transaction(async () => {
        for (const value of [row,neighbor,foreign]) assert.deepEqual(await insert(value),value);
        for (const value of [row,neighbor,foreign]) assert.deepEqual(await active(value,true),value);
      });
    });
    for (const status of ['revoked','missing','stale','expired'] as const) await check(`active selection excludes stored ${status}`, async () => {
      const row = candidate({status}); await transaction(async () => { assert.deepEqual(await insert(row),row); assert.equal(await active(row),null); });
    });
    for (const collision of ['id','token','tokenHash','shortCode','active path'] as const) await check(`real ${collision} uniqueness conflict returns NULL and leaves B usable`, async () => {
      const original = candidate(); await transaction(async () => { assert.deepEqual(await insert(original),original); });
      const duplicate = candidate(collision === 'active path' ? {workspacePath:original.workspacePath} : {[collision]:original[collision]});
      const writes = await proof();
      await transaction(async () => {
        assert.equal(await insert(duplicate),null); assert.equal((await connection.query('SELECT 42 AS answer')).rows[0].answer,42);
        assert.deepEqual(await read(original),original);
      });
      advanced(writes,await proof());
    });
    await check('actual concurrent active-path INSERT waits for peer commit and then returns NULL on its original B', async () => {
      const winner = await ownClient(), loser = await ownClient(), first = candidate(), second = candidate({workspacePath:first.workspacePath});
      let pending: Promise<PublicShareRow | null> | undefined;
      try {
        await winner.query('BEGIN'); await loser.query('BEGIN'); assert.deepEqual(await insert(first,borrowed(winner)),first);
        const winnerPid = Number((await winner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const loserPid = Number((await loser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        pending = insert(second,borrowed(loser)); void pending.catch(() => undefined);
        const deadline = Date.now()+3000; let blocked = false;
        while (!blocked) {
          blocked = (await admin.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked',[winnerPid,loserPid])).rows[0].blocked === true;
          if (!blocked) { assert(Date.now()<deadline,'The real concurrent INSERT never waited on its owned peer.'); await new Promise(resolve => setTimeout(resolve,10)); }
        }
        await winner.query('COMMIT'); assert.equal(await pending,null); pending = undefined;
        assert.deepEqual(await read(first,borrowed(loser)),first); assert.equal((await loser.query('SELECT 42 AS answer')).rows[0].answer,42);
        await loser.query('ROLLBACK');
      } finally {
        await winner.query('ROLLBACK'); await loser.query('ROLLBACK');
        if (pending) await Promise.allSettled([pending]); await endClient(winner); await endClient(loser);
      }
    });
    await check('caller ROLLBACK removes an inserted row while its actual nontransactional INSERT witness remains', async () => {
      const row = candidate(), writes = await proof(); await connection.query('BEGIN');
      try { assert.deepEqual(await insert(row),row); } finally { await connection.query('ROLLBACK'); }
      advanced(writes,await proof()); assert.equal((await admin.query('SELECT count(*)::integer AS n FROM public_file_shares WHERE id=$1',[row.id])).rows[0].n,0);
    });
    await check('qualified reads, INSERT and revoke ignore a real TEMP public_file_shares shadow', async () => {
      const row = candidate();
      await transaction(async () => {
        await connection.query(`CREATE TEMP TABLE public_file_shares (LIKE ${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
        await connection.query(`SET LOCAL search_path=pg_temp,"${schema}",pg_catalog`);
        assert.deepEqual(await insert(row),row); assert.deepEqual(await active(row,true),row);
        const revoked = await repository.revokePublicShareOnConnection(database,{table,expected:row,nowMs:1000,reason:'manual'});
        assert(revoked); assert.equal(revoked.status,'revoked'); assert.equal(revoked.revokedReason,'manual');
        assert.equal((await connection.query('SELECT count(*)::integer AS n FROM pg_temp.public_file_shares')).rows[0].n,0);
      });
    });
    for (const reason of ['manual','republished_expired','republished_stale','republished_missing'] as const)
    await check(`finite ${reason} revoke preserves original fields and increments once`, async () => {
      const row = candidate(); await transaction(async () => {
        assert.deepEqual(await insert(row),row);
        const expected = {...row,status:'revoked',policyRevision:row.policyRevision+1,revokedAt:new Date(1000),revokedReason:reason,updatedAt:new Date(1000)};
        assert.deepEqual(await repository.revokePublicShareOnConnection(database,{table,expected:row,nowMs:1000,reason}),expected);
        assert.deepEqual(await read(row),expected);
        assert.equal(await repository.revokePublicShareOnConnection(database,{table,expected:row,nowMs:1000,reason}),null);
      });
    });
    for (const drift of ['document','lineage','generation','token hash','policy revision'] as const)
    await check(`real ${drift} drift makes the original revoke CAS miss without changing its winner`, async () => {
      const row = candidate({documentId:crypto.randomUUID(),lineageId:crypto.randomUUID(),lifecycleGeneration:5});
      await transaction(async () => { assert.deepEqual(await insert(row),row); });
      const column = {'document':'document_id','lineage':'lineage_id','generation':'lifecycle_generation','token hash':'token_hash','policy revision':'policy_revision'}[drift];
      const value = drift === 'generation' ? 6 : drift === 'policy revision' ? row.policyRevision+1 : crypto.randomUUID();
      await admin.query(`UPDATE public_file_shares SET ${column}=$1 WHERE id=$2`,[value,row.id]);
      const before = (await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE id=$1',[row.id])).rows[0].row;
      const writes = await proof(); await transaction(async () => {
        assert.equal(await repository.revokePublicShareOnConnection(database,{table,expected:row,nowMs:1000,reason:'republished_stale'}),null);
      });
      advanced(writes,await proof()); assert.deepEqual((await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE id=$1',[row.id])).rows[0].row,before);
    });
    await check('input values and Date milliseconds are captured before the first SQL await', async () => {
      const row = candidate(), expected = structuredClone(row);
      await transaction(async () => {
        const work = insert(row); row.reason='mutated caller'; row.createdAt.setTime(999); row.workspacePath='mutated.md';
        assert.deepEqual(await work,expected); assert.deepEqual(await read(expected),expected);
      });
    });
    await check('invalid complete-row, identifier, pin, integer and Date values reject before any real DML', async () => {
      const valid = candidate(), writes = await proof(); let getterCalls = 0;
      const getter = {...valid}; Object.defineProperty(getter,'token',{enumerable:true,get:() => { getterCalls++; return valid.token; }});
      for (const row of [{...valid,extra:true},{...valid,token:undefined},{...valid,sizeBytes:'123'},{...valid,accessCount:0.5},
        {...valid,passwordEnabled:2},{...valid,policyRevision:0},{...valid,createdAt:100},{...valid,createdAt:new Date(NaN)},
        {...valid,expiresAt:'100'},{...valid,workspacePath:'../escape.md'},{...valid,id:' trailing '},
        {...valid,documentId:'partial'},{...valid,lifecycleGeneration:5},{...valid,status:{toString:() => 'active'}},getter]) {
        await assert.rejects(insert(row as unknown as PublicShareRow),TypeError);
      }
      assert.equal(getterCalls,0); assert.deepEqual(await proof(),writes);
      await assert.rejects(repository.revokePublicShareOnConnection(database,{table,expected:valid,nowMs:1000,reason:'unexpected' as 'manual'}),TypeError);
      assert.deepEqual(await proof(),writes);
    });
    await check('invalid relation and path selectors reject without executing DML', async () => {
      const row = candidate(), writes = await proof();
      for (const invalid of ['public_file_shares',`"${schema}".other`,`"${schema}".public_file_shares; SELECT 1`]) {
        await assert.rejects(repository.insertPublicShareOnConnection(database,{table:invalid,row}),TypeError);
        await assert.rejects(repository.readActivePublicShareAtPathOnConnection(database,{table:invalid,workspaceId:'repository-space',path:row.workspacePath}),TypeError);
      }
      for (const invalid of [{workspaceId:' repository-space',path:row.workspacePath},{workspaceId:'repository-space',path:'a/../b'},
        {workspaceId:'repository-space',path:row.workspacePath,forUpdate:false}]) {
        await assert.rejects(repository.readActivePublicShareAtPathOnConnection(database,{table,...invalid} as Parameters<typeof repository.readActivePublicShareAtPathOnConnection>[1]),TypeError);
      }
      assert.deepEqual(await proof(),writes);
    });
    await check('actual FK errors are not masked by ON CONFLICT and caller rollback restores B', async () => {
      const row = candidate({createdByUserId:'missing-owner'}), writes = await proof();
      await assert.rejects(transaction(() => insert(row)),error => !!error && typeof error==='object' && Reflect.get(error,'code')==='23503');
      advanced(writes,await proof()); assert.equal((await connection.query('SELECT 42 AS answer')).rows[0].answer,42);
    });
    await check('actual short-code assignment changes only the nullable code and preserves original policy metadata', async () => {
      const row=candidate({shortCode:null}), shortCode=candidate().shortCode!;
      await transaction(async () => {
        assert.deepEqual(await insert(row),row);
        const expected={...row,shortCode};
        assert.deepEqual(await repository.assignPublicShareShortCodeOnConnection(database,{table,expected:row,shortCode,shortCodeConstraints}),
          {kind:'assigned',row:expected});
        assert.deepEqual(await read(row),expected);
      });
    });
    await check('real bound short-code collision disposes its savepoint and leaves the same B usable', async () => {
      const occupied=candidate(), row=candidate({shortCode:null});
      await transaction(async () => { assert.deepEqual(await insert(occupied),occupied); assert.deepEqual(await insert(row),row); });
      const writes=await proof();
      await transaction(async () => {
        const identity=(await connection.query('SELECT pg_current_xact_id()::text AS id,pg_backend_pid() AS backend')).rows[0];
        assert.deepEqual(await repository.assignPublicShareShortCodeOnConnection(database,
          {table,expected:row,shortCode:occupied.shortCode!,shortCodeConstraints}),{kind:'collision'});
        assert.deepEqual((await connection.query('SELECT pg_current_xact_id()::text AS id,pg_backend_pid() AS backend')).rows[0],identity);
        assert.deepEqual(await read(row),row); assert.deepEqual(await read(occupied),occupied);
      });
      advanced(writes,await proof());
    });
    await check('short-code original policy CAS miss returns changed and does not overwrite the winner', async () => {
      const row=candidate({shortCode:null}); await transaction(async () => { assert.deepEqual(await insert(row),row); });
      await transaction(async () => {
        assert.deepEqual(await repository.assignPublicShareShortCodeOnConnection(database,
          {table,expected:{...row,policyRevision:row.policyRevision+1},shortCode:candidate().shortCode!,shortCodeConstraints}),{kind:'changed'});
        assert.deepEqual(await read(row),row);
      });
    });
    for (const failure of ['unrelated token constraint','unrelated trigger 23505'] as const)
    await check(`${failure} is never converted to a short-code collision`, async () => {
      const occupied=candidate(), row=candidate({shortCode:null});
      await transaction(async () => { assert.deepEqual(await insert(occupied),occupied); assert.deepEqual(await insert(row),row); });
      await admin.query(`CREATE FUNCTION fixture_short_code_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id='${row.id}' THEN ${failure==='unrelated token constraint'
          ? `SELECT token INTO NEW.token FROM ${table} WHERE id='${occupied.id}';`
          : "RAISE EXCEPTION 'Owned unrelated trigger rejection' USING ERRCODE='23505',CONSTRAINT='fixture_unrelated_unique';"}
        END IF; RETURN NEW; END $$`);
      await admin.query('CREATE TRIGGER fixture_short_code_failure BEFORE UPDATE ON public_file_shares FOR EACH ROW EXECUTE FUNCTION fixture_short_code_failure()');
      const writes=await proof();
      try {
        await assert.rejects(transaction(() => repository.assignPublicShareShortCodeOnConnection(database,
          {table,expected:row,shortCode:candidate().shortCode!,shortCodeConstraints})),error => {
          assert(error && typeof error==='object'); assert.equal(Reflect.get(error,'code'),'23505');
          assert.equal(shortCodeConstraints.includes(Reflect.get(error,'constraint')),false); return true;
        });
        advanced(writes,await proof()); assert.deepEqual(await read(row),row); assert.deepEqual(await read(occupied),occupied);
      } finally {
        await admin.query('DROP TRIGGER fixture_short_code_failure ON public_file_shares'); await admin.query('DROP FUNCTION fixture_short_code_failure()');
      }
    });
    await check('lost ACK after actual short-code RELEASE cannot publish assigned and caller rollback restores the row', async () => {
      const row=candidate({shortCode:null}); await transaction(async () => { assert.deepEqual(await insert(row),row); });
      const lost=new Error('Owned short-code release reply lost after actual completion.'); let releases=0;
      const transport:SqlConnection={...database,run:async (sql,values) => {
        const result=await database.run(sql,values);
        if (sql==='RELEASE SAVEPOINT canvas_public_short_code_allocation') { releases++; throw lost; } return result;
      }};
      await assert.rejects(transaction(() => repository.assignPublicShareShortCodeOnConnection(transport,
        {table,expected:row,shortCode:candidate().shortCode!,shortCodeConstraints})),error => error===lost);
      assert.equal(releases,1); assert.deepEqual(await read(row),row);
    });
    await check('lost ACK after actual collision ROLLBACK TO never becomes retryable collision', async () => {
      const occupied=candidate(), row=candidate({shortCode:null});
      await transaction(async () => { assert.deepEqual(await insert(occupied),occupied); assert.deepEqual(await insert(row),row); });
      const lost=new Error('Owned short-code rollback reply lost after actual completion.'); let rollbacks=0,releases=0;
      const transport:SqlConnection={...database,run:async (sql,values) => {
        const result=await database.run(sql,values);
        if (sql==='ROLLBACK TO SAVEPOINT canvas_public_short_code_allocation') { rollbacks++; throw lost; }
        if (sql==='RELEASE SAVEPOINT canvas_public_short_code_allocation') releases++; return result;
      }};
      await assert.rejects(transaction(() => repository.assignPublicShareShortCodeOnConnection(transport,
        {table,expected:row,shortCode:occupied.shortCode!,shortCodeConstraints})),error => {
        assert(error instanceof AggregateError); assert(error.errors.includes(lost));
        assert(error.errors.some(item => item && typeof item==='object' && Reflect.get(item,'code')==='23505')); return true;
      });
      assert.equal(rollbacks,1); assert.equal(releases,1); assert.deepEqual(await read(row),row); assert.deepEqual(await read(occupied),occupied);
    });
    await check('concurrent DROP invalidates the owned active-path index but preserves INSERT uniqueness until the original B ends', async () => {
      // PG18 README.HOT, DROP INDEX CONCURRENTLY: invalid comes first;
      // ready/live and index updates remain until pre-existing users finish.
      // https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/access/heap/README.HOT
      const writer=await ownClient(), peer=await ownClient(), index=`"${schema}".idx_public_file_shares_active_path`;
      let bOpen=false, drop:Promise<unknown>|undefined, dropTerminal:{error?:unknown}|undefined, failure:{error:unknown}|undefined;
      const indexState=async (client=admin) => (await client.query(`SELECT i.indexrelid::bigint AS oid,i.indrelid::bigint AS table_oid,
        c.relnamespace::bigint AS namespace,c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner,
        i.indisunique,i.indisvalid,i.indisready,i.indislive
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE i.indexrelid=to_regclass($1) AND i.indrelid=to_regclass($2)`,[index,table])).rows[0];
      try {
        await own(); await writer.query('BEGIN'); bOpen=true;
        await writer.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
        const before=await indexState(writer); assert(before);
        const indexOid=Number(before.oid), tableOid=Number(before.table_oid);
        assert(Number.isSafeInteger(indexOid) && indexOid>0); assert(Number.isSafeInteger(tableOid) && tableOid>0);
        assert.equal(Number(before.namespace),schemaOid); assert.equal(before.owner,true);
        for (const key of ['indisunique','indisvalid','indisready','indislive']) assert.equal(before[key],true);
        const writerPid=Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const peerPid=Number((await peer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        assert.equal((await admin.query("SELECT state='idle' AND xact_start IS NULL AS autocommit FROM pg_stat_activity WHERE pid=$1",[peerPid])).rows[0].autocommit,true);
        drop=peer.query(`DROP INDEX CONCURRENTLY ${index}`);
        void drop.then(() => { dropTerminal={}; },error => { dropTerminal={error}; });
        const deadline=Date.now()+3000; let observed=false;
        while (!observed) {
          assert.equal(dropTerminal,undefined,'The concurrent DROP ended before the required invalid-but-ready wait was observed.');
          const current=await indexState();
          const wait=(await admin.query(`SELECT state='active' AND wait_event_type='Lock' AS waiting,
            $1::integer=ANY(pg_blocking_pids(pid)) AS blocked_by_b FROM pg_stat_activity WHERE pid=$2`,[writerPid,peerPid])).rows[0];
          observed=!!current && Number(current.oid)===indexOid && Number(current.table_oid)===tableOid
            && current.indisvalid===false && current.indisready===true && current.indislive===true
            && wait?.waiting===true && wait.blocked_by_b===true;
          if (!observed) {
            assert(Date.now()<deadline,'The actual owned concurrent DROP never exposed invalid/ready/live plus its B lock wait.');
            await new Promise(resolve => setTimeout(resolve,10));
          }
        }
        const row=candidate(), duplicate=candidate({workspacePath:row.workspacePath}), writes=await proof(), on=borrowed(writer);
        assert.deepEqual(await insert(row,on),row); assert.equal(await insert(duplicate,on),null);
        advanced(writes,await proof(),2); assert.deepEqual(await active(row,true,on),row);
        const during=await indexState(); assert(during); assert.equal(Number(during.oid),indexOid);
        assert.equal(during.indisvalid,false); assert.equal(during.indisready,true); assert.equal(during.indislive,true);
        assert.equal(dropTerminal,undefined);
        await writer.query('COMMIT'); bOpen=false; await drop;
        assert(dropTerminal && !Object.hasOwn(dropTerminal,'error'));
        assert.equal(await indexState(),undefined);
        assert.equal((await admin.query('SELECT to_regclass($1) IS NULL AS absent',[index])).rows[0].absent,true);
        const {PUBLIC_SHARE_UNIQUENESS_STATEMENTS}=await import('../app/lib/db/public-share-migration');
        await own(); await admin.query(PUBLIC_SHARE_UNIQUENESS_STATEMENTS[1]); await own();
        const restored=await indexState(); assert(restored); assert.notEqual(Number(restored.oid),indexOid);
        assert.equal(Number(restored.table_oid),tableOid); assert.equal(Number(restored.namespace),schemaOid); assert.equal(restored.owner,true);
        for (const key of ['indisunique','indisvalid','indisready','indislive']) assert.equal(restored[key],true);
        console.log('Public share concurrent DROP witness:',JSON.stringify({invalidReadyLiveObserved:observed,peerWaitedForB:true,
          actualInsertAttempts:2,duplicateSuppressed:true,dropFinishedAfterB:true,ownedIndexRestored:true}));
      } catch (error) { failure={error}; }
      finally {
        const cleanupErrors:unknown[]=[];
        const finish=async (operation:()=>Promise<unknown>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
        await finish(async () => { if (bOpen) await writer.query('ROLLBACK'); });
        await finish(() => endClient(writer));
        // A failed observation remains a failed case. Closing only this owned
        // peer also terminates a still-waiting DROP before draining its Promise;
        // the outer identity-checked schema cleanup handles invalid leftovers.
        await finish(() => endClient(peer));
        if (drop) await finish(async () => { await drop; });
        if (cleanupErrors.length) failure={error:new AggregateError([...(failure ? [failure.error] : []),...cleanupErrors],
          'Owned concurrent index DROP cleanup failed.')};
      }
      if (failure) throw failure.error;
    });
    assert.equal(passed,37); assert.equal(repositoryCloses,0); assert.equal(repositoryTransactionCommands,0); assert.equal(fetches,0);
    await own(); assert.deepEqual(await sourceHashes(),sources); assert.equal(timedOut,false);
    console.log('Public share repository SQL assertions complete:', JSON.stringify({passed,repositoryCloses,repositoryTransactionCommands,fetches}));
  } catch (error) { primary={error}; }
  finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    for (const client of clients) await cleanup(() => endClient(client));
    if (created && clients.size===0 && cleanupErrors.length===0) await cleanup(async () => {
      const record = (await control.query(`SELECT oid,obj_description(oid,'pg_namespace') AS nonce,
        nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`,[schema])).rows[0];
      assert(record); assert.equal(Number(record.oid),schemaOid); assert.equal(record.nonce,nonce); assert.equal(record.owner,true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved=(await control.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows[0].removed===true; assert(schemaRemoved);
    });
    await cleanup(() => control.end());
    await cleanup(async () => {
      const current=await stat(dataRoot); assert.equal(current.dev,rootIdentity.dev); assert.equal(current.ino,rootIdentity.ino); assert.equal(current.uid,rootIdentity.uid);
      await rm(dataRoot,{recursive:true}); await assert.rejects(stat(dataRoot),error => !!error && typeof error==='object' && Reflect.get(error,'code')==='ENOENT'); dataRemoved=true;
    });
    await cleanup(async () => { assert.deepEqual(await sourceHashes(),sources); });
    globalThis.fetch=originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env,environment);
    clearTimeout(watchdog);
    console.log('Public share repository owned cleanup:',JSON.stringify({schemaRemoved,dataRemoved,openClients:clients.size,passed}));
    if (cleanupErrors.length) primary={error:new AggregateError([...(primary ? [primary.error] : []),...cleanupErrors],'Owned repository fixture cleanup failed.')};
  }
  if (primary) throw primary.error;
  assert(schemaRemoved); assert(dataRemoved); assert.equal(timedOut,false); complete=true;
  console.log('Public share repository PostgreSQL18 finished:',JSON.stringify({passed,schemaRemoved,dataRemoved}));
}
main().catch(error => {
  console.error('Owned public share repository fixture failed:',{stage,passed,name:error instanceof Error ? error.name : 'unknown',
    code:error && typeof error==='object' ? Reflect.get(error,'code') ?? null : null}); process.exitCode=1;
});
