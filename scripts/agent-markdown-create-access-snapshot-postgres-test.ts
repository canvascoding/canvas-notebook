import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Genuine PI originals, held PostgreSQL transactions, current raw SQL decisions
// and same-B changes. No query/auth/permission result is replaced or synthesized.
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
await withNativeCopyMetadataOwnerFixture(async h => {
  const { openDb } = await import('../app/lib/db');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
  const { getAgentAccessOnConnection } = await import('../app/lib/agents/access');
  const principal = await import('../app/lib/workspaces/request-principal');
  const agentId = 'current-access-snapshot-agent';
  await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
    VALUES($1,'Current access snapshot','special','restricted','organization','principal-org','["write"]',100,100)`, [agentId]);
  await h.admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,can_edit,can_manage,created_at,updated_at)
    VALUES($1,'principal-org','owner','active',1,0,0,100,100)`, [agentId]);
  await h.admin.query(`INSERT INTO canvas_projects(id,organization_id,name,slug,status,created_at,updated_at)
    VALUES('access-project','principal-org','Access project','access-project','active',100,100)`);
  for (const [id, type, projectId] of [['access-personal', 'personal', null], ['access-project-space', 'project', 'access-project']] as const) {
    const relative = `workspaces/${id}/files`;
    await mkdir(path.join(h.dataRoot, relative), { recursive: true });
    await h.admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,project_id,root_relative_path,display_name,status,created_at,updated_at)
      VALUES($1,'principal-org',$2,$3,$4,$5,$1,'active',100,100)`, [id, type, type === 'personal' ? 'owner' : null, projectId, relative]);
  }
  const workspaceIds = [h.source.workspaceId, 'access-personal', 'access-project-space'];
  for (const workspaceId of workspaceIds) await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,
    workspace_id,workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
    SELECT $1,'owner',$2,'fixture','fixture',w.organization_id,w.id,w.type,w.display_name,w.root_relative_path,100,100
    FROM canvas_workspaces w WHERE w.id=$3`, [`access-${workspaceId}`, agentId, workspaceId]);
  await h.upload('kept-access-source.md', Buffer.from('# Kept access source\n\nOriginal bytes remain.\n'));
  const sourceFile = path.join(h.source.rootPath, 'kept-access-source.md');
  const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const observe = async () => {
    const rows = (await h.admin.query(`SELECT 'agent' AS kind,agent_id AS key,to_jsonb(a) AS value,xmin::text AS version FROM agents a
      UNION ALL SELECT 'member',agent_id||':'||user_id,to_jsonb(m),xmin::text FROM agent_members m
      UNION ALL SELECT 'grant',id,to_jsonb(g),xmin::text FROM agent_grants g
      UNION ALL SELECT 'permission',organization_id||':'||user_id,to_jsonb(p),xmin::text FROM organization_user_permissions p
      UNION ALL SELECT 'workspace',id,to_jsonb(w),xmin::text FROM canvas_workspaces w
      UNION ALL SELECT 'project',id,to_jsonb(p),xmin::text FROM canvas_projects p
      UNION ALL SELECT 'document',id,to_jsonb(d),xmin::text FROM collaboration_documents d
      UNION ALL SELECT 'lineage',id,to_jsonb(l),xmin::text FROM file_collaboration_lineages l
      UNION ALL SELECT 'native',document_id,to_jsonb(s),xmin::text FROM collaboration_yjs_states s
      UNION ALL SELECT 'metadata',workspace_id||':'||path,to_jsonb(m),xmin::text FROM workspace_file_metadata m
      ORDER BY kind,key`)).rows;
    const columns = (await h.admin.query(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname=$1 AND c.relname IN ('agents','agent_members','agent_grants') AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`, [h.schema])).rows;
    return digest({ rows, columns, bytes: await readFile(sourceFile) });
  };
  type Change = (database: SqlConnection, workspaceId: string) => Promise<void>;
  const member = (value: number): Change => async database => {
    await database.run('UPDATE agent_members SET can_use=$2 WHERE agent_id=$1', [agentId, value]);
  };
  const grant = (targetType: string, targetId: (workspaceId: string) => string, use = 1, edit = 0): Change => async (database, workspaceId) => {
    await member(0)(database, workspaceId);
    await database.run(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,can_edit,can_manage,created_at,updated_at)
      VALUES('access-current-grant',$1,'principal-org',$2,$3,$4,$5,0,100,100)`, [agentId, targetType, targetId(workspaceId), use, edit]);
  };
  const numeric = (kind: 'member' | 'grant', value: string, domain: boolean): Change => async (database, workspaceId) => {
    const table = kind === 'member' ? 'agent_members' : 'agent_grants';
    if (kind === 'grant') await grant('workspace', id => id)(database, workspaceId);
    if (domain) await database.run('CREATE DOMAIN access_snapshot_numeric AS numeric');
    const type = domain ? 'access_snapshot_numeric' : 'numeric';
    await database.run(`ALTER TABLE ${table} ALTER COLUMN can_use TYPE ${type} USING can_use::numeric`);
    await database.run(`UPDATE ${table} SET can_use=$2::numeric WHERE agent_id=$1`, [agentId, value]);
  };
  const cases: Array<{ name: string; allow: boolean; change: Change; workspaceId: string; afterScope?: Change }> = [];
  for (const workspaceId of workspaceIds) {
    const selected: Array<[string, boolean, Change]> = [
      ['control', true, async () => undefined],
      ['member-revoked', false, member(0)],
      ['member-archived', false, async database => { await database.run("UPDATE agent_members SET status='archived' WHERE agent_id=$1", [agentId]); }],
      ['member-removed', false, async database => { await database.run('DELETE FROM agent_members WHERE agent_id=$1', [agentId]); }],
      ['organization-grant', true, grant('organization', () => 'principal-org')],
      ['role-grant', true, grant('role', () => 'owner')],
      ['user-grant', true, grant('user', () => 'owner')],
      ['workspace-grant', true, grant('workspace', id => id)],
      ['wrong-workspace-grant', false, grant('workspace', () => 'other-workspace')],
      ['wrong-user-grant', false, grant('user', () => 'other-user')],
      ['edit-only-grant', false, grant('workspace', id => id, 0, 1)],
      ['numeric-member-one', true, numeric('member', '1', false)],
      ['numeric-member-rounded-above', false, numeric('member', '1.00000000000000000000000000001', false)],
      ['numeric-grant-one', true, numeric('grant', '1', false)],
      ['numeric-grant-rounded-below', false, numeric('grant', '0.99999999999999999999999999999', false)],
      ['domain-member-one', true, numeric('member', '1', true)],
      ['domain-member-rounded-above', false, numeric('member', '1.00000000000000000000000000001', true)],
      ['domain-grant-one', true, numeric('grant', '1', true)],
      ['domain-grant-rounded-below', false, numeric('grant', '0.99999999999999999999999999999', true)],
    ];
    if (workspaceId === 'access-personal') selected.push(['external-organization-own-personal', true, async database => {
      await database.run("UPDATE organization_user_permissions SET role='external' WHERE organization_id='principal-org' AND user_id='owner'");
    }]);
    if (workspaceId === 'access-project-space') {
      selected.push(['project-grant', true, grant('project', () => 'access-project')]);
      selected.push(['wrong-project-grant', false, grant('project', () => 'other-project')]);
      selected.push(['project-archived', false, async database => { await database.run("UPDATE canvas_projects SET status='archived' WHERE id='access-project'"); }]);
    }
    cases.push(...selected.map(([name, allow, change]) => ({ name, allow, change, workspaceId })));
  }
  cases.push({ name: 'temporary-member-shadow', allow: false, workspaceId: h.source.workspaceId, change: async database => {
    await database.run(`ALTER TABLE "${h.schema}".agent_members RENAME TO access_original_members`);
    await database.run(`CREATE TEMP TABLE agent_members (LIKE "${h.schema}".access_original_members INCLUDING DEFAULTS)`);
    await database.run(`INSERT INTO pg_temp.agent_members SELECT * FROM "${h.schema}".access_original_members`);
    await member(0)(database, h.source.workspaceId);
  } });
  cases.push({ name: 'temporary-grant-shadow', allow: false, workspaceId: h.source.workspaceId, change: async database => {
    await grant('workspace', id => id)(database, h.source.workspaceId);
    await database.run(`ALTER TABLE "${h.schema}".agent_grants RENAME TO access_original_grants`);
    await database.run(`CREATE TEMP TABLE agent_grants (LIKE "${h.schema}".access_original_grants INCLUDING DEFAULTS)`);
  } });
  const lateCases: Array<[string, string, Change]> = [
    ['after-scope-member-revoked', h.source.workspaceId, member(0)],
    ['after-scope-member-archived', h.source.workspaceId, async database => {
      await database.run("UPDATE agent_members SET status='archived' WHERE agent_id=$1", [agentId]);
    }],
    ['after-scope-account-banned', h.source.workspaceId, async database => {
      await database.run('UPDATE "user" SET banned=1 WHERE id=$1', ['owner']);
    }],
    ['after-scope-organization-external', h.source.workspaceId, async database => {
      await database.run("UPDATE organization_user_permissions SET role='external' WHERE organization_id='principal-org' AND user_id='owner'");
    }],
    ['after-scope-project-archived', 'access-project-space', async database => {
      await database.run("UPDATE canvas_projects SET status='archived' WHERE id='access-project'");
    }],
    ['after-scope-personal-role-external', 'access-personal', async database => {
      await database.run('UPDATE "user" SET role=$1 WHERE id=$2', ['external', 'owner']);
    }],
  ];
  cases.push(...lateCases.map(([name, workspaceId, afterScope]) => ({ name, workspaceId, afterScope,
    allow: false, change: async () => undefined })));
  cases.push({ name: 'after-scope-grant-revoked', workspaceId: h.source.workspaceId, allow: false,
    change: grant('workspace', id => id), afterScope: async database => {
      await database.run('UPDATE agent_grants SET can_use=0 WHERE agent_id=$1', [agentId]);
    } });
  cases.push({ name: 'after-scope-grant-numeric-rounded-above', workspaceId: h.source.workspaceId, allow: false,
    change: async () => undefined, afterScope: numeric('grant', '1.00000000000000000000000000001', false) });
  cases.push({ name: 'after-scope-domain-member-one', workspaceId: h.source.workspaceId, allow: true,
    change: async () => undefined, afterScope: numeric('member', '1', true) });
  let groups = 0;
  for (const scenario of cases) {
    const before = await observe();
    const actual = await resolveAgentExecutionContextForStoredSession({ userId: 'owner', agentId,
      sessionId: `access-${scenario.workspaceId}`, permissions: ['canRead', 'canRunAgent', 'canWrite'] });
    const rollback = new Error('Rollback the owned access fixture after a successful current check.');
    let entered = false, checked = false, rawAllowed: boolean | undefined, denial: unknown, outcome: unknown;
    let armed = false, postScopeChanges = 0, heldDatabase: SqlConnection | undefined;
    try {
      await h.withProbe(async event => {
        if (!armed) return;
        const row = event.result.rows?.[0];
        if (!row || !Array.isArray(row.sessions) || !Object.hasOwn(row, 'workspace')
          || !Object.hasOwn(row, 'profile') || !Object.hasOwn(row, 'seat')) return;
        armed = false; postScopeChanges++;
        assert(heldDatabase && scenario.afterScope);
        // Actual SQL on the original held B after its actual scope reply. The
        // query arguments, rows and return value themselves stay untouched.
        await scenario.afterScope(heldDatabase, scenario.workspaceId);
      }, () => runWithAgentExecutionContext(actual, () => withAgentToolInvocation(actual,
        { toolName: 'write', toolCallId: `access-${groups}` }, () => principal.withWorkspaceAgentMarkdownCreatePrincipalOriginalOrigin(
          { workspaceId: scenario.workspaceId }, () => undefined, p => executeLifecycleTransaction({ openConnection: openDb,
            execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
              return principal.withWorkspaceAgentMarkdownCreatePrincipalOnConnection(database, p, async access => {
                entered = true; heldDatabase = database;
                await scenario.change(database, scenario.workspaceId);
                // The real ordinary resolver observes the same modified B; it
                // does not supply any result to the Create Principal.
                rawAllowed = (await getAgentAccessOnConnection(database, 'owner', agentId, {
                  organizationId: access.workspace.organizationId, workspaceId: access.workspace.workspaceId,
                  projectId: access.workspace.projectId,
                })).canUse;
                armed = Boolean(scenario.afterScope);
                try { await access.assertCurrent(); checked = true; }
                catch (error) { denial = error; throw error; }
                throw rollback;
              });
            }, recoverCommitted: async () => { throw new Error('No access fixture mutation may commit.'); },
          })))));
    } catch (error) { outcome = error; }
    const label = `${scenario.workspaceId}/${scenario.name}`;
    assert(entered, label + ': genuine Create phase must enter before the change; failure code: '
      + String(outcome && typeof outcome === 'object' ? Reflect.get(outcome, 'code') ?? Reflect.get(outcome, 'name') : typeof outcome));
    assert(rawAllowed !== undefined, label + ': injection/raw query must finish before Current; failure code: '
      + String(outcome && typeof outcome === 'object' ? Reflect.get(outcome, 'code') ?? Reflect.get(outcome, 'name') : typeof outcome));
    assert.equal(rawAllowed, scenario.afterScope ? true : scenario.allow, label + ': original raw SQL policy before any late change.');
    assert.equal(postScopeChanges, scenario.afterScope ? 1 : 0, label + ': exactly the intended genuine post-reply change.');
    assert.equal(checked, scenario.allow, label + ': fresh Create policy.');
    if (scenario.allow) assert(outcome === rollback, label + ': successful controls still roll back their real mutations.');
    else assert(denial && outcome === denial, label + ': the actual denial must escape the transaction.');
    assert.equal(await observe(), before, label + ': original rows/xmin, scalar types and native/physical source stay unchanged.');
    groups++;
    console.log('PASS Agent Create access snapshot:', label);
  }
  assert.equal(groups, 72);
  console.log(JSON.stringify({ suite: 'agent-markdown-create-access-snapshot', groups, passed: true,
    realPostgresAndPi: true, sameBRevocation: true, exactNumericAndDomainPolicy: true,
    temporaryShadowPreserved: true, originalRowsAndBytesUnchanged: true }));
});
completed = true;
