import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

type ProposalModule = typeof import('../app/lib/file-version-center/ordinary-agent-proposal');

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports },
    exports,
  );
  return exports as T;
}

async function harness() {
  const controls = {
    centerEnabled: true,
    graphEnabled: true,
    potentialRetry: false,
    policyMode: 'safe_direct',
    policyLocked: false,
    existing: false,
    runtimeCalls: 0,
    createCalls: [] as Array<Record<string, unknown>>,
    buildCalls: 0,
  };
  const state = { documentId: 'document-1', representation: 'plain_text' };
  const source = { content: 'before', structure: null, update: new Uint8Array([1]), representation: 'plain_text' };
  const existingResult = {
    node: { proposalId: 'proposal-1', operationId: 'operation-1' },
    proposal: { proposalId: 'proposal-1', operationId: 'operation-1' },
    reused: true,
    authoringPreview: { beforeContent: 'before', proposedContent: 'after', beforeSha256: 'a', proposedSha256: 'b' },
  };
  const proposalModule = await compile<ProposalModule>('app/lib/file-version-center/ordinary-agent-proposal.ts', {
    'server-only': {},
    '@/app/lib/document-review-availability': {
      readDocumentReviewAvailability: () => ({ documentReviewEnabled: controls.centerEnabled, updatedAt: null }),
    },
    './proposal-review-capability': {
      proposalReviewWritesEnabled: () => controls.graphEnabled,
    },
    './proposal-agent-runtime': {
      hasPotentialProposalAgentRetryKey: async () => controls.potentialRetry,
      createRuntimeProposalAgentService: async () => {
        controls.runtimeCalls += 1;
        return {
          scope: { workspaceId: 'workspace-1' },
          state,
          service: {
            createIndependent: async (input: Record<string, unknown> & {
              allowCreate: boolean;
              buildTargets(value: typeof source): Promise<unknown> | unknown;
            }) => {
              controls.createCalls.push(input);
              if (controls.existing) return existingResult;
              if (!input.allowCreate) return null;
              await input.buildTargets(source);
              return { ...existingResult, reused: false };
            },
          },
        };
      },
    },
    './agent-review-policy-adapter': {
      readAgentReviewPolicySnapshot: async () => ({
        policy: {
          effectiveMode: controls.policyMode,
          locked: controls.policyLocked,
        },
      }),
    },
  });
  const run = (options: { retryRequested?: boolean; lookupOnly?: boolean; forceReview?: boolean } = {}) =>
    proposalModule.createOrdinaryAgentProposal({
      workspace: { workspaceId: 'workspace-1' } as never,
      documentId: 'document-1',
      path: 'notes.md',
      identity: { initiatedByUserId: 'user-1', actorId: 'direct-mcp:actor' },
      idempotencyKey: 'direct-mcp-review:1234567890abcdef',
      retryRequested: options.retryRequested ?? false,
      lookupOnly: options.lookupOnly,
      forceReview: options.forceReview,
      mutation: { operation: 'edit' },
      buildTargets: ({ state: actualState, source: actualSource }) => {
        controls.buildCalls += 1;
        assert.equal(actualState, state);
        assert.equal(actualSource, source);
        return [];
      },
    });
  return { controls, run };
}

test('rollout-off calls stay on the existing path unless an exact proposal retry can exist', async () => {
  const h = await harness();
  h.controls.graphEnabled = false;
  assert.equal(await h.run(), null);
  assert.equal(h.controls.runtimeCalls, 0);
  assert.equal(await h.run({ retryRequested: true }), null);
  assert.equal(h.controls.runtimeCalls, 0);
});

test('center-off preserves an old proposal and reports a typed disabled retry', async () => {
  const h = await harness();
  h.controls.centerEnabled = false;
  h.controls.potentialRetry = true;
  assert.equal(await h.run(), null);
  await assert.rejects(h.run({ retryRequested: true }), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'code' in error);
    assert.equal(error.code, 'PROPOSAL_UPGRADE_REQUIRED');
    assert.match(String(error), /Document Review Center is disabled/u);
    return true;
  });
  assert.equal(h.controls.runtimeCalls, 0, 'disabled retries never reach mutation or candidate building');
});

test('safe-direct policy does not create a proposal', async () => {
  const h = await harness();
  assert.equal(await h.run(), null);
  assert.equal(h.controls.runtimeCalls, 1);
  assert.equal(h.controls.createCalls[0].allowCreate, false);
  assert.equal(h.controls.buildCalls, 0);
});

test('review policy and structural force-review create through the same target builder', async () => {
  const policy = await harness();
  policy.controls.policyMode = 'review_required';
  assert.equal((await policy.run())?.reused, false);
  assert.equal(policy.controls.createCalls[0].allowCreate, true);
  assert.equal(policy.controls.buildCalls, 1);

  const structural = await harness();
  assert.equal((await structural.run({ forceReview: true }))?.reused, false);
  assert.equal(structural.controls.createCalls[0].allowCreate, true);
  assert.equal(structural.controls.buildCalls, 1);
});

test('lookup-only returns an exact existing receipt without rebuilding candidate content', async () => {
  const h = await harness();
  h.controls.existing = true;
  const result = await h.run({ retryRequested: true, lookupOnly: true });
  assert.equal(result?.reused, true);
  assert.equal(h.controls.createCalls[0].allowCreate, false);
  assert.equal(h.controls.buildCalls, 0);
});
