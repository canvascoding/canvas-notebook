import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import ts from 'typescript';

type Database = {
  get: (sql: string, params: unknown[]) => Promise<unknown>;
  run: (sql: string, params: unknown[]) => Promise<void>;
};

type Capture = (input: {
  database: Database;
  row: Record<string, unknown>;
  state: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  recovering?: boolean;
}) => Promise<void>;

/** Exercise the production recovery branch without opening its database module. */
async function loadCapture(dependencies: Record<string, unknown>): Promise<Capture> {
  const filename = path.resolve('app/lib/collaboration/agent-operations.ts');
  const source = ts.createSourceFile(filename, await fs.readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'captureDurableOperationHistory');
  assert.ok(declaration, 'the test must use the current production capture function');
  const javascript = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${javascript}\nreturn captureDurableOperationHistory;`)(
    ...Object.values(dependencies),
  ) as Capture;
}

function createScenario(options: {
  receipt?: string;
  current?: string;
  currentThrows?: boolean;
  mapped?: boolean;
  captureThrows?: boolean;
  recovering?: boolean;
  workspace?: Record<string, unknown>;
} = {}) {
  const receipt = options.receipt ?? '# Receipt\nAgent change';
  const events: string[] = [];
  const captures: Array<Record<string, unknown>> = [];
  const row = {
    operation_id: 'operation-1', document_id: 'document-1', workspace_id: 'workspace-1',
    agent_run_id: 'turn-1', actor_session_id: 'session-1', requested_mode: 'direct_apply',
    operation_type: 'apply', version_content_snapshot: gzipSync(receipt),
    initiated_by_user_id: 'user-1', base_document_sequence: 7, applied_at: 1_700_000_000_000,
  };
  const state = {
    path: 'document.md', documentSequence: 9, lifecycleGeneration: 2,
    persistedAt: 1_700_000_000_001,
  };
  const workspace = options.workspace ?? { workspaceId: row.workspace_id, permissions: { canRead: true } };
  const database: Database = {
    async get(sql, params) {
      if (sql.includes('FROM canvas_workspaces')) {
        events.push('read-workspace');
        assert.deepEqual(params, [row.workspace_id]);
        return { type: 'team', root_relative_path: 'teams/workspace-1', organization_id: 'organization-1',
          customer_id: null, project_id: null };
      }
      if (sql.includes('FROM collaboration_documents')) {
        events.push('read-lineage');
        assert.deepEqual(params, [row.document_id, row.workspace_id]);
        return { lineage_id: 'lineage-1' };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run(sql, params) {
      assert.match(sql, /SET version_content_snapshot=NULL/u);
      assert.deepEqual(params, [row.operation_id]);
      events.push('clear-receipt');
    },
  };
  const dependencies = {
    gunzipSync,
    MAX_COLLABORATIVE_TEXT_BYTES: 5 * 1024 * 1024,
    agentTurnHistoryService: { async hasOperation(input: Record<string, unknown>) {
      events.push('check-mapping');
      assert.deepEqual(input, { operationId: row.operation_id, turnId: row.agent_run_id,
        workspaceId: row.workspace_id });
      return options.mapped ?? false;
    } },
    authoritativeCollaborationSnapshot: () => {
      events.push('read-current');
      if (options.currentThrows) throw new Error('The later canonical document cannot be exported');
      return { canonicalContent: options.current ?? receipt };
    },
    workspaceAbsoluteRoot: (relative: string) => `/data/${relative}`,
    parseResult: () => ({ stateVector: 'durable-vector' }),
    fileVersionHistoryService: {
      async capture(input: Record<string, unknown>) {
        events.push('capture');
        if (options.captureThrows) throw new Error('History store unavailable');
        captures.push(input);
      },
      async capturePersistedCollaboration() { throw new Error('Grouped receipt must use exact snapshot capture'); },
    },
  };
  return { row, state, workspace, database, dependencies, captures, events,
    input: { database, row, state, workspace: options.recovering ? undefined : workspace,
      recovering: options.recovering } };
}

test('historical receipt is captured exactly when the current document changed or cannot export', async (t) => {
  for (const variant of ['later-content', 'unreadable-current'] as const) await t.test(variant, async () => {
    const scenario = createScenario(variant === 'later-content'
      ? { current: '# Later\nHuman change' }
      : { currentThrows: true });
    const capture = await loadCapture(scenario.dependencies);
    await capture(scenario.input);
    assert.equal(scenario.captures.length, 1);
    assert.deepEqual(scenario.captures[0].content, Buffer.from('# Receipt\nAgent change'));
    assert.equal(scenario.captures[0].historicalLineageId, 'lineage-1');
    assert.equal(scenario.captures[0].agentOperationId, scenario.row.operation_id);
    assert.equal(scenario.captures[0].agentTurnId, scenario.row.agent_run_id);
    assert.equal(scenario.captures[0].agentRecovered, true);
    assert.ok(scenario.events.indexOf('capture') < scenario.events.indexOf('clear-receipt'),
      'the compressed operation receipt is cleared only after durable history capture');
  });
});

test('failed history capture retains the exact receipt for restart recovery', async () => {
  const scenario = createScenario({ current: 'Later content', captureThrows: true });
  const capture = await loadCapture(scenario.dependencies);
  await assert.rejects(capture(scenario.input), /History store unavailable/u);
  assert.equal(scenario.captures.length, 0);
  assert.equal(scenario.events.includes('clear-receipt'), false);
  assert.deepEqual(gunzipSync(scenario.row.version_content_snapshot), Buffer.from('# Receipt\nAgent change'));
});

test('already mapped operation does not stage a duplicate snapshot', async () => {
  const scenario = createScenario({ mapped: true });
  const capture = await loadCapture(scenario.dependencies);
  await capture(scenario.input);
  assert.deepEqual(scenario.events, ['check-mapping', 'clear-receipt']);
  assert.equal(scenario.captures.length, 0);
});

test('restart recovery constructs a read-only workspace from its database scope', async () => {
  const scenario = createScenario({ recovering: true });
  const capture = await loadCapture(scenario.dependencies);
  await capture(scenario.input);
  assert.equal(scenario.captures.length, 1);
  const recoveredWorkspace = scenario.captures[0].workspace as Record<string, unknown>;
  assert.equal(recoveredWorkspace.workspaceId, 'workspace-1');
  assert.equal(recoveredWorkspace.rootPath, '/data/teams/workspace-1');
  assert.deepEqual(recoveredWorkspace.permissions, {
    canRead: true, canWrite: false, canDelete: false, canCreatePublicLinks: false,
    canManageWorkspace: false, canRunAgent: false,
  });
  assert.equal(scenario.captures[0].agentRecovered, true);
  assert.ok(scenario.events.indexOf('read-workspace') < scenario.events.indexOf('capture'));
});
