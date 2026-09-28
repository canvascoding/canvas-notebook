import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { createFileChangeReviewNotificationSource } from '../app/lib/file-version-center/notification-source';
import { FILE_CHANGE_REVIEW_BRANCH_NOTIFICATION_PREFIX } from '../app/lib/file-version-center/notification-contract';
import { parseFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const T0 = Date.UTC(2026, 8, 26, 9, 0, 0);
const scope = { workspaceId: 'ws', lineageId: 'lineage', documentId: 'doc', lifecycleGeneration: 1, schemaVersion: 1 };

function database(pg: PGlite): FileVersionCenterDatabase {
  return { transaction: (action) => pg.transaction(async (tx) => action({
    query: <Row>(sql: string, params?: unknown[]) => tx.query<Row>(sql, params),
  })) };
}

function workspace(canManageWorkspace = false): WorkspaceContext {
  return { workspaceId: 'ws', workspaceType: 'team', organizationId: 'org', rootPath: '/private',
    displayName: 'Team', status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: false,
      canCreatePublicLinks: false, canManageWorkspace, canRunAgent: true } };
}

async function seed(pg: PGlite): Promise<void> {
  await runPostgresMigrations(pg as unknown as Parameters<typeof runPostgresMigrations>[0]);
  await pg.exec(`
    INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES
      ('owner','Owner','owner@graph-notification.test',1,1,1),
      ('other','Other','other@graph-notification.test',1,1,1),
      ('manager','Manager','manager@graph-notification.test',1,1,1);
    INSERT INTO canvas_organization_settings
      (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES ('org','owner','team',1,1,1);
    INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,root_relative_path,display_name,workspace_icon,status,is_default,created_at,updated_at)
      VALUES ('ws','org','team','owner','workspaces/team','Team','users','active',0,1,1);
    INSERT INTO file_collaboration_lineages
      (id,organization_id,workspace_id,workspace_type,path,status,created_at,archived_at)
      VALUES ('lineage','org','ws','team','review.md','active',1,NULL);
    INSERT INTO collaboration_documents
      (id,organization_id,workspace_id,workspace_type,path,lineage_id,provider,state_version,status,created_at,updated_at)
      VALUES ('doc','org','ws','team','review.md','lineage','yjs',1,'active',1,1);
    INSERT INTO collaboration_yjs_states
      (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
       yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence)
      VALUES ('doc','ws','org','review.md','plain_text',1,1,decode('00','hex'),decode('00','hex'),1,1,1);
    INSERT INTO file_proposal_graphs
      (graph_id,workspace_id,lineage_id,document_id,lifecycle_generation,schema_version,created_at,updated_at)
      VALUES ('graph','ws','lineage','doc',1,1,1,1);
  `);
}

async function proposal(pg: PGlite, input: { id: string; parent?: string; owner?: string;
  lifecycle?: string; updatedAt?: number; choiceGroupId?: string }): Promise<void> {
  const operationId = `operation-${input.id}`;
  const timestamp = input.updatedAt ?? T0;
  await pg.query(`INSERT INTO collaboration_agent_operations
    (operation_id,document_id,workspace_id,organization_id,initiated_by_user_id,actor_id,
     idempotency_key,payload_hash,operation_type,requested_mode,status,
     document_lifecycle_generation,schema_version,base_state_vector,created_at,updated_at)
    VALUES ($1,'doc','ws','org',$2,'main',$1 || '-key',repeat('a',64),'apply','review',
      'needs_review',1,1,decode('00','hex'),$3,$3)`, [operationId, input.owner ?? 'owner', timestamp]);
  await pg.query(`INSERT INTO file_change_proposals
    (proposal_id,graph_id,operation_id,cas_version,lifecycle,node_json,dependency_proposal_id,
     choice_group_id,created_at,updated_at)
    VALUES ($1,'graph',$2,1,$3,$4::jsonb,$5,$6,$7,$7)`,
  [input.id, operationId, input.lifecycle ?? 'open', JSON.stringify({ contractVersion: 1,
    proposalId: input.id, operationId, lifecycle: input.lifecycle ?? 'open', casVersion: 1,
    scope, source: { scope },
    relationships: { dependency: input.parent ? { proposalId: input.parent } : null,
      choiceGroupId: input.choiceGroupId ?? null } }), input.parent ?? null,
    input.choiceGroupId ?? null, timestamp]);
}

async function seedClosedHistoryGraph(pg: PGlite): Promise<void> {
  await pg.exec(`
    INSERT INTO file_collaboration_lineages
      (id,organization_id,workspace_id,workspace_type,path,status,created_at,archived_at)
      VALUES ('closed-lineage','org','ws','team','closed.md','active',1,NULL);
    INSERT INTO collaboration_documents
      (id,organization_id,workspace_id,workspace_type,path,lineage_id,provider,state_version,status,created_at,updated_at)
      VALUES ('closed-doc','org','ws','team','closed.md','closed-lineage','yjs',1,'active',1,1);
    INSERT INTO collaboration_yjs_states
      (document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
       yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence)
      VALUES ('closed-doc','ws','org','closed.md','plain_text',1,1,decode('00','hex'),decode('00','hex'),1,1,1);
    INSERT INTO file_proposal_graphs
      (graph_id,workspace_id,lineage_id,document_id,lifecycle_generation,schema_version,created_at,updated_at)
      VALUES ('closed-graph','ws','closed-lineage','closed-doc',1,1,1,1);
    INSERT INTO collaboration_agent_operations
      (operation_id,document_id,workspace_id,organization_id,initiated_by_user_id,actor_id,
       idempotency_key,payload_hash,operation_type,requested_mode,status,
       document_lifecycle_generation,schema_version,base_state_vector,created_at,updated_at)
      VALUES ('closed-operation','closed-doc','ws','org','owner','main','closed-operation-key',
        repeat('a',64),'apply','review','needs_review',1,1,decode('00','hex'),1,1);
  `);
  const closedScope = { ...scope, lineageId: 'closed-lineage', documentId: 'closed-doc' };
  await pg.query(`INSERT INTO file_change_proposals
    (proposal_id,graph_id,operation_id,cas_version,lifecycle,node_json,created_at,updated_at)
    VALUES ('closed-proposal','closed-graph','closed-operation',1,'open',$1::jsonb,1,1)`, [JSON.stringify({
    contractVersion: 1, proposalId: 'closed-proposal', operationId: 'closed-operation',
    lifecycle: 'open', casVersion: 1, scope: closedScope, source: { scope: closedScope },
    relationships: { dependency: null, choiceGroupId: null },
  })]);
  await pg.exec(`UPDATE file_change_proposals SET lifecycle='rejected',cas_version=2,updated_at=2
    WHERE proposal_id='closed-proposal'`);
}

async function main(): Promise<void> {
  const pg = new PGlite();
  try {
    await seed(pg);
    await seedClosedHistoryGraph(pg);
    const metadataRowCounts: number[] = [];
    const observedDatabase: FileVersionCenterDatabase = { transaction: action => database(pg).transaction(async tx => action({
      query: async <Row>(sql: string, params?: unknown[]) => {
        const result = await tx.query<Row>(sql, params);
        if (sql.includes('FROM file_proposal_graphs graph')) metadataRowCounts.push(result.rows.length);
        return result;
      },
    })) };
    let clock = T0 + 100_000;
    const source = createFileChangeReviewNotificationSource({ database: observedDatabase,
      now: () => new Date(clock), notificationsEnabled: () => true });
    const input = { userId: 'owner', workspace: workspace() };
    assert.deepEqual(await source.list(input), []);
    assert.equal(metadataRowCounts.at(-1), 0,
      'a graph with only closed historical proposals must not consume the metadata read budget');
    await proposal(pg, { id: 'p1', updatedAt: T0 });
    await proposal(pg, { id: 'p2', parent: 'p1', updatedAt: T0 + 1 });
    await proposal(pg, { id: 'p3', parent: 'p1', updatedAt: T0 + 2 });
    let list = await source.list(input);
    assert.equal(metadataRowCounts.at(-1), 3,
      'an active graph keeps its complete open ancestry while unrelated closed graphs stay excluded');
    assert.equal(list.length, 1, 'parent and two actionable leaves form one notification');
    assert.equal(await source.countUnread(input), 1);
    const first = list[0]!;
    assert.equal(first.id.startsWith(FILE_CHANGE_REVIEW_BRANCH_NOTIFICATION_PREFIX), true);
    assert.deepEqual(first.target.branch && Object.keys(first.target.branch).sort(), ['itemId', 'revision', 'rootProposalId']);
    assert.equal(first.target.operationId, 'operation-p1');
    assert.equal(first.target.branch?.rootProposalId, 'p1');
    assert.deepEqual(parseFileVersionCenterDeepLinkV1(new URL(first.deepLink, 'https://canvas.test').searchParams), {
      contractVersion: 1, target: { kind: 'lineage', workspaceId: 'ws', lineageId: 'lineage' },
      selectedEntry: { kind: 'agent_operation', id: 'operation-p1' }, initialView: 'reviews',
      source: 'deep_link', branchOverview: true,
    });
    assert.equal((await source.setItemState({ ...input, itemId: first.id, read: true })).found, false,
      'a branch read without an observed revision must fail closed');
    assert.equal((await source.setItemState({ ...input, itemId: first.id,
      expectedRevision: first.target.branch?.revision, read: true })).found, true);
    assert.equal((await source.list(input))[0]?.unread, false);
    assert.equal(await source.countUnread(input), 0);

    await proposal(pg, { id: 'unrelated', updatedAt: T0 + 3 });
    list = await source.list(input);
    assert.equal(list.find((item) => item.id === first.id)?.target.branch?.revision, first.target.branch?.revision,
      'an unrelated root may not reset a read branch');
    assert.equal(list.find((item) => item.id === first.id)?.unread, false);

    await proposal(pg, { id: 'p4', parent: 'p1', updatedAt: T0 + 4 });
    const changed = (await source.list(input)).find((item) => item.id === first.id)!;
    assert.equal(changed.unread, true);
    assert.notEqual(changed.target.branch?.revision, first.target.branch?.revision);
    assert.equal((await source.setItemState({ ...input, itemId: first.id,
      expectedRevision: first.target.branch?.revision, read: true })).found, false,
    'a stale acknowledgement cannot read a newly opened child');
    assert.equal((await source.setItemState({ ...input, itemId: first.id,
      expectedRevision: changed.target.branch?.revision, read: true })).found, true);
    assert.equal((await source.list(input)).find((item) => item.id === first.id)?.unread, false);

    await proposal(pg, { id: 'foreign', parent: 'p1', owner: 'other', updatedAt: T0 + 5 });
    assert.equal((await source.list(input)).find((item) => item.id === first.id)?.target.branch?.revision,
      changed.target.branch?.revision, 'foreign child metadata must not leak through unread state');
    assert.equal((await source.list({ userId: 'other', workspace: workspace() })).some((item) =>
      item.target.branch?.rootProposalId === 'p1'), false, 'a foreign parent blocks child review');
    assert.equal((await source.list({ userId: 'manager', workspace: workspace(true) })).some((item) =>
      item.target.branch?.rootProposalId === 'p1'), true);

    await pg.query(`UPDATE file_change_proposals SET lifecycle='rejected',cas_version=cas_version+1,
      updated_at=$1 WHERE proposal_id='p1'`, [T0 + 6]);
    assert.equal((await source.list(input)).some((item) => item.id === first.id), false,
      'blocked descendants do not create repeat accept prompts');
    assert.equal((await source.list(input)).some((item) => item.id === 'file-change:operation-p1'), false,
      'a graph-bound legacy operation must not reappear when its proposal closes');
    assert.equal((await source.setItemState({ ...input, itemId: first.id,
      expectedRevision: changed.target.branch?.revision, read: true })).found, false);
    assert.equal((await source.setItemState({ ...input, itemId: 'file-change:operation-p1', read: true })).found, false);

    await pg.exec(`INSERT INTO file_proposal_choice_groups
      (graph_id,group_id,group_revision,dependency_proposal_id,chosen_proposal_id,created_at,updated_at)
      VALUES ('graph','choice',0,NULL,NULL,1,1)`);
    await proposal(pg, { id: 'choice-a', choiceGroupId: 'choice', updatedAt: T0 + 10 });
    await proposal(pg, { id: 'choice-b', choiceGroupId: 'choice', updatedAt: T0 + 11 });
    await pg.exec(`INSERT INTO file_proposal_choice_memberships (graph_id,group_id,proposal_id)
      VALUES ('graph','choice','choice-a'),('graph','choice','choice-b')`);
    let choice = (await source.list(input)).find((item) => item.target.branch?.rootProposalId === 'choice-a');
    assert.equal(choice?.target.operationId, 'operation-choice-a',
      'independent alternative roots share one explicit overview anchored to the oldest reference');
    assert.equal((await source.list(input)).some((item) => item.target.branch?.rootProposalId === 'choice-b'), false);
    const choiceId = choice!.id;
    await pg.query(`UPDATE file_change_proposals SET lifecycle='rejected',cas_version=cas_version+1,
      updated_at=$1 WHERE proposal_id='choice-a'`, [T0 + 12]);
    choice = (await source.list(input)).find((item) => item.id === choiceId);
    assert.equal(choice?.target.operationId, 'operation-choice-a',
      'closing the oldest choice member must not silently retarget its group link');
    for (let index = 0; index < 20; index += 1) {
      const id = `choice-extra-${index}`;
      await proposal(pg, { id, choiceGroupId: 'choice', updatedAt: T0 + 13 + index });
      await pg.query(`INSERT INTO file_proposal_choice_memberships (graph_id,group_id,proposal_id)
        VALUES ('graph','choice',$1)`, [id]);
    }
    choice = (await source.list(input)).find((item) => item.id === choiceId);
    assert.equal(choice?.target.operationId, 'operation-choice-a',
      'many newly opened alternatives still retain the oldest authorized historical anchor');

    // The graph remains within the canonical 256-node snapshot limit,
    // while the source must group before its 200-item presentation limit.
    await proposal(pg, { id: 'large-a', updatedAt: T0 + 20 });
    await proposal(pg, { id: 'large-b', updatedAt: T0 + 21 });
    for (let index = 0; index < 100; index += 1) {
      await proposal(pg, { id: `large-a-${index}`, parent: 'large-a', updatedAt: T0 + 30 + index });
      await proposal(pg, { id: `large-b-${index}`, parent: 'large-b', updatedAt: T0 + 130 + index });
    }
    list = await source.list(input);
    assert.equal(list.length, 4, '201+ active descendants collapse to their authorized branch groups');
    assert.equal(await source.countUnread(input), 4);
    choice = list.find((item) => item.target.branch?.rootProposalId === 'choice-a');
    assert.equal(choice?.id.startsWith(FILE_CHANGE_REVIEW_BRANCH_NOTIFICATION_PREFIX), true);

    clock += 1_000;
    const marked = await source.markAllRead(input);
    assert.equal(marked.updated, 4, 'only currently authorized open groups are marked');
    assert.equal(await source.countUnread(input), 0);
    await pg.query(`UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id='doc'`);
    assert.deepEqual(await source.list(input), [], 'a changed document lifecycle invalidates the old graph');
    console.log('file-change-review-graph-notification-test: ok');
  } finally {
    await pg.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
