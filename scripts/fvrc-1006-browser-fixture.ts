import 'server-only';

import { randomUUID } from 'node:crypto';

import { closeDatabaseConnections } from '../app/lib/db';
import { createAgentTextTarget, createRichAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRuntimeProposalAgentService } from '../app/lib/file-version-center/proposal-agent-runtime';
import type { ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { readPostgresWorkspaceForActor } from '../app/lib/workspaces/postgres-runtime';
import type { WorkspaceUserRole } from '../app/lib/workspaces/types';

type FixtureInput = {
  scenario: 'conflict' | 'same-effect' | 'owner-pair' | 'batch' | 'large-batch' | 'append-late';
  userId: string;
  role: WorkspaceUserRole;
  workspaceId: string;
  documentId: string;
  filePath: string;
};

const FIXTURE_PATH = /^fvrc-1006-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/iu;
const CONFLICT_BASE_TEXT = '# Proposal review fixture\n\nPlan: 100 USD.\n';
const BATCH_BASE_TEXT = '# Proposal batch fixture\n\nA0|B0|C0|D0|E0|F0|G0|H0|I0|J0\n';
const LARGE_BATCH_BASE_TEXT = `# Proposal paginated fixture\n\n${Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}0`).join('|')}|LATE_PENDING\n`;

function requireSafeEnvironment(input: FixtureInput): void {
  if (process.env.COLLABORATION_E2E !== '1') throw new Error('FVRC-1006 fixture requires COLLABORATION_E2E=1.');
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error('FVRC-1006 fixture requires a local DATABASE_URL.');
  let databaseUrl: URL;
  try { databaseUrl = new URL(rawDatabaseUrl); } catch { throw new Error('FVRC-1006 fixture DATABASE_URL is invalid.'); }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(databaseUrl.hostname) || databaseUrl.port !== '55433') {
    throw new Error('FVRC-1006 fixture is restricted to the managed loopback PostgreSQL service on port 55433.');
  }
  if (!FIXTURE_PATH.test(input.filePath) || input.filePath !== input.filePath.split('/').at(-1)) {
    throw new Error('FVRC-1006 fixture path is outside its dedicated filename allowlist.');
  }
  if (!input.userId || !input.workspaceId || !input.documentId || !['owner', 'admin', 'member', 'external'].includes(input.role)
    || !['conflict', 'same-effect', 'owner-pair', 'batch', 'large-batch', 'append-late'].includes(input.scenario)) {
    throw new Error('FVRC-1006 fixture identity is incomplete.');
  }
}

function edit(source: ProposalToolEditV1['source']): ProposalToolEditV1 {
  if (source.kind !== 'authoritative') throw new Error('The fixture must author both proposals from the exact authoritative document read.');
  return {
    contractVersion: 1,
    creationKind: 'independent',
    source,
    expectedParentCandidateHash: null,
    expectedParentCasVersion: null,
    replaces: null,
    choice: null,
  };
}

async function buildTargets(input: {
  update: Uint8Array;
  representation: string;
  search: string;
  replacement: string;
}): Promise<ReturnType<typeof createAgentTextTarget>[]> {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, input.update);
    if (input.representation === 'tiptap_xml' || input.representation === 'tiptap_blocks') {
      return createRichAgentTextTargets({ doc, search: input.search, replacement: input.replacement,
        expectedOccurrences: 1, groupId: `fvrc-1006-${input.replacement}` });
    }
    if (input.representation !== 'plain_text') throw new Error('FVRC-1006 fixture requires a supported text representation.');
    const text = doc.getText('content');
    const from = text.toString().indexOf(input.search);
    if (from < 0) throw new Error('FVRC-1006 source text was not found in the exact Yjs source.');
    return [createAgentTextTarget({ text, from, to: from + input.search.length,
      replacement: input.replacement, groupId: `fvrc-1006-${input.replacement}` })];
  } finally {
    doc.destroy();
  }
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded || process.argv.length !== 3) throw new Error('Pass one base64url-encoded FVRC-1006 fixture identity.');
  const input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as FixtureInput;
  requireSafeEnvironment(input);
  const workspace = await readPostgresWorkspaceForActor({ userId: input.userId, role: input.role }, input.workspaceId);
  if (!workspace || workspace.legacy || !workspace.permissions.canRead || !workspace.permissions.canWrite
    || !workspace.permissions.canRunAgent) throw new Error('FVRC-1006 fixture workspace is not authorized for proposal authoring.');
  const runtime = await createRuntimeProposalAgentService({ workspace, documentId: input.documentId,
    path: input.filePath, identity: { initiatedByUserId: input.userId, actorId: 'fvrc-1006-browser-fixture' } });
  const authoritative = await runtime.service.readExact({ scope: runtime.scope, proposalId: null });
  const baseText = input.scenario === 'conflict' || input.scenario === 'same-effect' || input.scenario === 'owner-pair' ? CONFLICT_BASE_TEXT
    : input.scenario === 'large-batch' || input.scenario === 'append-late' ? LARGE_BATCH_BASE_TEXT : BATCH_BASE_TEXT;
  if (authoritative.content !== baseText || authoritative.metadata.source.kind !== 'authoritative') {
    throw new Error('FVRC-1006 fixture document no longer matches its authored base.');
  }

  const create = async (proposalLabel: string, search: string, replacement: string) => runtime.service.create({
    scope: runtime.scope,
    actorId: 'fvrc-1006-browser-fixture',
    idempotencyKey: `fvrc-1006-${randomUUID()}`,
    proposal: edit(authoritative.metadata.source),
    mutation: { path: input.filePath, oldText: search, newText: replacement },
    buildTargets: (source) => buildTargets({ update: source.update, representation: source.representation,
      search, replacement }),
  }).then((created) => ({ label: proposalLabel, proposalId: created.node.proposalId,
    operationId: created.node.operationId, candidateHash: created.node.authoredCandidate.cumulativeCandidate.sha256 }));

  const proposals: Array<{ label: string; proposalId: string; operationId: string; candidateHash: string }> = [];
  if (input.scenario === 'conflict') {
    proposals.push(await create('B', '100', '120'), await create('C', '100', '130'));
  } else if (input.scenario === 'same-effect') {
    proposals.push(await create('B', '100', '120'), await create('C', '100', '120'));
  } else if (input.scenario === 'owner-pair') {
    proposals.push(await create('D', '100', '140'), await create('E', '100', '150'));
  } else if (input.scenario === 'batch') {
    for (let index = 0; index < 10; index += 1) {
      const letter = String.fromCharCode('A'.charCodeAt(0) + index);
      proposals.push(await create(letter, `${letter}0`, `${letter}1`));
    }
  } else if (input.scenario === 'large-batch') {
    for (let index = 0; index < 26; index += 1) {
      const letter = String.fromCharCode('A'.charCodeAt(0) + index);
      proposals.push(await create(letter, `${letter}0`, `${letter}1`));
    }
  } else {
    proposals.push(await create('LATE', 'LATE_PENDING', 'LATE_APPLIED'));
  }
  process.stdout.write(`${JSON.stringify({ contractVersion: 1, scope: runtime.scope, proposals })}\n`);
}

void main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'FVRC-1006 fixture failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabaseConnections());
