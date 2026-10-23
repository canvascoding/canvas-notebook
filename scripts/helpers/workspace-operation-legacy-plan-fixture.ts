import { createRequire } from 'node:module';
import path from 'node:path';
import type { WorkspaceOperationBatchAction, WorkspaceOperationLegacyBatchPlan } from '../../app/lib/files/workspace-operation-batch-contract';

/** Valid legacy link-plan shape from the actual pure planner. Declared fixture
 * sources only: this establishes no original request, SQL, FS or actor proof. */
export function createFixtureWorkspaceOperationLegacyLinkPlan(workspaceId: string,
  actions: WorkspaceOperationBatchAction[]): WorkspaceOperationLegacyBatchPlan['linkPlan'] {
  // Keep fixture environment setup ahead of DB/auth module initialization.
  // The static require is bundled lazily into the same real-source graph;
  // standalone ESM retains the original loader with its configured TS paths.
  const { createWorkspaceOperationBatchPlan } = (typeof require === 'function'
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep DB initialization lazy in the real-source ESM test bundle.
    ? require('../../app/lib/files/workspace-operation-batch-plan')
    : createRequire(path.resolve('package.json'))('./app/lib/files/workspace-operation-batch-plan.ts')) as typeof import('../../app/lib/files/workspace-operation-batch-plan');
  return createWorkspaceOperationBatchPlan({ snapshot: { workspaceId,
    entries: [...new Set(actions.flatMap(action => action.selections.map(selection => selection.sourcePath)))].map(path => ({
      path, kind: 'file' as const, identity: `fixture:${path}`, markdownContent: '',
    })) }, actions }).linkPlan;
}
