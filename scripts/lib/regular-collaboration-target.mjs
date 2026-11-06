import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

export const regularCollaborationPrerequisite = 'REGULAR_COLLABORATION_PREREQUISITE';

export function assertRegularCollaborationEnvironment(environment = process.env) {
  const require = (condition, message) => assert(condition, `${regularCollaborationPrerequisite}: ${message}`);
  require(environment.CANVAS_REGULAR_COLLABORATION_E2E === '1' && environment.COLLABORATION_E2E === '1'
    && environment.E2E_EXTERNAL_SERVER === '1', 'Use the regular collaboration profile with its owned running target.');
  let origin;
  try { origin = new URL(environment.BASE_URL); } catch { require(false, 'Configure a loopback BASE_URL.'); }
  require(['http:', 'https:'].includes(origin.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash,
  'The target must be a plain loopback HTTP origin.');
  const email = environment.TEST_LOGIN_EMAIL || environment.BOOTSTRAP_ADMIN_EMAIL;
  const password = environment.TEST_LOGIN_PASSWORD || environment.BOOTSTRAP_ADMIN_PASSWORD;
  const secondaryEmail = environment.TEST_SECONDARY_EMAIL || environment.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
  const secondaryPassword = environment.TEST_SECONDARY_PASSWORD || environment.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
  require(email && password && secondaryEmail && secondaryPassword, 'Configure both managed test accounts.');
  require(email.toLowerCase() !== secondaryEmail.toLowerCase(), 'Peer tests require two distinct users.');
  require(typeof environment.DATA === 'string' && path.isAbsolute(environment.DATA), 'Configure the actual local DATA root.');
  require(environment.CANVAS_DOCUMENT_REVIEW_E2E !== '1', 'Review Center is outside the regular profile.');
  return { origin: origin.origin, email, password, secondaryEmail, secondaryPassword, dataRoot: environment.DATA };
}

/** Real authentication and current rights; no flags manufacture fixture access. */
export async function verifyRegularCollaborationTarget(environment = process.env, fetcher = fetch) {
  const selected = assertRegularCollaborationEnvironment(environment);
  const metadata = await lstat(selected.dataRoot);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid?.(),
    `${regularCollaborationPrerequisite}: DATA must be the owned local fixture directory.`);
  const request = (route, options = {}) => fetcher(selected.origin + route, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const health = await request('/api/health');
  assert(health.ok, `${regularCollaborationPrerequisite}: Runtime readiness failed (${health.status}).`);
  const state = await health.json();
  assert(state.status === 'healthy' && state.database?.provider === 'postgres'
    && state.deployment?.teamFeaturesEnabled === true && state.collaboration?.persistenceReady === true,
  `${regularCollaborationPrerequisite}: A healthy PostgreSQL Team collaboration fixture is required.`);
  const sessions = [];
  try {
    const users = [];
    for (const [email, password] of [[selected.email, selected.password], [selected.secondaryEmail, selected.secondaryPassword]]) {
      const login = await request('/api/auth/sign-in/email', { method: 'POST',
        headers: { Origin: selected.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert(login.ok, `${regularCollaborationPrerequisite}: Managed fixture login failed (${login.status}).`);
      const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
      assert(cookie, `${regularCollaborationPrerequisite}: Login returned no session.`);
      sessions.push(cookie);
      const identity = await (await request('/api/auth/get-session', { headers: { Cookie: cookie } })).json();
      assert(identity.user?.email?.toLowerCase() === email.toLowerCase(), `${regularCollaborationPrerequisite}: Authenticated identity differs.`);
      const listing = await request('/api/workspaces', { headers: { Cookie: cookie } });
      assert(listing.ok, `${regularCollaborationPrerequisite}: Workspace listing failed.`);
      const workspaces = await listing.json();
      const workspace = workspaces.workspaces?.find(item => item.name === 'Shared Test Workspace'
        && ['team', 'organization'].includes(item.type) && item.permissions?.canWrite
        && (users.length > 0 || item.permissions?.canDelete));
      assert(workspace, `${regularCollaborationPrerequisite}: Both users need shared write access; the primary needs cleanup delete rights.`);
      users.push({ userId: identity.user.id, workspaceId: workspace.id });
    }
    assert(users[0].userId !== users[1].userId && users[0].workspaceId === users[1].workspaceId,
      `${regularCollaborationPrerequisite}: Distinct peers must share the same actual workspace.`);
    const review = await request('/api/document-review/availability', { headers: { Cookie: sessions[0] } });
    const availability = await review.json();
    assert(review.ok && availability.data?.documentReviewEnabled === false,
      `${regularCollaborationPrerequisite}: Run this profile with Review Center disabled.`);
    return { origin: selected.origin, workspaceId: users[0].workspaceId, users: users.map(user => user.userId), reviewEnabled: false };
  } finally {
    const results = await Promise.allSettled(sessions.map(async cookie => {
      const response = await request('/api/auth/sign-out', { method: 'POST', headers: {
        Cookie: cookie, Origin: selected.origin, 'Content-Type': 'application/json',
      }, body: '{}' });
      assert(response.ok, `${regularCollaborationPrerequisite}: Own preflight session cleanup failed.`);
    }));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, `${regularCollaborationPrerequisite}: Preflight session cleanup failed.`);
  }
}
