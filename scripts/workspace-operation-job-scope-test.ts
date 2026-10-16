import assert from 'node:assert/strict';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope,
  workspaceOperationJobScopeMatches } from '../app/lib/files/workspace-operation-job-scope';

const workspace: WorkspaceContext = {
  workspaceId: 'scope-workspace', workspaceType: 'project', organizationId: 'scope-organization', customerId: 'scope-customer',
  projectId: 'scope-project', ownerUserId: 'scope-owner', rootPath: '/isolated/ scope root ', rootRelativePath: 'projects/ scope root ',
  legacy: false, status: 'active', actor: { userId: 'scope-owner', role: 'owner' },
  permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true, canRunAgent: true, canCreatePublicLinks: false },
};
const expected = { version: 1, workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType,
  organizationId: workspace.organizationId, customerId: workspace.customerId, projectId: workspace.projectId,
  ownerUserId: workspace.ownerUserId, rootPath: workspace.rootPath, rootRelativePath: workspace.rootRelativePath, legacy: workspace.legacy };
let passed = 0;
const check = (name: string, operation: () => void) => { operation(); passed += 1; console.log(`Job scope case passed: ${name}`); };

check('capture and stored JSON preserve all ten fields, literal spelling and immutable detached values', () => {
  const input = structuredClone(workspace), captured = captureWorkspaceOperationJobScope(input);
  assert.deepEqual(captured, expected); assert(Object.isFrozen(captured)); assert.equal(Reflect.set(captured, 'rootPath', '/different'), false);
  input.rootPath = '/changed-after-capture'; input.organizationId = 'changed-after-capture';
  assert.deepEqual(captured, expected); assert.equal(workspaceOperationJobScopeMatches(captured, input), false);
  const stored = JSON.parse(JSON.stringify(captured));
  const parsed = parseWorkspaceOperationJobScope(stored); assert.deepEqual(parsed, expected); assert(Object.isFrozen(parsed));
  stored.projectId = 'changed-after-parse'; assert.deepEqual(parsed, expected);
});

check('each namespace field, including null identity, is compared independently', () => {
  const captured = captureWorkspaceOperationJobScope(workspace);
  const changes = { workspaceId: 'other', workspaceType: 'team', organizationId: null, customerId: null,
    projectId: null, ownerUserId: null, rootPath: '/other', rootRelativePath: null, legacy: true };
  for (const [key, value] of Object.entries(changes)) {
    const changed = { ...expected, [key]: value };
    assert.doesNotThrow(() => parseWorkspaceOperationJobScope(changed));
    assert.equal(workspaceOperationJobScopeMatches(changed, workspace), false, key);
  }
  assert.equal(workspaceOperationJobScopeMatches(captured, { ...workspace, status: 'archived',
    actor: { userId: 'other', role: 'external' }, permissions: { ...workspace.permissions, canRead: false, canWrite: false } }), true,
  'declared namespace equality grants no actor, ACL, lifecycle or content authority');
});

check('optional workspace values capture as explicit null while stored fields cannot be omitted or undefined', () => {
  const minimal: WorkspaceContext = { workspaceId: 'minimal', workspaceType: 'personal', rootPath: '/', legacy: true, permissions: workspace.permissions };
  const captured = captureWorkspaceOperationJobScope(minimal);
  for (const key of ['organizationId', 'customerId', 'projectId', 'ownerUserId', 'rootRelativePath'] as const) {
    assert.equal(captured[key], null);
    const missing = { ...captured } as Record<string, unknown>; delete missing[key];
    assert.throws(() => parseWorkspaceOperationJobScope(missing), TypeError);
    assert.throws(() => parseWorkspaceOperationJobScope({ ...captured, [key]: undefined }), TypeError);
  }
  assert.equal(parseWorkspaceOperationJobScope({ ...captured, rootRelativePath: '' }).rootRelativePath, '');
  assert.equal(workspaceOperationJobScopeMatches({ ...captured, rootRelativePath: '' }, minimal), false);
});

check('strict stored shape rejects unknown, inherited, symbol and accessor fields without evaluating getters', () => {
  let reads = 0;
  const getter = { ...expected }; Object.defineProperty(getter, 'rootPath', { enumerable: true, get: () => { reads += 1; throw new Error('GETTER_EVALUATED'); } });
  const hidden = { ...expected }; Object.defineProperty(hidden, 'legacy', { enumerable: false, value: false });
  for (const invalid of [undefined, null, [], 'scope', Object.create(null), Object.create(expected), getter, hidden,
    { ...expected, unexpected: true }, { ...expected, [Symbol('unknown')]: true }]) {
    assert.throws(() => parseWorkspaceOperationJobScope(invalid), TypeError);
    assert.equal(workspaceOperationJobScopeMatches(invalid, workspace), false);
  }
  assert.equal(reads, 0);
  for (const key of ['workspaceId', 'organizationId', 'rootPath', 'rootRelativePath', 'legacy']) {
    const input = { ...workspace };
    Object.defineProperty(input, key, { enumerable: true, get: () => { reads += 1; return expected[key as keyof typeof expected]; } });
    assert.throws(() => captureWorkspaceOperationJobScope(input), TypeError);
    assert.equal(workspaceOperationJobScopeMatches(expected, input), false);
  }
  assert.equal(reads, 0);
});

check('ID and path budgets reject malformed data without path or whitespace normalization', () => {
  for (const key of ['workspaceId', 'organizationId', 'customerId', 'projectId', 'ownerUserId']) {
    assert.equal(Reflect.get(parseWorkspaceOperationJobScope({ ...expected, [key]: 'x'.repeat(256) }), key), 'x'.repeat(256));
    for (const value of ['', 'x'.repeat(257), 'bad\0id', 'bad\nid', 1, false]) assert.throws(() => parseWorkspaceOperationJobScope({ ...expected, [key]: value }), TypeError);
  }
  assert.equal(parseWorkspaceOperationJobScope({ ...expected, workspaceId: ' exact id ' }).workspaceId, ' exact id ');
  assert.equal(workspaceOperationJobScopeMatches({ ...expected, workspaceId: ' scope-workspace ' }, workspace), false);
  for (const [key, values] of [
    ['rootPath', ['', 'relative', '/a/../b', '/a/./b', '//a', '/a//b', '/a\\b', '/a\0b', '/a\nb', `/${'x'.repeat(4096)}`]],
    ['rootRelativePath', ['/absolute', '../escape', './alias', 'a//b', 'a\\b', 'a\0b', 'a\nb', 'x'.repeat(4097)]],
  ] as const) for (const value of values) assert.throws(() => parseWorkspaceOperationJobScope({ ...expected, [key]: value }), TypeError);
  assert.equal(parseWorkspaceOperationJobScope({ ...expected, rootPath: `/${'x'.repeat(4095)}` }).rootPath.length, 4096);
  assert.equal(parseWorkspaceOperationJobScope({ ...expected, rootRelativePath: 'x'.repeat(4096) }).rootRelativePath?.length, 4096);
  for (const value of [0, 2, '1', null]) assert.throws(() => parseWorkspaceOperationJobScope({ ...expected, version: value }), TypeError);
  for (const value of ['admin', 'PERSONAL', null, 1]) assert.throws(() => parseWorkspaceOperationJobScope({ ...expected, workspaceType: value }), TypeError);
  for (const value of [0, 1, 'false', null]) assert.throws(() => parseWorkspaceOperationJobScope({ ...expected, legacy: value }), TypeError);
});

assert.equal(passed, 5);
console.log('workspace operation job scope: five strict immutable namespace/shape/budget families passed; no authority or filesystem claim');
