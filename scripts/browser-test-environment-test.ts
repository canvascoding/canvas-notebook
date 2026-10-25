import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBrowserFixtureUrl } from '../tests/helpers/browser-fixture-url';
import { initializeManagedTestWorkspace } from '../tests/helpers/managed-test-workspace';

async function main() {
  const access = 'synthetic-ticket';
  assert.equal(createBrowserFixtureUrl({ access, baseUrl: 'http://127.0.0.1:3100' }),
    'http://localhost:3100/api/browser/view/fixture-page?access=synthetic-ticket');
  assert.equal(createBrowserFixtureUrl({ access, baseUrl: 'http://127.0.0.1:3100', fixturePort: '3000', promptOnLoad: true }),
    'http://localhost:3000/api/browser/view/fixture-page?access=synthetic-ticket&promptOnLoad=1');
  for (const fixturePort of ['', '0', '65536', '-1', '3.1', '3000/path', ' 3000', '1e3']) {
    assert.throws(() => createBrowserFixtureUrl({ access, baseUrl: 'http://127.0.0.1:3100', fixturePort }), /TEST_BROWSER_FIXTURE_PORT/u);
  }
  for (const baseUrl of ['https://example.com', 'file:///tmp/foo', 'http://user:password@localhost:3100']) {
    assert.throws(() => createBrowserFixtureUrl({ access, baseUrl }), /plain loopback/u);
  }

  const workspace = { id: 'ws-synthetic', name: 'Recovery QA', status: 'active', permissions: { canRead: true } };
  let lookups = 0;
  let reply: unknown = { workspaces: [workspace] };
  let status = 200;
  let initialScript: { callback: (...args: never[]) => unknown; argument: unknown } | undefined;
  const request = { get: async (url: string, options: { timeout: number }) => {
    lookups++; assert.equal(url, '/api/workspaces'); assert.equal(options.timeout, 5_000);
    return { ok: () => status === 200, status: () => status, json: async () => reply };
  } } as never;
  const page = { context: () => ({ addInitScript: async (callback: (...args: never[]) => unknown, argument: unknown) => {
    initialScript = { callback, argument };
  } }) } as never;
  const input = { page, request, email: 'primary@local.test', primaryEmail: 'primary@local.test',
    workspaceName: workspace.name, baseUrl: 'http://127.0.0.1:3100', timeout: 5_000 };
  await initializeManagedTestWorkspace({ ...input, workspaceName: undefined });
  await initializeManagedTestWorkspace({ ...input, email: 'secondary@local.test' });
  assert.equal(lookups, 0, 'Unconfigured or secondary-user contexts retain their own workspace setup');
  await initializeManagedTestWorkspace(input);
  assert.ok(initialScript);
  const storage = new Map<string, string>();
  const execute = (origin = input.baseUrl) => vm.runInNewContext(`(${initialScript!.callback.toString()})(${JSON.stringify(initialScript!.argument)})`, {
    location: { origin }, localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
  });
  execute(); assert.equal(storage.get('canvas.activeWorkspaceId'), workspace.id);
  storage.set('canvas.activeWorkspaceId', 'ws-explicitly-selected'); execute();
  assert.equal(storage.get('canvas.activeWorkspaceId'), 'ws-explicitly-selected', 'A later explicit workspace switch survives navigation');
  storage.clear(); execute('https://external.local.test'); assert.equal(storage.size, 0, 'Other browser origins are not modified');
  for (const workspaces of [[], [{ ...workspace, status: 'disabled' }], [{ ...workspace, permissions: { canRead: false } }], [workspace, { ...workspace, id: 'ambiguous' }]]) {
    reply = { workspaces }; initialScript = undefined;
    await assert.rejects(() => initializeManagedTestWorkspace(input), /one active, readable workspace/u);
    assert.equal(initialScript, undefined, 'Invalid fixtures never install a workspace selection');
  }
  status = 503;
  await assert.rejects(() => initializeManagedTestWorkspace(input), /lookup failed \(503\)/u);
  console.log('Browser fixture port and explicit workspace selection contracts passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
