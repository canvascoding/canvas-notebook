import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { captureWorkspaceOperationCopyOrigin, decodeWorkspaceOperationCopyOrigin,
  assertWorkspaceOperationCopyOriginCurrent, WorkspaceOperationCopyOriginError,
  type WorkspaceOperationCopyActor, type WorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';

// Pure historical data tests only. Declared workspace/actor DTOs are neither a
// genuine request/Agent invocation nor current membership or mutation rights.
type MutableData<T> = T extends readonly (infer Item)[] ? MutableData<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: MutableData<T[Key]> } : T;
function copyOriginFixture(type: 'user' | 'agent' = 'user', sessionId: string | null = 'original-session') {
  const workspace = (workspaceId: string): WorkspaceContext => ({ workspaceId, workspaceType: 'personal',
    rootPath: `/fixture/${workspaceId}`, rootRelativePath: `users/test/${workspaceId}`, organizationId: null,
    customerId: null, projectId: null, ownerUserId: 'initiating-user', legacy: false, status: 'active',
    actor: { userId: 'initiating-user', role: 'owner' },
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } });
  const actor: MutableData<WorkspaceOperationCopyActor> = { type, userId: 'initiating-user',
    actorId: type === 'user' ? 'initiating-user' : 'actual-agent', sessionId };
  return { actor, sourceWorkspace: workspace('source-workspace'), destinationWorkspace: workspace('destination-workspace') };
}
function copyOriginInvalid(code: WorkspaceOperationCopyOriginError['code'] = 'COPY_ORIGIN_INVALID') {
  return (error: unknown) => error instanceof WorkspaceOperationCopyOriginError && error.code === code && error.status === 409;
}
function copyOriginData(origin = captureWorkspaceOperationCopyOrigin(copyOriginFixture())): MutableData<WorkspaceOperationCopyOrigin> {
  return JSON.parse(JSON.stringify(origin)) as MutableData<WorkspaceOperationCopyOrigin>;
}
function copyOriginFrozen(value: unknown): void {
  if (value && typeof value === 'object') {
    assert(Object.isFrozen(value)); for (const child of Object.values(value)) copyOriginFrozen(child);
  }
}

for (const type of ['user', 'agent'] as const) for (const sessionId of ['original-session', null]) {
  test(`${type} with ${sessionId === null ? 'explicit null' : 'original'} session retains exact primitive history`, () => {
    const input = copyOriginFixture(type, sessionId), before = structuredClone(input);
    const origin = captureWorkspaceOperationCopyOrigin(input);
    assert.deepEqual(origin, { version: 1, actor: input.actor, sourceScope: captureWorkspaceOperationJobScope(input.sourceWorkspace),
      destinationScope: captureWorkspaceOperationJobScope(input.destinationWorkspace) });
    assert.deepEqual(decodeWorkspaceOperationCopyOrigin(JSON.parse(JSON.stringify(origin))), origin);
    assert.equal(origin.actor.sessionId, sessionId); assert.equal(origin.actor.type, type);
    assert.deepEqual(input, before); assert.notEqual(origin.actor, input.actor);
    assert.notEqual(origin.sourceScope, input.sourceWorkspace); copyOriginFrozen(origin);
  });
}

for (const type of ['user', 'agent'] as const) {
  test(`${type} Current accepts a new session and returns frozen original session facts`, () => {
    for (const [originalSession, currentSession] of [['original', 'current'], [null, 'current'], ['original', null]] as const) {
      const original = captureWorkspaceOperationCopyOrigin(copyOriginFixture(type, originalSession));
      const current = captureWorkspaceOperationCopyOrigin(copyOriginFixture(type, currentSession));
      const before = structuredClone(current), result = assertWorkspaceOperationCopyOriginCurrent(original, current);
      assert.deepEqual(result, original); assert.notEqual(result, original); assert.notEqual(result.actor, original.actor);
      assert.equal(result.actor.sessionId, originalSession); assert.equal(current.actor.sessionId, currentSession);
      assert.deepEqual(current, before); copyOriginFrozen(result);
    }
  });
}

test('Capture and decode retain no caller references at any historical DTO boundary', () => {
  const input = copyOriginFixture('agent'), origin = captureWorkspaceOperationCopyOrigin(input), expected = structuredClone(origin);
  input.actor.actorId = 'later-agent'; input.actor.sessionId = 'later-session';
  input.sourceWorkspace.rootPath = '/later/source'; input.destinationWorkspace.ownerUserId = 'later-owner';
  assert.deepEqual(origin, expected);
  const dto = copyOriginData(origin), decoded = decodeWorkspaceOperationCopyOrigin(dto);
  dto.actor.userId = 'changed'; dto.sourceScope.rootRelativePath = 'other/root'; dto.destinationScope.workspaceId = 'other';
  assert.deepEqual(decoded, expected); copyOriginFrozen(decoded);
  assert.throws(() => Object.assign(decoded.actor, { actorId: 'changed' }), TypeError);
});

test('Current checks user, actor type and agent identity independently from session spelling', () => {
  const original = captureWorkspaceOperationCopyOrigin(copyOriginFixture('agent'));
  for (const change of [
    (value: MutableData<WorkspaceOperationCopyOrigin>) => { value.actor.userId = 'another-user'; },
    (value: MutableData<WorkspaceOperationCopyOrigin>) => { value.actor.actorId = 'another-agent'; },
    (value: MutableData<WorkspaceOperationCopyOrigin>) => { value.actor.type = 'user'; value.actor.actorId = value.actor.userId; },
  ]) {
    const current = copyOriginData(original); change(current);
    assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(original, current), copyOriginInvalid('COPY_ORIGIN_CHANGED'));
  }
  const user = captureWorkspaceOperationCopyOrigin(copyOriginFixture());
  assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(user, original), copyOriginInvalid('COPY_ORIGIN_CHANGED'));
  const invalidCurrent = copyOriginData(user); invalidCurrent.actor.actorId = 'different-user';
  assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(user, invalidCurrent), copyOriginInvalid());
});

test('Current compares every scope field on source and destination without case/path normalization', () => {
  const original = captureWorkspaceOperationCopyOrigin(copyOriginFixture());
  const changes = { workspaceId: 'another-workspace', workspaceType: 'team', organizationId: 'another-organization',
    customerId: 'another-customer', projectId: 'another-project', ownerUserId: 'another-owner', rootPath: '/Fixture/source-workspace',
    rootRelativePath: 'users/Test/source-workspace', legacy: true } as const;
  for (const side of ['sourceScope', 'destinationScope'] as const) for (const [key, value] of Object.entries(changes)) {
    const current = copyOriginData(original); Object.assign(current[side], { [key]: value });
    assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(original, current), copyOriginInvalid('COPY_ORIGIN_CHANGED'), `${side}.${key}`);
  }
  const swapped = copyOriginData(original);
  [swapped.sourceScope, swapped.destinationScope] = [swapped.destinationScope, swapped.sourceScope];
  assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(original, swapped), copyOriginInvalid('COPY_ORIGIN_CHANGED'));
});

test('same workspace requires identical scope facts while independent workspaces retain separate scopes', () => {
  const input = copyOriginFixture(); input.destinationWorkspace = structuredClone(input.sourceWorkspace);
  const origin = captureWorkspaceOperationCopyOrigin(input); assert.deepEqual(origin.sourceScope, origin.destinationScope);
  const inconsistent = copyOriginData(origin); inconsistent.destinationScope.rootPath = '/fixture/other-root';
  assert.throws(() => decodeWorkspaceOperationCopyOrigin(inconsistent), copyOriginInvalid());
  input.destinationWorkspace.ownerUserId = 'different-owner';
  assert.throws(() => captureWorkspaceOperationCopyOrigin(input), copyOriginInvalid());
  const cross = captureWorkspaceOperationCopyOrigin(copyOriginFixture());
  assert.notEqual(cross.sourceScope.workspaceId, cross.destinationScope.workspaceId);
  assert.notEqual(cross.sourceScope.rootPath, cross.destinationScope.rootPath);
});

test('absent optional workspace scope fields normalize only through the original JobScope contract', () => {
  const input = copyOriginFixture(); delete input.sourceWorkspace.organizationId; delete input.sourceWorkspace.customerId;
  delete input.sourceWorkspace.projectId; delete input.sourceWorkspace.ownerUserId; delete input.sourceWorkspace.rootRelativePath;
  input.sourceWorkspace.legacy = true;
  const origin = captureWorkspaceOperationCopyOrigin(input);
  assert.equal(origin.sourceScope.organizationId, null); assert.equal(origin.sourceScope.customerId, null);
  assert.equal(origin.sourceScope.projectId, null); assert.equal(origin.sourceScope.ownerUserId, null);
  assert.equal(origin.sourceScope.rootRelativePath, null); assert.equal(origin.sourceScope.legacy, true);
  const missing = copyOriginData(origin); Reflect.deleteProperty(missing.sourceScope, 'rootRelativePath');
  assert.throws(() => decodeWorkspaceOperationCopyOrigin(missing), copyOriginInvalid());
});

test('origin does not grant permissions, carry a principal or fabricate current authority', () => {
  const input = copyOriginFixture('agent');
  input.sourceWorkspace.permissions.canRead = false; input.destinationWorkspace.permissions.canWrite = false;
  input.destinationWorkspace.status = 'archived';
  const origin = captureWorkspaceOperationCopyOrigin(input);
  assert.deepEqual(Object.keys(origin).sort(), ['actor', 'destinationScope', 'sourceScope', 'version']);
  assert.equal(Reflect.ownKeys(origin).every(key => typeof key === 'string'), true);
  const json = JSON.stringify(origin);
  for (const key of ['permissions', 'principal', 'authority', 'executionReady', 'claim', 'database', 'assertCurrent', 'status', 'actorDisplayName']) {
    assert.equal(json.includes(`"${key}"`), false, `${key} must not become original authority data`);
  }
  assert.deepEqual(assertWorkspaceOperationCopyOriginCurrent(origin, origin), origin,
    'This is data integrity only; a caller must independently prove current authorization.');
});

test('exact JSON fields reject missing/extra members on the envelope, actor and either scope', () => {
  const origin = captureWorkspaceOperationCopyOrigin(copyOriginFixture());
  for (const side of ['envelope', 'actor', 'sourceScope', 'destinationScope'] as const) {
    const extra = copyOriginData(origin), target = side === 'envelope' ? extra : extra[side];
    Object.assign(target, { extraAuthority: true });
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(extra), copyOriginInvalid(), `${side} extra`);
    const missing = copyOriginData(origin), missingTarget = side === 'envelope' ? missing : missing[side];
    Reflect.deleteProperty(missingTarget, Object.keys(missingTarget)[0]);
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(missing), copyOriginInvalid(), `${side} missing`);
  }
  for (const version of [0, 2, '1', null]) assert.throws(() => decodeWorkspaceOperationCopyOrigin({ ...origin, version }), copyOriginInvalid());
});

test('actor discriminants are primitive strings and cannot be forged by array/object coercion', () => {
  const origin = captureWorkspaceOperationCopyOrigin(copyOriginFixture());
  for (const type of [['user'], ['agent'], { toString: 'user' }, null, true, 1, 'system', 'USER', 'user ']) {
    const forged = copyOriginData(origin); Object.assign(forged.actor, { type });
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(forged), copyOriginInvalid());
  }
});

test('actor IDs require bounded valid UTF-8 data, with explicit nullable sessions and no hidden normalization', () => {
  for (const key of ['userId', 'actorId', 'sessionId'] as const) for (const value of ['', 'x'.repeat(257), '\u0000', 'x\u007f', '\uD800', '\uDC00', 1, {}, []]) {
    const origin = copyOriginData(captureWorkspaceOperationCopyOrigin(copyOriginFixture('agent')));
    Object.assign(origin.actor, { [key]: value });
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(origin), copyOriginInvalid(), `${key}:${JSON.stringify(value)}`);
  }
  const input = copyOriginFixture(); input.actor.userId = '界'.repeat(256); input.actor.actorId = input.actor.userId;
  input.actor.sessionId = 'Session-😀-é';
  assert.equal(captureWorkspaceOperationCopyOrigin(input).actor.userId, input.actor.userId);
  const missingSession = copyOriginData(); Reflect.deleteProperty(missingSession.actor, 'sessionId');
  assert.throws(() => decodeWorkspaceOperationCopyOrigin(missingSession), copyOriginInvalid());
  const original = captureWorkspaceOperationCopyOrigin(copyOriginFixture('agent')), current = copyOriginData(original);
  current.actor.actorId = ' actual-agent ';
  assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(original, current), copyOriginInvalid('COPY_ORIGIN_CHANGED'));
});

test('scope identifiers and literal paths reject malformed Unicode rather than hashing replacement bytes', () => {
  const origin = captureWorkspaceOperationCopyOrigin(copyOriginFixture());
  for (const side of ['sourceScope', 'destinationScope'] as const) for (const key of ['workspaceId', 'organizationId', 'customerId',
    'projectId', 'ownerUserId', 'rootPath', 'rootRelativePath']) {
    const malformed = copyOriginData(origin);
    Object.assign(malformed[side], { [key]: key === 'rootPath' ? '/fixture/\uD800' : 'bad\uD800' });
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(malformed), copyOriginInvalid(), `${side}.${key}`);
  }
});

test('decoder refuses accessors, nonenumerable fields and symbols without invoking caller code', () => {
  let calls = 0;
  for (const side of ['envelope', 'actor', 'sourceScope', 'destinationScope'] as const) {
    const origin = copyOriginData(), target = side === 'envelope' ? origin : origin[side], key = Object.keys(target)[0];
    Object.defineProperty(target, key, { enumerable: true, get() { calls++; return 1; } });
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(origin), copyOriginInvalid());
    const hidden = copyOriginData(), hiddenTarget = side === 'envelope' ? hidden : hidden[side];
    Object.defineProperty(hiddenTarget, Object.keys(hiddenTarget)[0], { enumerable: false, value: 'hidden' });
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(hidden), copyOriginInvalid());
    const symbolic = copyOriginData(); Object.assign(side === 'envelope' ? symbolic : symbolic[side], { [Symbol('authority')]: true });
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(symbolic), copyOriginInvalid());
  }
  assert.equal(calls, 0);
});

test('Capture rejects outer accessors/extras and reads workspace/actor descriptors without evaluating getters', () => {
  let calls = 0;
  for (const key of ['actor', 'sourceWorkspace', 'destinationWorkspace'] as const) {
    const input = copyOriginFixture(), value = input[key];
    Object.defineProperty(input, key, { enumerable: true, get() { calls++; return value; } });
    assert.throws(() => captureWorkspaceOperationCopyOrigin(input), copyOriginInvalid());
  }
  assert.equal(calls, 0);
  assert.throws(() => captureWorkspaceOperationCopyOrigin(Object.assign(copyOriginFixture(), { extra: true })), copyOriginInvalid());
  const input = copyOriginFixture(); Object.defineProperty(input.sourceWorkspace, 'workspaceId', { enumerable: true, get() { calls++; return 'source-workspace'; } });
  assert.throws(() => captureWorkspaceOperationCopyOrigin(input), copyOriginInvalid()); assert.equal(calls, 0);
});

test('sparse arrays, cycles, typed bytes and exotic prototypes never become origin JSON', () => {
  const original = copyOriginData(), cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const invalid of [null, [], new Array(2), new Uint8Array(2), new Date(), Object.assign(Object.create({}), original),
    { ...original, actor: new Array(4) }, { ...original, actor: cycle }, { ...original, sourceScope: Object.create(null) }]) {
    assert.throws(() => decodeWorkspaceOperationCopyOrigin(invalid), copyOriginInvalid());
  }
  const poisoned = copyOriginData(); Object.defineProperty(poisoned.actor, '__proto__', { enumerable: true, value: 'grant' });
  assert.throws(() => decodeWorkspaceOperationCopyOrigin(poisoned), copyOriginInvalid());
});

test('the compact 32-KiB origin budget applies to valid multibyte scope text', () => {
  const small = copyOriginData(); small.sourceScope.rootPath = `/fixture/${'界'.repeat(100)}`;
  assert.deepEqual(decodeWorkspaceOperationCopyOrigin(small), small);
  const large = copyOriginData();
  for (const side of ['sourceScope', 'destinationScope'] as const) {
    large[side].rootPath = `/${'界'.repeat(3000)}`; large[side].rootRelativePath = '界'.repeat(3000);
  }
  assert(Buffer.byteLength(JSON.stringify(large)) > 32 * 1024);
  assert.throws(() => decodeWorkspaceOperationCopyOrigin(large), copyOriginInvalid());
});

test('Current strictly validates both original and fresh envelopes before comparing their facts', () => {
  const original = captureWorkspaceOperationCopyOrigin(copyOriginFixture()), invalid = copyOriginData(original);
  invalid.version = 2 as never;
  assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(invalid, original), copyOriginInvalid());
  assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(original, invalid), copyOriginInvalid());
  assert.throws(() => assertWorkspaceOperationCopyOriginCurrent(undefined, original), copyOriginInvalid());
});
