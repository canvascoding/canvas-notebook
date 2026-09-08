import assert from 'node:assert/strict';
import { unstable_doesMiddlewareMatch } from 'next/dist/experimental/testing/server/middleware-testing-utils';
import { config } from '../proxy';
import { syncManagedCaddyIdentity, type CaddyManager, type CaddyStatus } from '../cli/src/core/caddy';
import type { CanvasCliConfig } from '../cli/src/core/types';

async function main() {
  for (const pathname of ['/api/setup/owner', '/api/organization/invitations/preview', '/api/organization/invitations/activate', '/api/organization/invitations/accept']) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${pathname}?test=1` }), false, `${pathname}: enforce bounded input before middleware buffering`);
    assert.equal(unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${pathname}/extra` }), true, `${pathname}: neighboring routes keep the proxy guard`);
  }
  let calls = 0;
  let probes = 0;
  let status = { publicDomain: true, installed: true, caddyfileExists: true, caddyfileManaged: true, inSync: false } as CaddyStatus;
  const manager = {
    status: async () => { probes++; return status; },
    apply: async (_config, options) => { assert.equal(options.repair, false); calls++; return {} as never; },
  } satisfies Pick<CaddyManager, 'status' | 'apply'>;
  const fixture = {} as CanvasCliConfig;
  await syncManagedCaddyIdentity(manager, fixture, 'macos');
  assert.equal(probes, 0, 'non-Linux updates must not probe/change host Caddy');
  await syncManagedCaddyIdentity(manager, fixture, 'linux');
  assert.equal(calls, 1, 'managed old configuration upgrades automatically');
  status = { ...status, inSync: true };
  await syncManagedCaddyIdentity(manager, fixture, 'linux');
  assert.equal(calls, 1, 'current Caddy does not reload unnecessarily');
  status = { ...status, inSync: false, caddyfileManaged: false };
  await syncManagedCaddyIdentity(manager, fixture, 'linux');
  assert.equal(calls, 1, 'custom ingress must not be overwritten');
  status = { ...status, caddyfileManaged: true };
  await assert.rejects(syncManagedCaddyIdentity({ ...manager, apply: async () => { throw new Error('validation failed'); } }, fixture, 'linux'), /validation failed/, 'failed managed synchronization cannot report update success');
  console.log('public-security-routing-test: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
