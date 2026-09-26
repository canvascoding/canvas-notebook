import 'server-only';

import { randomUUID } from 'node:crypto';

import { createAgentTextTarget, createRichAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { Y } from '../app/lib/collaboration/server-runtime';
import { closeDatabaseConnections } from '../app/lib/db';
import { createRuntimeFileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { createRuntimeProposalAgentService } from '../app/lib/file-version-center/proposal-agent-runtime';
import { createProposalGraphStorage } from '../app/lib/file-version-center/proposal-storage';
import type { ProposalSourceProofV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { readPostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import type { WorkspaceUserRole } from '../app/lib/workspaces/types';

type Input = { userId: string; role: WorkspaceUserRole; workspaceId: string; documentId: string; filePath: string };
const PATH = /^fvrc-1006-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/iu;
const BASE_TEXT = '# Graph flow fixture\n\nA0|B0\n';

function requireSafeEnvironment(input: Input): void {
  if (process.env.COLLABORATION_E2E !== '1') throw new Error('The graph flow fixture requires COLLABORATION_E2E=1.');
  let databaseUrl: URL;
  try { databaseUrl = new URL(process.env.DATABASE_URL || ''); }
  catch { throw new Error('The graph flow fixture requires a local DATABASE_URL.'); }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(databaseUrl.hostname) || databaseUrl.port !== '55433') {
    throw new Error('The graph flow fixture is restricted to the managed loopback PostgreSQL service.');
  }
  if (!PATH.test(input.filePath) || input.filePath !== input.filePath.split('/').at(-1)
    || !input.userId || !input.workspaceId || !input.documentId
    || !['owner', 'admin', 'member', 'external'].includes(input.role)) {
    throw new Error('The graph flow fixture identity is outside its dedicated allowlist.');
  }
}

function declaration(source: ProposalSourceProofV1): ProposalToolEditV1 {
  return { contractVersion: 1, creationKind: source.kind === 'proposal' ? 'extends' : 'independent', source,
    expectedParentCasVersion: source.kind === 'proposal' ? source.proposalCasVersion : null,
    expectedParentCandidateHash: source.kind === 'proposal' ? source.candidateHash : null,
    replaces: null, choice: null };
}

function targets(input: { update: Uint8Array; representation: string; search: string; replacement: string }) {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, input.update);
    if (input.representation === 'tiptap_xml' || input.representation === 'tiptap_blocks') {
      return createRichAgentTextTargets({ doc, search: input.search, replacement: input.replacement,
        expectedOccurrences: 1, groupId: `fvrc-1006-flow-${input.replacement}` });
    }
    if (input.representation !== 'plain_text') throw new Error('The graph flow fixture requires a supported text representation.');
    const text = doc.getText('content');
    const from = text.toString().indexOf(input.search);
    if (from < 0) throw new Error('The graph flow target is absent from its exact source.');
    return [createAgentTextTarget({ text, from, to: from + input.search.length,
      replacement: input.replacement, groupId: `fvrc-1006-flow-${input.replacement}` })];
  } finally { doc.destroy(); }
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded || process.argv.length !== 3) throw new Error('Pass one base64url-encoded graph flow fixture identity.');
  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Input;
  requireSafeEnvironment(input);
  const workspace = await readPostgresWorkspaceForActor({ userId: input.userId, role: input.role }, input.workspaceId);
  if (!workspace || workspace.legacy || !workspace.permissions.canRead || !workspace.permissions.canWrite
    || !workspace.permissions.canRunAgent) throw new Error('The graph flow fixture workspace is not authorized.');
  const runtime = await createRuntimeProposalAgentService({ workspace, documentId: input.documentId,
    path: input.filePath, identity: { initiatedByUserId: input.userId, actorId: 'fvrc-1006-flow-fixture' } });
  const authoritative = await runtime.service.readExact({ scope: runtime.scope, proposalId: null });
  if (authoritative.content !== BASE_TEXT || authoritative.metadata.source.kind !== 'authoritative') {
    throw new Error('The graph flow fixture document no longer matches its authored base.');
  }
  const create = async (label: string, source: ProposalSourceProofV1, search: string, replacement: string) => {
    const result = await runtime.service.create({ scope: runtime.scope, actorId: 'fvrc-1006-flow-fixture',
      idempotencyKey: `fvrc-1006-flow-${randomUUID()}`, proposal: declaration(source),
      mutation: { path: input.filePath, oldText: search, newText: replacement },
      buildTargets: (basis) => targets({ update: basis.update, representation: basis.representation, search, replacement }),
    });
    return { label, proposalId: result.node.proposalId, operationId: result.node.operationId };
  };
  const parent = await create('A', authoritative.metadata.source, 'A0', 'A1');
  const parentRead = await runtime.service.readExact({ scope: runtime.scope, proposalId: parent.proposalId });
  if (parentRead.metadata.source.kind !== 'proposal') throw new Error('The dependency source was not a proposal.');
  const chosen = await create('B1', parentRead.metadata.source, 'B0', 'B1');
  // B1 creation advances graphRevision. B2 must use a fresh evaluated proof
  // for the same immutable parent rather than reusing the stale B1 source.
  const parentReadForAlternative = await runtime.service.readExact({ scope: runtime.scope, proposalId: parent.proposalId });
  if (parentReadForAlternative.metadata.source.kind !== 'proposal'
    || parentReadForAlternative.metadata.graphRevision <= parentRead.metadata.graphRevision
    || parentReadForAlternative.content !== parentRead.content) {
    throw new Error('The alternative requires a fresh exact parent evaluation.');
  }
  const alternative = await create('B2', parentReadForAlternative.metadata.source, 'B0', 'B2');
  // Test-only choice metadata seed: FVRC-1008 has not opened agent alternative
  // authoring. Both immutable child proposals above use the real provenance
  // service; storage only groups those existing siblings for review coverage.
  const storage = createProposalGraphStorage({ database: createRuntimeFileVersionCenterDatabase() });
  const choiceGroupId = `fvrc-1006-flow-choice-${randomUUID()}`;
  await storage.withLockedGraph(runtime.scope, {}, async (graph) => {
    await graph.putChoiceGroup({ groupId: choiceGroupId, groupRevision: 0,
      dependencyProposalId: parent.proposalId, memberProposalIds: [chosen.proposalId, alternative.proposalId],
      chosenProposalId: null }, null);
  });
  process.stdout.write(`${JSON.stringify({ contractVersion: 1, scope: runtime.scope,
    proposals: [parent, chosen, alternative], choiceGroupId })}\n`);
}

void main().catch((error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code) ? error.code : 'UNKNOWN';
  process.stderr.write(`FVRC_GRAPH_FLOW_FIXTURE_CODE=${code}\n`);
  process.exitCode = 1;
}).finally(() => closeDatabaseConnections());
