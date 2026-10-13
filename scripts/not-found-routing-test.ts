import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import Module from 'node:module';
import path from 'node:path';
import { NextRequest } from 'next/server';

import middleware from '../proxy';
import { PAGE_RETURN_TO_HEADER } from '../app/lib/auth/page-request';

async function main() {
  for (const pathname of ['/de/missing-page', '/en/missing-page', '/en/settings/missing-page', '/en/plugins?workspaceId=example']) {
    const response = await middleware(new NextRequest(`http://localhost:3000${pathname}`, {
      headers: { [PAGE_RETURN_TO_HEADER]: '//untrusted.example' },
    }));
    assert.equal(response.headers.get('location'), null, 'Next.js must resolve page existence before requiring login.');
    assert.equal(response.headers.get('x-middleware-next'), '1');
    assert.equal(response.headers.get(`x-middleware-request-${PAGE_RETURN_TO_HEADER}`), pathname, 'The actual request replaces a spoofed return path.');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const pathname of ['/api/files', '/api/missing-route']) {
    const response = await middleware(new NextRequest(`http://localhost:3000${pathname}`));
    assert.equal(response.status, 401, 'Page fallback must not bypass API authentication.');
    assert.deepEqual(await response.json(), { success: false, error: 'Unauthorized' });
  }

  // Removing the blanket page redirect is safe only while every protected page
  // has its own server guard. Fail when a future page omits that boundary.
  const routesRoot = path.resolve('app/[locale]/(routes)');
  const publicPages = new Set(['login', 'sign-in', 'sign-up', 'setup', 'invite/team', 'oauth/consent']);
  let protectedPageCount = 0;
  for (const entry of await readdir(routesRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== 'page.tsx') continue;
    const file = path.join(entry.parentPath, entry.name);
    const route = path.relative(routesRoot, entry.parentPath).split(path.sep).filter(part => !part.startsWith('(')).join('/');
    if (publicPages.has(route)) continue;
    const source = await readFile(file, 'utf8');
    if (route === 'usage') {
      assert.match(source, /getPathname\(\{ href: '\/settings', locale \}\)/u, 'The legacy usage URL must redirect to guarded settings.');
      assert.match(source, /redirect\(settingsUrl\)/u);
      continue;
    }
    assert.match(source, /import\s*\{\s*requirePageSession\s*\}\s*from\s*['"]@\/app\/lib\/auth-guards['"]/u, `${route || '/'} needs a server-side page guard.`);
    assert.match(source, /await requirePageSession\(|requirePageSession\(\),/u, `${route || '/'} must run its page guard.`);
    protectedPageCount += 1;
  }
  assert.ok(protectedPageCount >= 27, 'The audit must include all current protected pages.');

  let requestHeaders = new Headers({ [PAGE_RETURN_TO_HEADER]: '/en/files?workspaceId=example' });
  let session: { user: { id: string } } | null = null;
  let hasUsers = true;
  let onboardingEnabled = false;
  let onboardingComplete = true;
  let userOnboardingComplete = true;
  class PageRedirect extends Error {
    constructor(readonly href: string, readonly locale: string) { super(href); }
  }
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => {
    if (request === 'next/headers') return { headers: async () => requestHeaders };
    if (request === 'next-intl/server') return { getLocale: async () => 'en' };
    if (request === '@/i18n/navigation') return { redirect: ({ href, locale }: { href: string; locale: string }) => { throw new PageRedirect(href, locale); } };
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      assert.equal(headers, requestHeaders);
      return session;
    } } } };
    if (request === '@/app/lib/auth-setup') return { hasAnyAuthUser: async () => hasUsers };
    if (request === '@/app/lib/onboarding/status') return { isOnboardingEnabled: () => onboardingEnabled, isOnboardingComplete: async () => onboardingComplete };
    if (request === '@/app/lib/user-preferences') return { getUserOnboardingState: async () => ({ step: userOnboardingComplete ? 'complete' : 'started' }) };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { requirePageSession } = await import('../app/lib/auth-guards');
    const redirectsTo = async (href: string, options?: Parameters<typeof requirePageSession>[0]) => {
      await assert.rejects(requirePageSession(options), error => error instanceof PageRedirect && error.href === href && error.locale === 'en');
    };
    await redirectsTo(`/login?${new URLSearchParams({ from: '/en/files?workspaceId=example' })}`);
    await redirectsTo(`/login?${new URLSearchParams({ from: '/todos?todo=example' })}`, { returnTo: '/todos?todo=example' });
    requestHeaders.set('cookie', 'better-auth.session_token=expired');
    await redirectsTo(`/login?${new URLSearchParams({ from: '/en/files?workspaceId=example' })}`);
    for (const invalid of ['//untrusted.example', '/\\untrusted.example', 'https://untrusted.example']) {
      requestHeaders = new Headers({ [PAGE_RETURN_TO_HEADER]: invalid });
      await redirectsTo('/login');
    }
    requestHeaders = new Headers();
    await redirectsTo('/login');
    hasUsers = false;
    await redirectsTo('/setup');
    hasUsers = true;
    session = { user: { id: 'signed-in-user' } };
    assert.equal(await requirePageSession(), session);
    onboardingEnabled = true;
    onboardingComplete = false;
    await redirectsTo('/onboarding');
    onboardingComplete = true;
    userOnboardingComplete = false;
    await redirectsTo('/onboarding');
    assert.equal(await requirePageSession({ allowIncompleteUserOnboarding: true }), session);
  } finally {
    internals._load = originalLoad;
  }
  console.log(`404 routing, API boundary, login return paths, onboarding and ${protectedPageCount} protected pages passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
