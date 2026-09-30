import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

type EditResponse = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };

function compileEdit(dependencies: Record<string, unknown>): (args: unknown) => Promise<EditResponse> {
  const source = ts.createSourceFile('workspace-tools.ts',
    readFileSync('app/lib/mcp/server/workspace-tools.ts', 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = ['editErrorResult', 'executeEditKnowledgeSource'].map((name) => {
    const found = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(found, `missing ${name}`);
    return found.getText(source);
  });
  const javascript = ts.transpileModule(declarations.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const names = Object.keys(dependencies);
  return new Function(...names, `${javascript}\nreturn executeEditKnowledgeSource;`)(...Object.values(dependencies)) as
    (args: unknown) => Promise<EditResponse>;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function harness() {
  const workspace = { workspaceId: 'workspace', permissions: { canRead: true, canWrite: true } };
  const principal = { clientId: 'client', userId: 'user', sessionId: 'session' };
  let content = 'hello old';
  let sequence = 1;
  let executionCount = 0;
  let checkpointCount = 0;
  let checkpointFailure = false;
  let recorded: null | {
    operation: { operationId: string; operationStatus: string; durability: string; appliedTargetIds: string[] };
    request: { beforeSha256: string; proposedSha256: string };
    identity: { lifecycleGeneration: number; schemaVersion: number; representation: string };
  } = null;
  const snapshot = () => ({ documentId: 'document', path: 'document.md', representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, documentSequence: sequence, checkpointSequence: 0,
    content, sha256: sha256(content), stateVector: '' });
  class ReviewDisabled extends Error { readonly code = 'DOCUMENT_REVIEW_DISABLED_CONFLICT'; }
  class CheckpointUnavailable extends Error { readonly code = 'COLLABORATION_FILE_CHECKPOINT_UNAVAILABLE'; }
  class OperationScope extends Error { constructor(readonly operation: { operationId: string }) { super('Old lifecycle'); } }
  class RevisionConflict extends Error {}
  class ExactTextConflict extends Error {}
  class GraphContract extends Error { readonly code = 'PROPOSAL_UPGRADE_REQUIRED'; }
  const errorResult = (message: string): EditResponse => ({ isError: true, content: [{ text: message }] });
  const result = (structuredContent: Record<string, unknown>, message: string): EditResponse =>
    ({ content: [{ text: message }], structuredContent });
  const dependencies: Record<string, unknown> = {
    MAX_WORKSPACE_ID_LENGTH: 200,
    MAX_PATH_LENGTH: 1024,
    MAX_EDIT_TEXT_LENGTH: 256 * 1024,
    MAX_EDIT_OCCURRENCES: 10_000,
    MAX_READ_FILE_BYTES: 512 * 1024,
    parseArgs: (args: unknown) => args,
    requiredString: (args: Record<string, string>, key: string) => args[key],
    requiredText: (args: Record<string, string>, key: string) => args[key],
    optionalBoolean: (args: Record<string, boolean>, key: string) => args[key],
    optionalInteger: (args: Record<string, number>, key: string) => args[key],
    assertVisibleWorkspacePath: () => undefined,
    normalizeExpectedSha256: (value: string) => value,
    parseDirectMcpEditIdempotencyKey: (value?: string) => value ?? null,
    invalidParams: (message: string) => { throw new Error(message); },
    authenticateForTool: async () => ({ principal }),
    writableWorkspace: async () => workspace,
    createDirectMcpEditIdentity: (input: { idempotencyKey: string | null }) => ({
      actorId: 'mcp-agent', proposalIdempotencyKey: 'proposal-key', operationIdempotencyKey: 'operation-key',
      retryRequested: input.idempotencyKey !== null, publicIdempotencyKey: input.idempotencyKey,
    }),
    buildDirectMcpDocumentUrl: () => 'https://canvas.example/notebook',
    buildDirectMcpReviewUrl: () => 'https://canvas.example/notebook?review=1',
    getFileStats: async () => ({ isFile: true, size: 9, modified: new Date(0) }),
    readFile: async () => Buffer.from('old disk'),
    isLikelyBinary: () => false,
    readDirectMcpTextContent: async () => ({ content, sha256: sha256(content), source: 'live_yjs', documentId: 'document' }),
    sha256Buffer: (buffer: Buffer) => sha256(buffer.toString('utf8')),
    applyExactTextEdits: (source: string, edits: Array<{ oldText: string; newText: string }>) =>
      source.replace(edits[0].oldText, edits[0].newText),
    validateTextFileContent: () => ({ ok: true }),
    createOrdinaryAgentProposal: async () => null,
    Y: { Doc: class {} },
    ProposalGraphContractError: GraphContract,
    readDocumentReviewAvailability: () => ({ documentReviewEnabled: false }),
    AgentFileReviewDisabledConflictError: ReviewDisabled,
    CollaborationFileCheckpointUnavailableError: CheckpointUnavailable,
    AgentFileEditOperationScopeError: OperationScope,
    WorkspaceFileRevisionError: RevisionConflict,
    ExactTextPatchError: ExactTextConflict,
    findAgentFileEditOperation: async () => recorded,
    readCurrentCollaborationTextSnapshot: async () => snapshot(),
    prepareCollaborationTextEdit: async (input: { edits: Array<{ oldText: string; newText: string }> }) => {
      const before = snapshot();
      const proposedContent = content.replace(input.edits[0].oldText, input.edits[0].newText);
      return { ...before, proposedContent, proposedSha256: sha256(proposedContent),
        requestedMode: 'direct_apply', targets: [] };
    },
    executePreparedCollaborationTextEdit: async (input: {
      prepared: { proposedContent: string; sha256: string; proposedSha256: string };
    }) => {
      executionCount++;
      content = input.prepared.proposedContent;
      sequence++;
      recorded = { operation: { operationId: 'operation-1', operationStatus: 'persisted_yjs',
        durability: 'persisted_yjs', appliedTargetIds: ['target-1'] },
      request: { beforeSha256: input.prepared.sha256, proposedSha256: input.prepared.proposedSha256 },
      identity: { lifecycleGeneration: 1, schemaVersion: 1, representation: 'plain_text' } };
      return recorded.operation;
    },
    proposalReviewWritesEnabled: () => false,
    confirmCollaborativeFileCheckpoint: async (input: { snapshot: { documentSequence: number }; path: string }) => {
      checkpointCount++;
      assert.equal(input.path, 'document.md');
      assert.equal(input.snapshot.documentSequence, sequence);
      if (checkpointFailure) throw new CheckpointUnavailable('Physical Markdown checkpoint unavailable');
      return { contentHash: sha256('different physical bytes'), sizeBytes: 777 };
    },
    validatePath: () => '/workspace/document.md',
    toIsoDate: () => '1970-01-01T00:00:00.000Z',
    auditWorkspaceToolCall: async () => undefined,
    errorResult,
    result,
  };
  const edit = compileEdit(dependencies);
  const call = (oldText: string, newText: string, expectedSha256: string) => edit({ workspace_id: 'workspace',
    path: 'document.md', old_text: oldText, new_text: newText, expected_sha256: expectedSha256,
    idempotency_key: 'stable-request' });
  return { call, currentSha: () => sha256(content), initialSha: sha256(content),
    executionCount: () => executionCount, checkpointCount: () => checkpointCount,
    failCheckpoint: () => { checkpointFailure = true; } };
}

test('MCP no-change waits for physical checkpoint but reports the live Yjs guard hash', async () => {
  const h = harness();
  const response = await h.call('old', 'old', h.initialSha);
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent?.status, 'no_change');
  assert.equal(response.structuredContent?.current_sha256, h.currentSha());
  assert.equal(h.checkpointCount(), 1);
  assert.equal(h.executionCount(), 0);
});

test('MCP applied retry with old expected hash reuses the receipt and confirms the physical checkpoint', async () => {
  const h = harness();
  const first = await h.call('old', 'new', h.initialSha);
  assert.equal(first.structuredContent?.status, 'applied');
  assert.equal(first.structuredContent?.after_sha256, h.currentSha());
  assert.notEqual(first.structuredContent?.after_sha256, sha256('different physical bytes'));
  const retry = await h.call('old', 'new', h.initialSha);
  assert.equal(retry.structuredContent?.status, 'applied');
  assert.equal(retry.structuredContent?.operation_id, 'operation-1');
  assert.equal(retry.structuredContent?.current_sha256, h.currentSha());
  assert.equal(h.executionCount(), 1);
  assert.equal(h.checkpointCount(), 2);
});

test('MCP checkpoint failure never reports the already durable edit as success', async () => {
  const h = harness();
  h.failCheckpoint();
  const response = await h.call('old', 'new', h.initialSha);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /COLLABORATION_FILE_CHECKPOINT_UNAVAILABLE/u);
  assert.equal(h.executionCount(), 1);
  assert.equal(h.checkpointCount(), 1);
});
