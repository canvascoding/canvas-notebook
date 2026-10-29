import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { PoolClient } from 'pg';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// A genuine schema proof precedes real settings-file IO. Fresh facts follow
// that IO; positive SQL and file replies are never replaced.
async function directMcpRuntimeSnapshotPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async h => {
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const principal = await import('../app/lib/mcp/server/document-read-principal');
    const { setDirectMcpServerPreferences } = await import('../app/lib/server-settings');
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string;
    assert.match(schema,/^[a-z0-9_]+$/u);
    const tools = ['read_knowledge_source','search_knowledge','create_knowledge_source','import_knowledge_file','edit_knowledge_source'];
    await setDirectMcpServerPreferences('reader',{ enabled:true,tools });
    process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE = 'settings'; process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE = 'settings';
    const preferencesPath = serverPreferencesPath(), originalPreferences = await fs.readFile(preferencesPath);
    await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
    await h.admin.query("UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'",
      [JSON.stringify(['knowledge:read','knowledge:search','knowledge:write']),h.clientId]);
    const token = await h.issue({ scope:'knowledge:read knowledge:search knowledge:write' });
    await h.seed({ filePath:'runtime/original.md',text:'# Original runtime source\n' });
    const tables = ['user','session','canvas_organization_settings','organization_user_permissions','team_memberships',
      'team_membership_sync_state','canvas_workspaces','canvas_projects','canvas_workspace_members','canvas_project_members',
      'oauth_client','oauth_consent','mcp_revoked_access_token','mcp_direct_grant_revocation',
      'mcp_direct_workspace_setting','mcp_direct_workspace_grant'];
    const snapshot = async () => {
      const authority:Record<string,unknown> = {};
      for (const name of tables) authority[name] = (await h.admin.query(`SELECT to_jsonb(r) AS value,r.xmin::text AS xmin
        FROM "${schema}"."${name}" r ORDER BY to_jsonb(r)::text,r.xmin::text`)).rows;
      const columns = (await h.admin.query(`SELECT c.relname,a.attname,a.atttypid,a.atttypmod FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname,a.attname`,[schema,tables])).rows;
      return { authority,columns,native:await h.snapshot() };
    };
    type Fault = 'control' | 'account-during-io' | 'realm-during-io' | 'disabled-unsupported';
    type Window = { client:PoolClient; measure:boolean; fault:Fault; sql:number; facts:number; schemas:number; io:number;
      injected:boolean; events:string[] };
    let live:Window | undefined;
    const fsModule = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
    const originalRead = fsModule.readFile;
    fsModule.readFile = (async (...args:Parameters<typeof originalRead>) => {
      const window = live;
      if (!window?.measure || typeof args[0] !== 'string' || path.resolve(args[0]) !== path.resolve(preferencesPath)) {
        return Reflect.apply(originalRead,fsModule,args);
      }
      assert(window.schemas > 0,'A genuine schema proof must precede runtime IO.');
      window.io++; window.events.push('runtime:start');
      const bytes = await Reflect.apply(originalRead,fsModule,args);
      if (window.fault === 'account-during-io') {
        assert.equal((await window.client.query("UPDATE \"user\" SET banned=1 WHERE id='reader'")).rowCount,1); window.injected = true;
      }
      if (window.fault === 'realm-during-io') {
        await window.client.query(`SET LOCAL search_path=pg_catalog,"${schema}",pg_temp`); window.injected = true;
      }
      window.events.push('runtime:end'); return bytes;
    }) as typeof originalRead;
    syncBuiltinESMExports(); let groups = 0, denials = 0, controls = 0;
    const controlSql = new Set<number>();
    try {
      for (const mode of ['prepared','fallback'] as const) for (const kind of ['read','create','edit'] as const)
        for (const fault of ['control','account-during-io','realm-during-io','disabled-unsupported'] as const) {
          const before = await snapshot(); let checked = false, failure:unknown, seen:Window | undefined;
          const operation = async (p:unknown) => {
            const client = await pool.connect(); let began = false, discard:Error | undefined;
            const window:Window = { client,measure:false,fault,sql:0,facts:0,schemas:0,io:0,injected:false,events:[] }; live = seen = window;
            const read = async (text:string,values?:unknown[],prepared = false) => {
              if (window.measure) window.sql++;
              const row = (await (prepared ? client.query({ name:'actual_mcp_runtime_snapshot',text,values }) : client.query(text,values))).rows[0];
              const data = row?.facts ?? row;
              if (window.measure && Array.isArray(data?.schema_relations)) {
                window.schemas++;
                if (data.raw_id === 'reader') { window.facts++; window.events.push(`facts:${window.facts}`); }
                else window.events.push('schema');
              }
              return row;
            };
            const db:SqlConnection = {
              get:(text,values) => read(text,values),
              ...(mode === 'prepared' ? { getPrepared:(text:string,values?:unknown[]) => read(text,values,true) } : {}),
              all:async (text,values) => { if (window.measure) window.sql++; return (await client.query(text,values)).rows; },
              run:async (text,values) => { if (window.measure) window.sql++; return { changes:(await client.query(text,values)).rowCount ?? 0 }; },
              close:() => assert.fail('Caller B remains owned by the actual fixture.'),
            };
            try {
              await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
              const callback = async (access:{ assertCurrent:()=>Promise<void>; assertActive?:()=>void }) => {
                if (fault === 'disabled-unsupported') {
                  await client.query('CREATE DOMAIN runtime_unsupported_flag AS numeric');
                  await client.query('ALTER TABLE oauth_client ALTER COLUMN disabled TYPE runtime_unsupported_flag USING disabled::numeric');
                  await setDirectMcpServerPreferences('reader',{ enabled:false,tools }); window.injected = true;
                }
                window.measure = true;
                try { await access.assertCurrent(); } finally { window.measure = false; }
                checked = true; assert.equal(fault,'control');
                assert(window.sql >= 2 && window.sql <= 3); assert.equal(window.facts,2);
                assert(window.events.indexOf('runtime:start') > 0);
                assert(window.events.indexOf('facts:2') > window.events.indexOf('runtime:end'));
                controlSql.add(window.sql);
                if (kind === 'edit') { assert.equal(typeof access.assertActive,'function'); access.assertActive!(); }
                return 'runtime-current';
              };
              const value = kind === 'read'
                ? await principal.withDirectMcpDocumentReadPrincipalOnConnection(db,p as Parameters<typeof principal.withDirectMcpDocumentReadPrincipalOnConnection>[1],callback)
                : kind === 'create'
                  ? await principal.withDirectMcpDocumentCreatePrincipalOnConnection(db,p as Parameters<typeof principal.withDirectMcpDocumentCreatePrincipalOnConnection>[1],callback)
                  : await principal.withDirectMcpDocumentEditPrincipalOnConnection(db,p as Parameters<typeof principal.withDirectMcpDocumentEditPrincipalOnConnection>[1],callback);
              return value;
            } finally {
              window.measure = false;
              if (began) try { await client.query('ROLLBACK'); } catch (error) { discard = new Error('Runtime snapshot rollback failed.',{ cause:error }); }
              client.release(discard); if (discard) throw discard; live = undefined;
            }
          };
          try {
            const auth = { token,clientId:'untrusted-ignored-client',scopes:[] };
            if (kind === 'read') await principal.withDirectMcpDocumentReadPrincipal(auth,{ workspaceId:h.workspaceId,purpose:'read' },()=>undefined,operation);
            else if (kind === 'create') await principal.withDirectMcpDocumentCreatePrincipal(auth,{ workspaceId:h.workspaceId,tool:'create_knowledge_source' },()=>undefined,operation);
            else await principal.withDirectMcpDocumentEditPrincipal(auth,{ workspaceId:h.workspaceId },()=>undefined,operation);
          } catch (error) { failure = error; }
          finally { await fs.writeFile(preferencesPath,originalPreferences,{ mode:0o600 }); }
          assert(seen); assert.equal(seen.io,1);
          if (fault === 'control') { if (failure) throw failure; assert(checked && !seen.injected); controls++; }
          else {
            assert(seen.injected && !checked); const code = failure && typeof failure === 'object' ? Reflect.get(failure,'code') : undefined;
            assert.equal(code,fault === 'account-during-io' ? 'invalid_token'
              : fault === 'realm-during-io' ? 'MCP_READ_PRINCIPAL_SCOPE_CHANGED' : 'MCP_READ_PRINCIPAL_ACCESS_DENIED');
            assert.equal(seen.sql,fault === 'disabled-unsupported' ? 1 : 2); denials++;
          }
          assert.deepEqual(await snapshot(),before); assert.deepEqual(await fs.readFile(preferencesPath),originalPreferences);
          console.log('MCP_RUNTIME_SNAPSHOT_CASE',JSON.stringify({ mode,kind,fault,sql:seen.sql,events:seen.events })); groups++;
        }
      assert.equal(groups,24); assert.equal(controls,6); assert.equal(denials,18); assert.equal(controlSql.size,1);
      console.log('MCP_RUNTIME_SNAPSHOT_PROOF',JSON.stringify({ groups,controls,denials,currentSql:[...controlSql][0],realSettingsReads:24,
        actualSameBackendRevocationsAndRealmChanges:true,disabledRuntimePrecedesUnsupportedData:true,
        originalReplies:true,authorityNativeRowsXminAndColumnTypesAndConfigBytesRetained:true }));
    } finally { fsModule.readFile = originalRead; syncBuiltinESMExports(); }
  });
}
await directMcpRuntimeSnapshotPostgresTest();
