import 'server-only';

import { randomUUID } from 'node:crypto';

import { closeDatabaseConnections } from '../app/lib/db';
import { createAgentTextTarget, createRichAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRuntimeProposalAgentService } from '../app/lib/file-version-center/proposal-agent-runtime';
import type { ProposalSourceProofV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { readPostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import type { WorkspaceUserRole } from '../app/lib/workspaces/types';

type Input = { userId: string; role: WorkspaceUserRole; workspaceId: string; documentId: string; filePath: string };
const PATH = /^fvrc-1006-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/iu;
const BASE_TEXT = '# Deep proposal fixture\n\nA0|B0|C0|D0|E0|F0\n';

function requireSafeEnvironment(input: Input): void {
  if (process.env.COLLABORATION_E2E !== '1') throw new Error('The deep fixture requires COLLABORATION_E2E=1.');
  let databaseUrl: URL;
  try { databaseUrl = new URL(process.env.DATABASE_URL || ''); }
  catch { throw new Error('The deep fixture requires a local DATABASE_URL.'); }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(databaseUrl.hostname) || databaseUrl.port !== '55433') {
    throw new Error('The deep fixture is restricted to the managed loopback PostgreSQL service.');
  }
  if (!PATH.test(input.filePath) || input.filePath !== input.filePath.split('/').at(-1)
    || !input.userId || !input.workspaceId || !input.documentId
    || !['owner', 'admin', 'member', 'external'].includes(input.role)) {
    throw new Error('The deep fixture identity is outside its dedicated allowlist.');
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
        expectedOccurrences: 1, groupId: `fvrc-1006-deep-${input.replacement}` });
    }
    if (input.representation !== 'plain_text') throw new Error('The deep fixture requires a supported text representation.');
    const text = doc.getText('content');
    const from = text.toString().indexOf(input.search);
    if (from < 0) throw new Error('The deep fixture target is absent from its exact source.');
    return [createAgentTextTarget({ text, from, to: from + input.search.length,
      replacement: input.replacement, groupId: `fvrc-1006-deep-${input.replacement}` })];
  } finally { doc.destroy(); }
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded || process.argv.length !== 3) throw new Error('Pass one base64url-encoded deep fixture identity.');
  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Input;
  requireSafeEnvironment(input);
  const workspace = await readPostgresWorkspaceForActor({ userId: input.userId, role: input.role }, input.workspaceId);
  if (!workspace || workspace.legacy || !workspace.permissions.canRead || !workspace.permissions.canWrite
    || !workspace.permissions.canRunAgent) throw new Error('The deep fixture workspace is not authorized.');
  const runtime = await createRuntimeProposalAgentService({ workspace, documentId: input.documentId,
    path: input.filePath, identity: { initiatedByUserId: input.userId, actorId: 'fvrc-1006-deep-fixture' } });
  const authoritative = await runtime.service.readExact({ scope: runtime.scope, proposalId: null });
  if (authoritative.content !== BASE_TEXT || authoritative.metadata.source.kind !== 'authoritative') {
    throw new Error('The deep fixture document no longer matches its authored base.');
  }
  let parentProposalId: string | null = null;
  const proposals: Array<{ label: string; proposalId: string; operationId: string; parentProposalId: string | null }> = [];
  for (const label of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const read = parentProposalId === null ? authoritative
      : await runtime.service.readExact({ scope: runtime.scope, proposalId: parentProposalId });
    const source = read.metadata.source;
    if (parentProposalId !== null && (source.kind !== 'proposal' || source.proposalId !== parentProposalId)) {
      throw new Error('The deep fixture lost its explicit prerequisite source.');
    }
    const created = await runtime.service.create({ scope: runtime.scope, actorId: 'fvrc-1006-deep-fixture',
      idempotencyKey: `fvrc-1006-deep-${randomUUID()}`, proposal: declaration(source),
      mutation: { path: input.filePath, oldText: `${label}0`, newText: `${label}1` },
      buildTargets: (basis) => targets({ update: basis.update, representation: basis.representation,
        search: `${label}0`, replacement: `${label}1` }),
    });
    if ((created.node.relationships.dependency?.proposalId ?? null) !== parentProposalId) {
      throw new Error('The deep fixture authored a different dependency than requested.');
    }
    proposals.push({ label, proposalId: created.node.proposalId, operationId: created.node.operationId,
      parentProposalId });
    parentProposalId = created.node.proposalId;
  }
  process.stdout.write(`${JSON.stringify({ contractVersion: 1, scope: runtime.scope, proposals })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'The deep fixture failed.'}\n`);
  process.exitCode = 1;
}).finally(() => closeDatabaseConnections());
