import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { loadStoredProposalGraph } from '../app/lib/file-version-center/proposal-storage-projection';
import { parseProposalGraphSnapshotV1, parseProposalNodeV1, ProposalGraphContractError, type ProposalLifecycleV1, type ProposalNodeV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const scope = proposalScopeFixture;

function proposal(id: string, options: { lifecycle?: ProposalLifecycleV1; parent?: ProposalNodeV1; replaces?: string; group?: string } = {}): ProposalNodeV1 {
  const source = options.parent ? {
    ...rootProposalFixture.source,
    kind: 'proposal', proposalId: options.parent.proposalId, proposalCasVersion: options.parent.casVersion,
    candidateHash: options.parent.authoredCandidate.cumulativeCandidate.sha256,
    authoredCandidateHash: options.parent.authoredCandidate.cumulativeCandidate.sha256,
    evaluationId: null, snapshot: options.parent.authoredCandidate.cumulativeCandidate,
  } : rootProposalFixture.source;
  return parseProposalNodeV1({ ...rootProposalFixture, proposalId: id, operationId: `operation-${id}`, source,
    lifecycle: options.lifecycle ?? 'open', relationships: {
      dependency: options.parent ? { proposalId: options.parent.proposalId, candidateHash: options.parent.authoredCandidate.cumulativeCandidate.sha256 } : null,
      replacesProposalId: options.replaces ?? null, choiceGroupId: options.group ?? null,
    } });
}

async function main() {
  const pg = new PGlite();
  let hydrationQueries = 0;
  const db = { query: async <Row>(sql: string, params?: unknown[]) => {
    if (sql.includes('node_json,cas_version')) hydrationQueries++;
    // Every read of node rows must be bounded in SQL, before JS receives them.
    if (/SELECT[\s\S]*FROM file_change_proposals/u.test(sql) && !sql.includes('COUNT(*)')) assert.match(sql, /LIMIT \$/u);
    return pg.query<Row>(sql, params);
  } };
  const insert = async (node: ProposalNodeV1, graph = 'graph') => {
    await pg.query(`INSERT INTO file_change_proposals
      (graph_id,proposal_id,lifecycle,dependency_proposal_id,replaces_proposal_id,choice_group_id,node_json,cas_version,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [graph, node.proposalId, node.lifecycle, node.relationships.dependency?.proposalId ?? null,
      node.relationships.replacesProposalId, node.relationships.choiceGroupId, JSON.stringify(node), node.casVersion, node.createdAt]);
  };
  const reset = async () => {
    await pg.exec('DELETE FROM file_proposal_choice_memberships; DELETE FROM file_proposal_choice_groups; DELETE FROM file_change_proposals;');
    hydrationQueries = 0;
  };
  const expectCode = (code: string) => (error: unknown) => error instanceof ProposalGraphContractError && error.code === code;
  const load = async (includeProposalIds?: string[]) =>
    parseProposalGraphSnapshotV1(await loadStoredProposalGraph(db, 'graph', scope, 0, { includeProposalIds }));
  try {
    // The reader's four-table SQL surface is isolated here. Migration constraints,
    // transaction/CAS and retention are covered by the storage integration suite.
    await pg.exec(`
      CREATE TABLE file_proposal_graphs (graph_id text PRIMARY KEY,workspace_id text,lineage_id text,document_id text,
        lifecycle_generation bigint,schema_version bigint,graph_revision bigint);
      CREATE TABLE file_change_proposals (graph_id text,proposal_id text,lifecycle text,dependency_proposal_id text,
        replaces_proposal_id text,choice_group_id text,node_json jsonb,cas_version bigint,created_at bigint,PRIMARY KEY(graph_id,proposal_id));
      CREATE TABLE file_proposal_choice_groups (graph_id text,group_id text,group_revision bigint,dependency_proposal_id text,chosen_proposal_id text);
      CREATE TABLE file_proposal_choice_memberships (graph_id text,group_id text,proposal_id text);
    `);
    await pg.query('INSERT INTO file_proposal_graphs VALUES ($1,$2,$3,$4,1,1,0)', ['graph', scope.workspaceId, scope.lineageId, scope.documentId]);

    // Hundreds of unrelated terminal records must never become a document lifetime limit.
    await pg.query(`INSERT INTO file_change_proposals SELECT 'graph','history-'||i,'applied',NULL,NULL,NULL,
      jsonb_set(jsonb_set($1::jsonb,'{proposalId}',to_jsonb('history-'||i)),'{operationId}',to_jsonb('operation-history-'||i)),1,i
      FROM generate_series(1,400) AS i`, [JSON.stringify(proposal('template'))]);
    await insert(proposal('open'));
    assert.deepEqual((await load()).nodes.map((node) => node.proposalId), ['open']);
    const historical = await load(['history-233']);
    assert.deepEqual(historical.nodes.map((node) => node.proposalId), ['history-233', 'open']);
    assert.equal(historical.nodes[0].lifecycle, 'applied');
    assert.equal((await pg.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM file_change_proposals')).rows[0].count, 401);

    await reset();
    const parent = proposal('parent', { lifecycle: 'included' });
    await insert(parent);
    await insert(proposal('child', { parent }));
    assert.deepEqual((await load()).nodes.map((node) => node.proposalId), ['child', 'parent']);

    // Only the immediate predecessor is context; older replacement IDs remain exact.
    await reset();
    await insert(proposal('oldest', { lifecycle: 'superseded' }));
    await insert(proposal('previous', { lifecycle: 'superseded', replaces: 'oldest' }));
    await insert(proposal('current', { replaces: 'previous' }));
    const replacements = await load();
    assert.deepEqual(replacements.nodes.map((node) => node.proposalId), ['current', 'previous']);
    assert.deepEqual(replacements.archivedReplacementProposalIds, ['oldest']);
    await pg.query("DELETE FROM file_change_proposals WHERE proposal_id='oldest'");
    await assert.rejects(load(), expectCode('PROPOSAL_SOURCE_INVALID'));
    await insert(proposal('oldest', { lifecycle: 'superseded' }), 'another-graph');
    await assert.rejects(load(), expectCode('PROPOSAL_SOURCE_INVALID'));

    // Fully resolved alternative histories remain auditable by exact selection.
    await reset();
    await insert(proposal('winner', { lifecycle: 'applied', group: 'choice' }));
    await insert(proposal('old-alternative', { lifecycle: 'alternative_not_selected', group: 'choice' }));
    await insert(proposal('required-child', { parent: proposal('winner', { lifecycle: 'applied', group: 'choice' }) }));
    await pg.exec(`INSERT INTO file_proposal_choice_groups VALUES ('graph','choice',1,NULL,'winner');
      INSERT INTO file_proposal_choice_memberships VALUES ('graph','choice','winner'),('graph','choice','old-alternative');`);
    const choices = await load();
    assert.deepEqual(choices.nodes.map((node) => node.proposalId), ['required-child', 'winner']);
    assert.deepEqual(choices.choiceGroups[0].memberProposalIds, ['winner']);
    assert.equal(choices.choiceGroups[0].archivedMemberCount, 1);
    const exactAlternative = await load(['old-alternative']);
    assert.equal(exactAlternative.choiceGroups[0].archivedMemberCount, 0);
    assert.deepEqual(exactAlternative.choiceGroups[0].memberProposalIds, ['old-alternative', 'winner']);
    await pg.exec("UPDATE file_proposal_choice_memberships SET proposal_id='missing' WHERE proposal_id='old-alternative'");
    await assert.rejects(load(), expectCode('PROPOSAL_CHOICE_CONFLICT'));

    await reset();
    await insert(proposal('open-a', { group: 'choice' }));
    await insert(proposal('open-b', { group: 'choice' }));
    await insert(proposal('archived', { lifecycle: 'rejected', group: 'choice' }));
    await pg.exec(`INSERT INTO file_proposal_choice_groups VALUES ('graph','choice',0,NULL,NULL);
      INSERT INTO file_proposal_choice_memberships VALUES ('graph','choice','open-a'),('graph','choice','open-b'),('graph','choice','archived');`);
    const openChoices = await load();
    assert.deepEqual(openChoices.choiceGroups[0].memberProposalIds, ['open-a', 'open-b']);
    assert.equal(openChoices.choiceGroups[0].archivedMemberCount, 1);
    await pg.query(`INSERT INTO file_change_proposals SELECT 'graph','archived-'||i,'rejected',NULL,NULL,'choice',
      jsonb_set(jsonb_set($1::jsonb,'{proposalId}',to_jsonb('archived-'||i)),'{operationId}',to_jsonb('operation-archived-'||i)),1,i
      FROM generate_series(1,300) AS i`, [JSON.stringify(proposal('template', { lifecycle: 'rejected', group: 'choice' }))]);
    await pg.exec("INSERT INTO file_proposal_choice_memberships SELECT 'graph','choice','archived-'||i FROM generate_series(1,300) AS i");
    const largeChoiceHistory = await load();
    assert.equal(largeChoiceHistory.nodes.length, 2);
    assert.equal(largeChoiceHistory.choiceGroups[0].archivedMemberCount, 301);
    await assert.rejects(load(['missing']), expectCode('PROPOSAL_SOURCE_INVALID'));
    await assert.rejects(loadStoredProposalGraph(db, 'graph', { ...scope, workspaceId: 'wrong' }, 0), expectCode('PROPOSAL_SCOPE_MISMATCH'));

    // Limits are applied to the active closure, and checked before JSON hydration.
    await reset();
    await pg.query(`INSERT INTO file_change_proposals SELECT 'graph','open-'||i,'open',NULL,NULL,NULL,$1::jsonb,1,i
      FROM generate_series(1,257) AS i`, [JSON.stringify(proposal('template'))]);
    await assert.rejects(load(), expectCode('PROPOSAL_LIMIT_EXCEEDED'));
    assert.equal(hydrationQueries, 0);
    await reset();
    await insert(proposal('large'));
    await pg.exec("UPDATE file_change_proposals SET node_json=jsonb_set(node_json,'{oversized}',to_jsonb(repeat('x',1048576)))");
    await assert.rejects(load(), expectCode('PROPOSAL_LIMIT_EXCEEDED'));
    assert.equal(hydrationQueries, 0);
    console.log('proposal graph storage projection: bounded active context, exact historical IDs and authoritative archive metadata passed');
  } finally {
    await pg.close();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
