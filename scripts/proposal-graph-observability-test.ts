import assert from 'node:assert/strict';
import {
  PROPOSAL_GRAPH_ERROR_CODES,
  type ProposalGraphErrorCode,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import {
  observeProposalGraph,
  setFileVersionCenterMetricAdapter,
  type ProposalGraphObservation,
} from '../app/lib/file-version-center/observability';

async function main(): Promise<void> {
  const logs: string[] = [];
  const metrics: Array<{ name: string; value?: number; labels: Readonly<Record<string, string>> }> = [];
  const priorInfo = console.info;
  console.info = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  setFileVersionCenterMetricAdapter({
    increment: (name, labels) => { metrics.push({ name, labels }); },
    observe: (name, value, labels) => { metrics.push({ name, value, labels }); },
  });

  try {
    const observationWithUntrustedFields = {
      phase: 'evaluation',
      outcome: 'clean_rebased',
      reasonCode: PROPOSAL_GRAPH_ERROR_CODES.currentChanged,
      startedAt: Date.now() + 1_000,
      selectionCount: -4,
      closureCount: Number.POSITIVE_INFINITY,
      applyCount: Number.MAX_SAFE_INTEGER + 10,
      workspaceId: 'private-workspace-id',
      path: '/private/document.md',
      text: 'sensitive document content',
      hash: 'private-hash',
    } as unknown as ProposalGraphObservation;

    observeProposalGraph(observationWithUntrustedFields);
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), [
      'applyCount', 'component', 'durationMs', 'outcome', 'phase', 'reasonCode', 'selectionCount', 'version',
    ]);
    assert.deepEqual(event, {
      component: 'proposal_graph',
      version: 1,
      phase: 'evaluation',
      outcome: 'clean_rebased',
      durationMs: 0,
      reasonCode: PROPOSAL_GRAPH_ERROR_CODES.currentChanged,
      selectionCount: 0,
      applyCount: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(metrics.length, 2);
    assert.ok(metrics.some((metric) => metric.name === 'proposal_graph_operations_total'));
    assert.ok(metrics.some((metric) => metric.name === 'proposal_graph_operation_duration_ms'));
    for (const metric of metrics) {
      assert.deepEqual(Object.keys(metric.labels).sort(), ['outcome', 'phase', 'reasonCode']);
      assert.equal(metric.labels.phase, 'evaluation');
      assert.equal(metric.labels.outcome, 'clean_rebased');
    }
    assert.doesNotMatch(JSON.stringify({ logs, metrics }), /private-workspace-id|private\/document|sensitive document|private-hash/iu);

    logs.length = 0;
    metrics.length = 0;
    observeProposalGraph({
      phase: 'recovery',
      outcome: 'pending',
      reasonCode: 'UNRECOGNIZED_SECRET' as ProposalGraphErrorCode,
    });
    const sanitized = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    assert.equal(sanitized.reasonCode, undefined);
    assert.deepEqual(Object.keys(metrics[0]?.labels ?? {}).sort(), ['outcome', 'phase']);

    logs.length = 0;
    metrics.length = 0;
    observeProposalGraph({ phase: 'private-phase' as ProposalGraphObservation['phase'], outcome: 'failed' });
    observeProposalGraph({ phase: 'apply', outcome: 'private-outcome' as ProposalGraphObservation['outcome'] });
    assert.equal(logs.length, 0);
    assert.equal(metrics.length, 0);

    setFileVersionCenterMetricAdapter({
      increment: () => { throw new Error('metric backend must not escape'); },
      observe: () => { throw new Error('metric backend must not escape'); },
    });
    assert.doesNotThrow(() => observeProposalGraph({ phase: 'apply', outcome: 'failed' }));

    console.info = () => { throw new Error('logger must not escape'); };
    setFileVersionCenterMetricAdapter(undefined);
    assert.doesNotThrow(() => observeProposalGraph({ phase: 'recovery', outcome: 'succeeded' }));
  } finally {
    setFileVersionCenterMetricAdapter(undefined);
    console.info = priorInfo;
  }
}

void main().then(() => console.log('proposal-graph-observability-test: ok'));
