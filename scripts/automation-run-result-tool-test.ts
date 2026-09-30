import assert from 'node:assert/strict';
import Module from 'node:module';

import { estimateTextTokens } from '../app/lib/pi/history-budget';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
const audits: Record<string, unknown>[] = [];
const context = { userId: 'owner', sessionId: 'session', agentId: 'canvas-agent',
  workspaceId: 'workspace', workspaceType: 'personal', organizationId: 'org' };
const job = { id: 'job', deletedAt: null, status: 'active', integrityStatus: 'valid',
  agentId: 'canvas-agent', jobScope: 'personal:owner:workspace', scope: 'personal',
  organizationId: 'org', workspaceId: 'workspace', workspaceType: 'personal',
  ownerUserId: 'owner' as string | null, responsibleUserId: 'owner', createdByUserId: 'owner', serviceActorId: null,
  sourceJobIds: ['source'] };
const run = { id: 'run', jobId: 'job', status: 'running', piSessionId: 'session',
  agentId: 'canvas-agent', jobScope: job.jobScope, scope: job.scope,
  organizationId: 'org', workspaceId: 'workspace', workspaceType: 'personal',
  actorType: 'user', actorUserId: 'owner', serviceActorId: null };
const previous = { sourceRunId: 'own-previous', finishedAt: '2026-09-28T10:00:00.000Z',
  resultText: 'Own result', reason: null };
const sources = [{ sourceJobId: 'source', sourceJobName: 'Source', sourceRunId: 'source-previous',
  finishedAt: '2026-09-28T09:00:00.000Z', resultText: 'Configured source result', reason: null as string | null }];
let workspaceGranted = true;
let jobGranted = true;
let auditAvailable = true;
let auditReturnsNull = false;
let finishWhileReading = false;
let revokeSourceAfterFirstRead = false;

internals._load = (request, parent, isMain) => {
  if (parent?.filename.endsWith('/pi/automation-run-result-tool.ts')) {
    if (request === '@/app/lib/automations/store') return {
      getAutomationJob: async () => job,
      getAutomationRun: async () => run,
      getAutomationPreviousRelevantResult: async () => {
        if (finishWhileReading) run.status = 'success';
        return previous;
      },
      getAutomationSourceResults: async () => {
        const snapshot = sources.map((item) => ({ ...item }));
        if (revokeSourceAfterFirstRead) {
          sources[0].reason = 'source_scope_changed';
          revokeSourceAfterFirstRead = false;
        }
        return snapshot;
      },
    };
    if (request === '@/app/lib/automations/policy') return {
      canAccessAutomationJob: async () => jobGranted,
    };
    if (request === '@/app/lib/pi/agent-execution-context') return {
      getAgentExecutionContext: () => context,
    };
    if (request === '@/app/lib/pi/session-workspace-context') return {
      resolveAgentSessionWorkspaceForUser: async () => {
        if (!workspaceGranted) throw new Error('Revoked workspace');
        return {};
      },
    };
    if (request === '@/app/lib/audit/audit-service') return {
      recordAuditEvent: async (event: Record<string, unknown>) => {
        if (!auditAvailable) throw new Error('Audit unavailable');
        if (auditReturnsNull) return null;
        audits.push(event);
        return { id: 'audit', createdAt: new Date() };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  try {
    const { createAutomationRunResultTool } = await import('../app/lib/pi/automation-run-result-tool');
    const tool = createAutomationRunResultTool({ jobId: 'job', runId: 'run' });
    const invoke = async (params: Record<string, unknown>) => {
      const output = await tool.execute('read-result', params);
      const first = output.content[0];
      assert.ok(first?.type === 'text');
      return { raw: first.text, data: JSON.parse(first.text) as Record<string, unknown> };
    };

    const own = await invoke({ source: 'self' });
    assert.equal(own.data.sourceRunId, 'own-previous');
    assert.equal(own.data.resultText, 'Own result');
    assert.equal(JSON.stringify(audits[0]).includes('Own result'), false, 'audit must not store result content');
    const configured = await invoke({ source: 'configured', sourceJobId: 'source' });
    assert.equal(configured.data.sourceRunId, 'source-previous');
    assert.equal(configured.data.resultText, 'Configured source result');
    assert.equal((await invoke({ source: 'configured', sourceJobId: 'other' })).data.error, 'SOURCE_UNAVAILABLE');
    assert.equal((await invoke({ source: 'self', jobId: 'other' })).data.error, 'INVALID_INPUT');

    workspaceGranted = false;
    assert.equal((await invoke({ source: 'self' })).data.error, 'ACCESS_DENIED');
    workspaceGranted = true;
    jobGranted = false;
    assert.equal((await invoke({ source: 'self' })).data.error, 'ACCESS_DENIED');
    jobGranted = true;
    run.status = 'success';
    assert.equal((await invoke({ source: 'self' })).data.error, 'RUN_UNAVAILABLE');
    run.status = 'running';
    finishWhileReading = true;
    assert.equal((await invoke({ source: 'self' })).data.error, 'RUN_UNAVAILABLE');
    finishWhileReading = false;
    run.status = 'running';

    job.sourceJobIds = [];
    assert.equal((await invoke({ source: 'configured', sourceJobId: 'source' })).data.error, 'SOURCE_UNAVAILABLE');
    job.sourceJobIds = ['source'];
    sources[0].reason = 'source_scope_changed';
    assert.equal((await invoke({ source: 'configured', sourceJobId: 'source' })).data.error, 'SOURCE_UNAVAILABLE');
    sources[0].reason = null;
    revokeSourceAfterFirstRead = true;
    assert.equal((await invoke({ source: 'configured', sourceJobId: 'source' })).data.error, 'SOURCE_UNAVAILABLE',
      'source revocation during the call must prevent disclosure');
    sources[0].reason = null;

    previous.resultText = '🧭 Long result '.repeat(5_000);
    const large = await invoke({ source: 'self' });
    assert.equal(large.data.truncated, true);
    assert.ok(String(large.data.resultText).endsWith('[Automation result truncated]'));
    assert.ok(Buffer.byteLength(large.raw, 'utf8') <= 8 * 1024);
    assert.ok(estimateTextTokens(large.raw) <= 2_048);

    // Organization runs may use a persisted null service actor, or an explicit
    // user actor. Both remain bound to the runner's responsible user.
    job.scope = 'organization';
    job.jobScope = 'organization:org:workspace';
    job.ownerUserId = null;
    run.scope = 'organization';
    run.jobScope = job.jobScope;
    run.actorType = 'service';
    run.serviceActorId = null;
    context.workspaceType = 'organization';
    job.workspaceType = 'organization';
    run.workspaceType = 'organization';
    previous.resultText = 'Organization result';
    assert.equal((await invoke({ source: 'self' })).data.resultText, 'Organization result');
    run.actorType = 'user';
    assert.equal((await invoke({ source: 'self' })).data.resultText, 'Organization result');
    run.actorUserId = 'other-user';
    assert.equal((await invoke({ source: 'self' })).data.error, 'ACCESS_DENIED');
    run.actorUserId = 'owner';
    auditReturnsNull = true;
    assert.equal((await invoke({ source: 'self' })).data.error, 'UNAVAILABLE',
      'a null audit receipt must not release unaudited content');
    auditReturnsNull = false;
    auditAvailable = false;
    assert.equal((await invoke({ source: 'self' })).data.error, 'UNAVAILABLE',
      'a failed audit must not release unaudited content');
  } finally {
    internals._load = originalLoad;
  }
}

main().then(() => console.log('automation-run-result-tool-test: ok')).catch((error) => {
  internals._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
