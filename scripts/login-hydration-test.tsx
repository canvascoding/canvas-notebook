import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';

import messages from '../messages/en.json';

async function main() {
  let sessionPending = true;
  let searchParams = new URLSearchParams('from=/en/settings');
  const internal = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = internal._load;
  internal._load = (name, ...args) => {
    if (name === 'next-intl') {
      return {
        useLocale: () => 'en',
        useTranslations: () => (key: string) => messages.login[key as keyof typeof messages.login],
      };
    }
    if (name === 'next/navigation') return { useSearchParams: () => searchParams };
    if (name === '@/app/lib/auth-client' || name.endsWith('/app/lib/auth-client')) {
      return { authClient: { useSession: () => ({ data: null, isPending: sessionPending }) } };
    }
    if (name === '@/app/components/language-switcher' || name.endsWith('/app/components/language-switcher')) {
      return { LanguageSwitcher: () => null };
    }
    if (name === '@/app/components/branding/PublicBrandLogo' || name.endsWith('/app/components/branding/PublicBrandLogo')) {
      return { PublicBrandLogo: () => null };
    }
    return originalLoad(name, ...args);
  };
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
  try {
    const { default: LoginClient } = await import('../app/[locale]/(routes)/login/login-client');
    for (const oauth of [false, true]) {
      searchParams = new URLSearchParams(oauth ? 'sig=test&ba_param=client_id' : 'from=/en/settings');
      sessionPending = true;
      const serverHtml = renderToString(<LoginClient />);
      assert.equal(serverHtml.includes('id="email"'), oauth, 'ordinary login waits for the session; OAuth shows its continuation form');

      const dom = new JSDOM(`<div id="root">${serverHtml}</div>`, { url: 'http://localhost/en/login' });
      for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle']) {
        if (!originalDescriptors.has(name)) originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
      }
      Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
      const { hydrateRoot } = await import('react-dom/client');
      const recoveries: unknown[] = [];
      // A provider can finish Better Auth's shared session request before the
      // suspended login form hydrates. Reproduce that actual timing boundary.
      sessionPending = false;
      let root: ReturnType<typeof hydrateRoot> | undefined;
      try {
        await act(async () => {
          root = hydrateRoot(dom.window.document.getElementById('root')!, <LoginClient />, {
            onRecoverableError: error => recoveries.push(error),
          });
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        assert.deepEqual(recoveries, [], 'a session resolved before hydration must not regenerate the server HTML');
        assert(dom.window.document.querySelector('#email'), 'the logged-out form appears after hydration');
        assert(dom.window.document.querySelector('#password'));
      } finally {
        if (root) await act(async () => root!.unmount());
        dom.window.close();
      }
    }
    console.log('login-hydration-test: ok');
  } finally {
    internal._load = originalLoad;
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
