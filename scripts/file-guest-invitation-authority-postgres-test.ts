import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import type { FileGuestInvitationAuthority } from '../app/lib/workspaces/request-principal';

type Row = Record<string, unknown>;
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `guest_invitation_authority_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^guest_invitation_authority_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-guest-invitation-authority-'));
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  let admin: Client | undefined, created = false, cases = 0;
  let closeRuntime: (() => Promise<void>) | undefined;
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, {
      DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
      CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`, BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
      CANVAS_COLLABORATION_TICKET_SECRET: crypto.randomBytes(32).toString('hex'),
      BETTER_AUTH_BASE_URL: 'http://localhost', BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'redemption-org', CANVAS_DEPLOYMENT_MODE: 'team',
      CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production',
      CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test',
    });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.NEXT_PHASE;
    delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY; delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = {
      protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'redemption-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'redemption-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true },
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('No external issuer or email is permitted in the owned Guest fixture.'); };
    admin = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=guest-invitation-authority-fixture` });
    admin.on('error', () => undefined); await admin.connect();
    const fixture = admin;
    stage = 'actual original owned-schema global DDL';
    console.log('Owned Guest invitation authority fixture:', JSON.stringify({ pid: process.pid, schema, dataRoot }));
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      const before = (await fixture.query("SELECT current_schema() AS name,current_setting('search_path') AS path")).rows[0];
      assert.equal(before.name, schema); assert.deepEqual(before.path.split(',').map((part: string) => part.trim()), [schema, 'pg_catalog']);
      const result = await fixture.query(sql, values);
      assert.equal((await fixture.query('SELECT current_schema() AS name')).rows[0].name, schema);
      return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const now = Date.now();
    await fixture.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@redemption.test',1,'admin',0,$1,$1)`, [now]);
    await fixture.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('redemption-org','owner','team',1,100,100)`);
    await fixture.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('redemption-org','owner','owner','active',1,1,100,100)`);
    await fixture.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','redemption-org','owner@redemption.test','owner','owner','active',100,100,100,100)`);
    await fixture.query(`INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('redemption-org',100,100)`);
    await fixture.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('redemption-space','redemption-org','organization','Redemption','organizations/redemption-org/shared','active',100,100)`);
    const database = await import('../app/lib/db');
    closeRuntime = database.closeDatabaseConnections;
    const runtime = database.getPostgresRuntimeQueryable(); assert(runtime);
    assert.equal((await runtime.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const { requireTeamRuntimeLicense } = await import('../app/lib/license/entitlements');
    const verifiedLicense = await requireTeamRuntimeLicense();
    assert.equal(verifiedLicense.licensed, true); assert.equal(verifiedLicense.edition, 'team');
    assert.equal(verifiedLicense.databaseProvider, 'postgres'); assert.equal(verifiedLicense.capabilities.multiUser, true);
    assert.equal(verifiedLicense.capabilities.teamWorkspace, true); assert.equal(verifiedLicense.seatLimit, 2);
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const workspace = await readPostgresWorkspaceForActor({ userId: 'owner', role: 'admin' }, 'redemption-space');
    assert(workspace); assert.equal(workspace.workspaceId, 'redemption-space');
    const workspaceRootRelativePath = workspace.rootRelativePath;
    assert(workspaceRootRelativePath === 'organizations/redemption-org/shared');
    assert.equal(workspace.permissions.canCreatePublicLinks, true); assert.equal(workspace.permissions.canWrite, true);
    assert(workspace.rootPath.startsWith(`${dataRoot}${path.sep}`)); await mkdir(workspace.rootPath, { recursive: true });
    const { withFileGuestInvitationAuthority: capture,withFileGuestInvitationAuthorityOnConnection: phase,
      withWorkspaceRequestPrincipalOnConnection: memberPhase } = await import('../app/lib/workspaces/request-principal');
    const { withWorkspaceSideEffectWriterFenceOnConnection: fence,withWorkspaceSideEffectWriterMutationOnConnection: mutate }
      = await import('../app/lib/files/workspace-side-effect-writer-fence');
    await fixture.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('member','Member','member@authority.test',1,'user',0,$1,$1)`,[now]);
    await fixture.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('redemption-org','member','member','active',1,1,100,100)`);
    await fixture.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('member-seat','redemption-org','member@authority.test','member','member','active',100,200,100,100)`);
    const seed = async (permission:'read'|'write'='write') => {
      const id=crypto.randomUUID(),documentId=`authority-${crypto.randomUUID()}`,lineageId=`authority-lineage-${crypto.randomUUID()}`;
      const filePath=`guest-authority-${crypto.randomUUID()}.md`;
      const doc=new Y.Doc();let update:Buffer,vector:Buffer;
      try{doc.getText('content').insert(0,'Actual native invitation authority.');update=Buffer.from(Y.encodeStateAsUpdate(doc));vector=Buffer.from(Y.encodeStateVector(doc));}
      finally{doc.destroy();}
      await writeFile(path.join(workspace.rootPath,filePath),'Actual native invitation authority.');
      await fixture.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,'redemption-space','organization','redemption-org',$2,'active',100)`,[lineageId,filePath]);
      await fixture.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'redemption-space','organization','redemption-org',$3,'yjs',7,'initialized','active',100,100)`,[documentId,lineageId,filePath]);
      await fixture.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,'redemption-space','redemption-org',$2,'plain_text',1,1,$3,$4,7,100,7,100,'fixture','fixture','lf',0,0,'active')`,[documentId,filePath,update!,vector!]);
      await fixture.query(`INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,lineage_id,lifecycle_generation,email,permission,status,policy_revision,created_by_user_id,assets_json,created_at,updated_at)
        VALUES($1,'redemption-space',$2,$3,$4,1,$5,$6,'active',1,'member','[]',$7,$7)`,
      [id,filePath,documentId,lineageId,`guest-${crypto.randomUUID()}@authority.invalid`,permission,Date.now()]);
      return {id,documentId,lineageId,filePath};
    };
    const transaction=async<T>(operation:(connection:SqlConnection)=>Promise<T>)=>{
      const connection=await database.openDb();
      try{await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');return await operation(connection);}
      finally{await Promise.resolve(connection.run('ROLLBACK')).catch(()=>undefined);await connection.close();}
    };
    const peer=async(operation:(client:Client)=>Promise<void>)=>{
      const client=new Client({connectionString,connectionTimeoutMillis:5000,
        options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100`});
      client.on('error',()=>undefined);await client.connect();
      try{await operation(client);}finally{await client.query('ROLLBACK').catch(()=>undefined);await client.end();}
    };
    const expected=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&Reflect.get(error,'code')===code;
    const check=async(name:string,test:()=>Promise<void>)=>{stage=name;await test();cases++;console.log(`Guest invitation authority fixture passed: ${name}`);};
    await check('actual factories bind all three purposes to immutable invitation context without member sessions',async()=>{
      const target=await seed();
      for(const purpose of ['challenge','redeem','failed_challenge_cleanup'] as const)await capture(target.id,purpose,
        authority=>transaction(connection=>phase(connection,authority,async access=>{
          assert.equal(access.userId,'member');assert.equal(access.workspace.actor?.userId,'member');
          assert.equal(access.invitation.documentId,target.documentId);assert.equal(access.invitation.lineageId,target.lineageId);
          assert.equal(access.invitation.lifecycleGeneration,1);assert.equal(access.invitation.policyRevision,1);
          assert.deepEqual(Object.keys(access).sort(),['assertCurrent','invitation','userId','workspace']);
          assert.deepEqual(Object.keys(access.invitation).sort(),['createdByUserId','documentId','id','lifecycleGeneration','lineageId','path','permission','policyRevision','workspaceId']);
          assert(Object.isFrozen(access));assert(Object.isFrozen(access.workspace));assert(Object.isFrozen(access.invitation));
          await access.assertCurrent();
        })));
      assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM "session"')).rows[0].n),0);
      assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM file_guest_sessions')).rows[0].n),0);
    });
    await check('forged expired and cross-kind capabilities cannot become member principals',async()=>{
      await transaction(connection=>assert.rejects(phase(connection,{} as FileGuestInvitationAuthority,async()=>assert.fail()),expected('FILE_GUEST_INVITATION_AUTHORITY_REQUIRED')));
      const target=await seed();let old!:FileGuestInvitationAuthority;
      await capture(target.id,'challenge',async authority=>{old=authority;});
      await transaction(connection=>assert.rejects(phase(connection,old,async()=>assert.fail()),expected('FILE_GUEST_INVITATION_AUTHORITY_REQUIRED')));
      await assert.rejects(capture(target.id,'challenge',authority=>transaction(connection=>memberPhase(connection,
        authority as unknown as Parameters<typeof memberPhase>[1],async()=>assert.fail()))),expected('PRINCIPAL_REQUIRED'));
    });
    await check('unconfirmed legacy pins are rejected without retrobinding',async()=>{
      const target=await seed();
      await fixture.query('UPDATE file_guest_invitations SET lineage_id=NULL,lifecycle_generation=NULL WHERE id=$1',[target.id]);
      await assert.rejects(capture(target.id,'challenge',async()=>assert.fail()),expected('FILE_GUEST_INVITATION_SCOPE_CHANGED'));
      const row=(await fixture.query('SELECT lineage_id,lifecycle_generation FROM file_guest_invitations WHERE id=$1',[target.id])).rows[0];
      assert.equal(row.lineage_id,null);assert.equal(row.lifecycle_generation,null);
    });
    await check('fresh ban sharing rights write rights and seat suspension deny the real inviter',async()=>{
      const target=await seed();
      for(const [change,restore] of [
        ['UPDATE "user" SET banned=1 WHERE id=\'member\'','UPDATE "user" SET banned=0 WHERE id=\'member\''],
        ["UPDATE organization_user_permissions SET can_create_public_links=0 WHERE user_id='member'","UPDATE organization_user_permissions SET can_create_public_links=1 WHERE user_id='member'"],
        ["UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'","UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'"],
        ["UPDATE team_memberships SET status='suspended' WHERE id='member-seat'","UPDATE team_memberships SET status='active' WHERE id='member-seat'"],
      ]){
        try{await fixture.query(change);await assert.rejects(capture(target.id,'challenge',async()=>assert.fail()));}
        finally{await fixture.query(restore);}
      }
      await capture(target.id,'challenge',authority=>transaction(connection=>phase(connection,authority,async access=>{await access.assertCurrent();})));
    });
    await check('policy pin and creator drift after actual factory fail on the real writer connection',async()=>{
      for(const [column,value] of [['policy_revision',2],['lifecycle_generation',2],['created_by_user_id','owner']] as const){
        const target=await seed();
        await assert.rejects(capture(target.id,'challenge',async authority=>{
          await fixture.query(`UPDATE file_guest_invitations SET ${column}=$1 WHERE id=$2`,[value,target.id]);
          return transaction(connection=>phase(connection,authority,async()=>assert.fail()));
        }),expected('FILE_GUEST_INVITATION_SCOPE_CHANGED'));
      }
    });
    await check('actual writer B rejects inviter rights seat and namespace changes after factory preparation',async()=>{
      const target=await seed();
      for(const [change,restore] of [
        ["UPDATE \"user\" SET banned=1 WHERE id='member'","UPDATE \"user\" SET banned=0 WHERE id='member'"],
        ["UPDATE organization_user_permissions SET can_create_public_links=0 WHERE user_id='member'","UPDATE organization_user_permissions SET can_create_public_links=1 WHERE user_id='member'"],
        ["UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'","UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'"],
        ["UPDATE team_memberships SET status='suspended' WHERE id='member-seat'","UPDATE team_memberships SET status='active' WHERE id='member-seat'"],
        ["UPDATE team_membership_sync_state SET reconciliation_seat_limit=1 WHERE organization_id='redemption-org'","UPDATE team_membership_sync_state SET reconciliation_seat_limit=NULL WHERE organization_id='redemption-org'"],
        ["UPDATE canvas_workspaces SET root_relative_path='changed-authority-root' WHERE id='redemption-space'",`UPDATE canvas_workspaces SET root_relative_path='${workspaceRootRelativePath.replaceAll("'","''")}' WHERE id='redemption-space'`],
      ]){
        try{await assert.rejects(capture(target.id,'challenge',async authority=>{
          await fixture.query(change);return transaction(connection=>phase(connection,authority,async()=>assert.fail()));
        }));}finally{await fixture.query(restore);}
      }
    });
    await check('revocation and expiry after actual factory cannot authorize challenge or redemption',async()=>{
      for(const revoke of [false,true]){
        const target=await seed();
        await assert.rejects(capture(target.id,'redeem',async authority=>{
          await fixture.query(revoke?"UPDATE file_guest_invitations SET status='revoked' WHERE id=$1"
            :'UPDATE file_guest_invitations SET expires_at=1 WHERE id=$1',[target.id]);
          return transaction(connection=>phase(connection,authority,async()=>assert.fail()));
        }),expected('FILE_GUEST_INVITATION_UNAVAILABLE'));
      }
    });
    await check('same-B predicate protection blocks actual competing rights role seat and phantom changes',async()=>{
      const target=await seed();
      await capture(target.id,'challenge',authority=>transaction(connection=>phase(connection,authority,async access=>{
        const ownPid=Number((await connection.get('SELECT pg_backend_pid() AS pid') as Row).pid);
        for(const sql of [
          "UPDATE \"user\" SET banned=1 WHERE id='member'",
          "UPDATE \"user\" SET role='admin' WHERE id='member'",
          "UPDATE organization_user_permissions SET can_create_public_links=0 WHERE user_id='member'",
          "UPDATE team_memberships SET activated_at=1 WHERE id='member-seat'",
          "INSERT INTO team_memberships(id,organization_id,candidate_email,status,created_at,updated_at) VALUES('phantom','redemption-org','phantom@authority.test','invited',100,100)",
          "UPDATE canvas_workspaces SET status='archived' WHERE id='redemption-space'",
          'ALTER TABLE organization_user_permissions DISABLE TRIGGER ALL',
        ])await peer(async client=>{
          assert.notEqual(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid),ownPid);
          await assert.rejects(client.query(sql),expected('55P03'));
        });
        await access.assertCurrent();
      })));
    });
    await check('Shared-fenced real OTP-field mutation preserves fixed invitation authority',async()=>{
      const target=await seed();
      await capture(target.id,'challenge',authority=>transaction(connection=>phase(connection,authority,async access=>{
        const native={kind:'native_file' as const,documentId:target.documentId,lineageId:target.lineageId,
          workspaceId:access.invitation.workspaceId,organizationId:access.workspace.organizationId??null,path:target.filePath,
          lifecycleGeneration:1,representation:'plain_text' as const,schemaVersion:1};
        await fence(connection,{workspace:access.workspace,targets:[native]},()=>mutate(connection,native,async()=>{
          await connection.run('SELECT id FROM file_guest_invitations WHERE id=$1 FOR UPDATE',[target.id]);
          await connection.run("UPDATE file_guest_invitations SET challenge_id='fixture-challenge',challenge_hash='fixture-hash',challenge_attempts=challenge_attempts+1 WHERE id=$1",[target.id]);
          await access.assertCurrent();
        }));
      })));
    });
    await check('autocommit and changed writer transaction identities fail closed',async()=>{
      const target=await seed();
      await assert.rejects(capture(target.id,'challenge',async authority=>{
        const connection=await database.openDb();
        try{return await phase(connection,authority,async()=>assert.fail());}finally{await connection.close();}
      }),expected('PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(target.id,'challenge',authority=>transaction(connection=>phase(connection,authority,async access=>{
        await connection.run('ROLLBACK');await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');await access.assertCurrent();
      }))),expected('PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('detached and concurrent current checks poison the invitation phase',async()=>{
      const target=await seed();
      await assert.rejects(capture(target.id,'challenge',authority=>transaction(connection=>phase(connection,authority,async access=>{
        void access.assertCurrent().catch(()=>undefined);
      }))),expected('PRINCIPAL_DETACHED'));
      await assert.rejects(capture(target.id,'challenge',authority=>transaction(connection=>phase(connection,authority,async access=>{
        await Promise.allSettled([access.assertCurrent(),access.assertCurrent()]);
      }))),expected('PRINCIPAL_REENTRANT'));
    });
    await check('actual delayed factory entry expires the captured invitation authority',async()=>{
      const target=await seed();
      await assert.rejects(capture(target.id,'challenge',async authority=>{
        await new Promise(resolve=>setTimeout(resolve,5050));
        return transaction(connection=>phase(connection,authority,async()=>assert.fail()));
      }),expected('PRINCIPAL_EXPIRED'));
    });
    await check('actual invalid Team certificate cannot mint an invitation authority',async()=>{
      const target=await seed(),certificate=process.env.CANVAS_LICENSE_CERT;
      try{process.env.CANVAS_LICENSE_CERT='invalid-owned-fixture-certificate';await assert.rejects(capture(target.id,'challenge',async()=>assert.fail()));}
      finally{process.env.CANVAS_LICENSE_CERT=certificate;}
    });
    const { withFileGuestInvitationWriter: writeInvitation,revokeFileGuestInvitation: revoke,FileGuestWriterCommitError } = await import('../app/lib/file-guests/writer');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const admission=createCollaborationAdmissionService({openConnection:database.openDb});
    const scope=(target:Awaited<ReturnType<typeof seed>>,filePath=target.filePath)=>({documentId:target.documentId,
      workspaceId:'redemption-space',organizationId:'redemption-org',path:filePath,representation:'plain_text' as const,lifecycleGeneration:1,schemaVersion:1});
    const reservation=(filePath:string,documents:Array<ReturnType<typeof scope>&{status:'active'}>)=>{
      const actionPayloadText=JSON.stringify({source:filePath,destination:`moved-${crypto.randomUUID()}.md`});
      return {requestId:crypto.randomUUID(),actorId:'owner',action:'move' as const,actionPayloadText,
        actionDigest:collaborationAdmissionActionDigest('move',actionPayloadText),
        scopes:[{workspaceId:'redemption-space',organizationId:'redemption-org',path:filePath,kind:'exact' as const}],expectedDocuments:documents};
    };
    const invitationRow=async(id:string)=>(await fixture.query('SELECT * FROM file_guest_invitations WHERE id=$1',[id])).rows[0] as Row;
    const rowProof=(row:Row)=>crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
    const writeAttempt=(id:string)=>writeInvitation(id,'challenge',async access=>{
      await access.database.run('UPDATE file_guest_invitations SET challenge_attempts=challenge_attempts+1 WHERE id=$1',[id]);
      await access.assertCurrent();return 'actual-writer-committed';
    });
    await check('actual Root invitation writer confirms its COMMIT and keeps fixed identity',async()=>{
      const target=await seed();
      assert.equal(await writeAttempt(target.id),'actual-writer-committed');
      const row=await invitationRow(target.id);assert.equal(Number(row.challenge_attempts),1);
      assert.equal(row.document_id,target.documentId);assert.equal(row.lineage_id,target.lineageId);assert.equal(Number(row.lifecycle_generation),1);
    });
    await check('actual Root invitation writer rolls back earlier SQL when a genuine later constraint fails',async()=>{
      const target=await seed(),before=rowProof(await invitationRow(target.id));
      await fixture.query("ALTER TABLE file_guest_invitations ADD CONSTRAINT guest_writer_fixture_hash CHECK(challenge_hash IS NULL OR challenge_hash <> 'writer-constraint-reject')");
      try{await assert.rejects(writeInvitation(target.id,'challenge',async access=>{
        await access.database.run('UPDATE file_guest_invitations SET challenge_attempts=challenge_attempts+1 WHERE id=$1',[target.id]);
        await access.database.run("UPDATE file_guest_invitations SET challenge_hash='writer-constraint-reject' WHERE id=$1",[target.id]);
      }),error=>expected('23514')(error)&&Reflect.get(error as object,'constraint')==='guest_writer_fixture_hash');}
      finally{await fixture.query('ALTER TABLE file_guest_invitations DROP CONSTRAINT guest_writer_fixture_hash');}
      assert.equal(rowProof(await invitationRow(target.id)),before);
    });
    await check('actual Root writer rejects genuine path and document reservation while unrelated writer stays available',async()=>{
      const target=await seed(),unrelated=await seed(),request=reservation(target.filePath,[{...scope(target),status:'active'}]);
      await admission.reserve(request);
      try{
        const actual=(await fixture.query(`SELECT
          (SELECT count(*) FROM collaboration_admission_scopes WHERE request_id=$1 AND path=$2) AS scopes,
          (SELECT count(*) FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$3 AND active) AS documents`,
        [request.requestId,target.filePath,target.documentId])).rows[0];
        assert.equal(Number(actual.scopes),1);assert.equal(Number(actual.documents),1);
        await assert.rejects(writeAttempt(target.id),expected('SIDE_EFFECT_WRITER_BUSY'));
        assert.equal(Number((await invitationRow(target.id)).challenge_attempts),0);
        await writeAttempt(unrelated.id);assert.equal(Number((await invitationRow(unrelated.id)).challenge_attempts),1);
      }finally{await admission.cancel(request,1);}
      await writeAttempt(target.id);
    });
    await check('actual Root writer rejects stale native generation and lineage without invoking mutation',async()=>{
      for(const change of ['generation','lineage'] as const){
        const target=await seed();
        if(change==='generation')await fixture.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1',[target.documentId]);
        else await fixture.query('UPDATE file_guest_invitations SET lineage_id=$1 WHERE id=$2',[`wrong-${crypto.randomUUID()}`,target.id]);
        const before=rowProof(await invitationRow(target.id));let called=false;
        await assert.rejects(writeInvitation(target.id,'challenge',async()=>{called=true;}),expected('FILE_GUEST_TARGET_CHANGED'));
        assert.equal(called,false);assert.equal(rowProof(await invitationRow(target.id)),before);
      }
    });
    await check('actual Root writer permits a genuine active room owner without replacing its lease',async()=>{
      const target=await seed(),client=new Client({connectionString,connectionTimeoutMillis:5000,
        options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000`});
      client.on('error',()=>undefined);await client.connect();
      let owner:Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>|undefined;
      try{
        owner=await createCollaborationRoomOwnerSession(client);
        const held=await owner.acquire(scope(target));
        await writeAttempt(target.id);owner.assertActive(held);
        const state=(await fixture.query('SELECT room_owner_token,room_owner_backend_pid,lifecycle_generation,document_sequence FROM collaboration_yjs_states WHERE document_id=$1',[target.documentId])).rows[0];
        assert.equal(state.room_owner_token,held.token);assert.equal(Number(state.room_owner_backend_pid),held.backendPid);
        assert.equal(Number(state.lifecycle_generation),1);assert.equal(Number(state.document_sequence),7);
      }finally{if(owner)await owner.close();else await client.end().catch(()=>undefined);}
    });
    // Real BetterAuth sessions are created only after the no-member-session
    // authority tests above. Their original Bearer credentials reach the factory.
    const tokens:Record<string,string>={};
    for(const userId of ['owner','member']){
      const token=crypto.randomBytes(32).toString('hex');tokens[userId]=token;
      await fixture.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$5)`,[`authority-session-${userId}`,token,userId,Date.now()+7*86400000,Date.now()]);
    }
    const { auth } = await import('../app/lib/auth');
    const request=(userId='member')=>new NextRequest('http://localhost/api/security/file-guests/revoke',{method:'DELETE',
      headers:{authorization:`Bearer ${tokens[userId]}`,'x-canvas-workspace-id':'redemption-space'}});
    for(const userId of ['owner','member'])assert.equal((await auth.api.getSession({headers:request(userId).headers}))?.session.id,`authority-session-${userId}`);
    const revokeTarget=(id:string,policyRevision=1,userId='member')=>revoke(request(userId),{workspaceId:'redemption-space',id,policyRevision});
    await check('actual authenticated member revokes nullable stale and missing native targets without rebinding',async()=>{
      for(const kind of ['nullable','stale','missing'] as const){
        const target=await seed();
        if(kind==='nullable')await fixture.query('UPDATE file_guest_invitations SET lineage_id=NULL,lifecycle_generation=NULL WHERE id=$1',[target.id]);
        if(kind==='stale')await fixture.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1',[target.documentId]);
        if(kind==='missing')await fixture.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1',[target.documentId]);
        const before=await invitationRow(target.id);
        assert.deepEqual(await revokeTarget(target.id),{id:target.id,policyRevision:2,status:'revoked'});
        const after=await invitationRow(target.id);assert.equal(after.status,'revoked');assert.equal(after.challenge_hash,null);
        for(const key of ['workspace_id','path','document_id','lineage_id','lifecycle_generation','permission','created_by_user_id'])assert.equal(after[key],before[key]);
      }
    });
    await check('monotone revoke honors genuine path-only reservation for a legacy missing target',async()=>{
      const target=await seed(),missingPath=`missing-revoke-${crypto.randomUUID()}.md`,missingDoc=`missing-${crypto.randomUUID()}`;
      await fixture.query('UPDATE file_guest_invitations SET path=$1,document_id=$2,lineage_id=NULL,lifecycle_generation=NULL WHERE id=$3',[missingPath,missingDoc,target.id]);
      const reserved=reservation(missingPath,[]);await admission.reserve(reserved);
      try{
        assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM collaboration_admission_targets WHERE request_id=$1',[reserved.requestId])).rows[0].n),0);
        await assert.rejects(revokeTarget(target.id),expected('SIDE_EFFECT_WRITER_BUSY'));assert.equal((await invitationRow(target.id)).status,'active');
      }finally{await admission.cancel(reserved,1);}
      assert.equal((await revokeTarget(target.id)).status,'revoked');
    });
    await check('monotone revoke honors genuine document reservation at another current path',async()=>{
      const target=await seed(),currentPath=`current-revoke-${crypto.randomUUID()}.md`;
      // Owned fixture data models an already changed namespace. This is not a
      // claim that the runtime Move coordinator executed or was accepted.
      await fixture.query('UPDATE collaboration_yjs_states SET path=$1 WHERE document_id=$2',[currentPath,target.documentId]);
      await fixture.query('UPDATE collaboration_documents SET path=$1 WHERE id=$2',[currentPath,target.documentId]);
      await fixture.query('UPDATE file_collaboration_lineages SET path=$1 WHERE id=$2',[currentPath,target.lineageId]);
      const reserved=reservation(currentPath,[{...scope(target,currentPath),status:'active'}]);await admission.reserve(reserved);
      try{
        assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM collaboration_admission_scopes WHERE request_id=$1 AND path=$2',[reserved.requestId,target.filePath])).rows[0].n),0);
        assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2 AND active',[reserved.requestId,target.documentId])).rows[0].n),1);
        await assert.rejects(revokeTarget(target.id),expected('SIDE_EFFECT_WRITER_BUSY'));assert.equal((await invitationRow(target.id)).status,'active');
      }finally{await admission.cancel(reserved,1);}
      assert.equal((await revokeTarget(target.id)).status,'revoked');
    });
    await check('monotone revoke preserves actual member authentication creator policy and stale revision',async()=>{
      const target=await seed(),before=rowProof(await invitationRow(target.id));
      await assert.rejects(revokeTarget(target.id,2),expected('FILE_GUEST_WRITE_CHANGED'));
      await assert.rejects(revoke(new NextRequest('http://localhost/api/security/file-guests/revoke'),{
        workspaceId:'redemption-space',id:target.id,policyRevision:1}),expected('PRINCIPAL_AUTH_REVOKED'));
      assert.equal(rowProof(await invitationRow(target.id)),before);
      await fixture.query("UPDATE file_guest_invitations SET created_by_user_id='owner' WHERE id=$1",[target.id]);
      const changed=rowProof(await invitationRow(target.id));
      await assert.rejects(revokeTarget(target.id),expected('FILE_GUEST_WRITE_DENIED'));assert.equal(rowProof(await invitationRow(target.id)),changed);
      assert.equal((await revokeTarget(target.id,1,'owner')).status,'revoked');
    });
    await check('member with sharing and read rights can revoke an existing write invitation after losing write rights',async()=>{
      const target=await seed();
      try{
        await fixture.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='member'");
        assert.equal((await revokeTarget(target.id)).status,'revoked');
      }finally{await fixture.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='member'");}
    });
    await check('actual revoke writer rejects real temporary invitation and admission relation shadows',async()=>{
      for(const relation of ['file_guest_invitations','collaboration_admission_requests','collaboration_admission_scopes','collaboration_admission_targets']){
        const target=await seed(),before=rowProof(await invitationRow(target.id)),originalQuery=Client.prototype.query;
        let injected=false,writerPid=0,rolledBack=false,shadowGone=false;
        Client.prototype.query=function(this:Client,...args:unknown[]){
          const sql=typeof args[0]==='string'?args[0].trim():'';
          if(!injected&&sql==='BEGIN'){
            injected=true;writerPid=Number(Reflect.get(this,'processID'));
            // Run real fixture DDL on the actual checked-out writer backend.
            // Its BEGIN SQL/result are forwarded unchanged, never substituted.
            return Promise.resolve(Reflect.apply(originalQuery,this,args)).then(async result=>{
              await Reflect.apply(originalQuery,this,[`CREATE TEMP TABLE "${relation}" (LIKE "${schema}"."${relation}" INCLUDING ALL) ON COMMIT DROP`]);
              const actual=await Reflect.apply(originalQuery,this,[`SELECT to_regclass($1)::oid<>to_regclass($2)::oid AS shadowed`,[relation,`"${schema}"."${relation}"`]]);
              assert.equal(actual.rows[0].shadowed,true);return result;
            });
          }
          if(injected&&Number(Reflect.get(this,'processID'))===writerPid&&sql==='ROLLBACK')return Promise.resolve(
            Reflect.apply(originalQuery,this,args)).then(async result=>{
            rolledBack=true;
            const actual=await Reflect.apply(originalQuery,this,[`SELECT to_regclass($1) IS NULL AS absent`,[`pg_temp.${relation}`]]);
            shadowGone=actual.rows[0].absent===true;return result;
          });
          return Reflect.apply(originalQuery,this,args);
        } as typeof Client.prototype.query;
        try{await assert.rejects(revokeTarget(target.id),expected('FILE_GUEST_WRITE_CHANGED'));}
        finally{Client.prototype.query=originalQuery;}
        assert(injected);assert(writerPid>0);assert(rolledBack);assert(shadowGone);
        assert.equal(rowProof(await invitationRow(target.id)),before);
      }
    });
    for(const family of ['invitation','revoke'] as const)
    for(const mode of ['lost-ack','lost-ack-discard-throws','confirmed-commit-release-throws'] as const)
    await check(`actual ${family} writer COMMIT ambiguity ${mode} never publishes success or replays mutation`,async()=>{
      const target=await seed();
      if(family==='revoke')await fixture.query("UPDATE file_guest_invitations SET challenge_hash='must-be-cleared' WHERE id=$1",[target.id]);
      const before=await invitationRow(target.id),originalQuery=Client.prototype.query;
      const nativeProof=async()=>rowProof((await fixture.query(`SELECT jsonb_build_object(
        'document',(SELECT to_jsonb(d) FROM collaboration_documents d WHERE d.id=$1),
        'lineage',(SELECT to_jsonb(l) FROM file_collaboration_lineages l WHERE l.id=$2),
        'state',(SELECT to_jsonb(s) FROM collaboration_yjs_states s WHERE s.document_id=$1)) AS snapshot`,
      [target.documentId,target.lineageId])).rows[0]);
      const nativeBefore=await nativeProof();
      const checkouts=new Map<Client,(error?:Error)=>void>();
      let writerPid=0,dml=0,commits=0,rollbacks=0,disposals=0,committed=false,disposed=false,discarded=false,disposalThrew=false;
      let callbackCompleted=false,published=false;
      const lostAck=Object.assign(new Error('Owned fixture lost the ACK of a successful actual Guest writer COMMIT.'),{code:'ECONNRESET'});
      const releaseError=new Error('Owned fixture threw only after the genuine Guest writer checkout disposal.');
      Client.prototype.query=function(this:Client,...args:unknown[]){
        const sql=typeof args[0]==='string'?args[0].trim():'',values=Array.isArray(args[1])?args[1]:[];
        if(/^UPDATE\s+(?:"[^"]+"\.)?"?file_guest_invitations"?\b/iu.test(sql)&&values.includes(target.id)){
          dml++;writerPid=Number(Reflect.get(this,'processID'));
          if(!checkouts.has(this)){
            const release=Reflect.get(this,'release') as (error?:Error)=>void;assert.equal(typeof release,'function');checkouts.set(this,release);
            Reflect.set(this,'release',(error?:Error)=>{
              disposals++;discarded=error instanceof Error;
              const result=Reflect.apply(release,this,[error]);disposed=true;
              if(mode!=='lost-ack'){disposalThrew=true;throw releaseError;}return result;
            });
          }
        }
        if(checkouts.has(this)){
          if(sql==='ROLLBACK')rollbacks++;
          if(sql==='COMMIT'){
            commits++;
            // The original COMMIT really completes first. Only its returned
            // acknowledgement is then lost; no SQL or result is replaced.
            return Promise.resolve(Reflect.apply(originalQuery,this,args)).then(result=>{
              committed=true;if(mode!=='confirmed-commit-release-throws')throw lostAck;return result;
            });
          }
        }
        return Reflect.apply(originalQuery,this,args);
      } as typeof Client.prototype.query;
      try{
        const operation=family==='invitation'?writeInvitation(target.id,'challenge',async access=>{
          await access.database.run('UPDATE file_guest_invitations SET challenge_attempts=challenge_attempts+1 WHERE id=$1',[target.id]);
          await access.assertCurrent();callbackCompleted=true;return 'private-callback-value-must-not-be-published';
        }):revokeTarget(target.id);
        await assert.rejects(operation.then(value=>{published=true;return value;}),error=>{
          assert(error instanceof FileGuestWriterCommitError);assert.equal(error.code,'FILE_GUEST_WRITE_COMMIT_UNCONFIRMED');assert.equal(error.status,503);
          assert(committed);assert(disposed);assert.equal(discarded,mode!=='confirmed-commit-release-throws');
          assert.equal(disposalThrew,mode!=='lost-ack');return true;
        });
      }finally{
        Client.prototype.query=originalQuery;
        for(const [client,release] of checkouts)Reflect.set(client,'release',release);
      }
      assert.equal(published,false);assert.equal(callbackCompleted,family==='invitation');
      assert.equal(checkouts.size,1);assert(writerPid>0);assert.equal(dml,1);assert.equal(commits,1);assert.equal(rollbacks,0);assert.equal(disposals,1);
      if(mode!=='confirmed-commit-release-throws'){
        const deadline=Date.now()+5000;
        while(!(await fixture.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent',[writerPid])).rows[0].absent){
          assert(Date.now()<deadline,'The actually discarded Guest writer backend remained present.');await new Promise(resolve=>setTimeout(resolve,20));
        }
      }
      const after=await invitationRow(target.id);
      if(family==='invitation'){
        assert.equal(Number(after.challenge_attempts),Number(before.challenge_attempts)+1);
        for(const key of Object.keys(before).filter(key=>key!=='challenge_attempts'))assert.equal(after[key],before[key]);
      }else{
        assert.equal(after.status,'revoked');assert.equal(after.challenge_hash,null);assert.equal(Number(after.policy_revision),2);
        for(const key of Object.keys(before).filter(key=>!['status','challenge_hash','policy_revision','updated_at'].includes(key)))assert.equal(after[key],before[key]);
        const committedRow=rowProof(after);
        await assert.rejects(revokeTarget(target.id),expected('FILE_GUEST_WRITE_CHANGED'));
        assert.equal(rowProof(await invitationRow(target.id)),committedRow,'A fresh stale-revision request must not replay the committed revoke.');
      }
      assert.equal(await nativeProof(),nativeBefore,'Unknown Guest outcomes must not change any native identity, binary state, sequence or registry field.');
    });
    assert.equal(cases,30);assert.equal(networkCalls,0);
    console.log(`file-guest-invitation-authority-postgres-test: ${cases} real PG18 invitation authority families passed.`);
  }finally{
    globalThis.fetch=originalFetch;await closeRuntime?.();await admin?.end().catch(()=>undefined);
    if(created)await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.end().catch(()=>undefined);await rm(dataRoot,{recursive:true,force:true});
    for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);
  }
}
void main().catch(error=>{
  console.error(`Guest invitation authority fixture failed during: ${stage}`);
  console.error(error instanceof Error?{name:error.name,message:error.message}:'Unknown authority fixture failure.');process.exitCode=1;
});
