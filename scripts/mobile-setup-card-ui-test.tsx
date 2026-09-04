import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://notebook.example.com/de',
});
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
Object.defineProperty(globalThis, 'HTMLInputElement', { value: dom.window.HTMLInputElement, configurable: true });
Object.defineProperty(globalThis, 'HTMLButtonElement', { value: dom.window.HTMLButtonElement, configurable: true });
Object.defineProperty(globalThis, 'HTMLAnchorElement', { value: dom.window.HTMLAnchorElement, configurable: true });
Object.defineProperty(globalThis, 'SVGElement', { value: dom.window.SVGElement, configurable: true });
Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true });
Object.defineProperty(globalThis, 'NodeFilter', { value: dom.window.NodeFilter, configurable: true });
Object.defineProperty(globalThis, 'Event', { value: dom.window.Event, configurable: true });
Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true });
Object.defineProperty(globalThis, 'MutationObserver', { value: dom.window.MutationObserver, configurable: true });
Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const instanceId = 'cni_0123456789abcdef01234567';
const expectedSetupLink = `https://canvasnotebook.app/connect#v=1&server=${encodeURIComponent('https://notebook.example.com')}&instance=${instanceId}`;

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async () => ({
    ok: true,
    json: async () => ({
      product: 'canvas-notebook',
      instance: {
        id: instanceId,
        name: 'Customer Notebook',
      },
    }),
  }),
});

const messages = {
  mobileAppSetup: {
    available: 'Available for iPhone',
    dismiss: 'Dismiss the Mobile App notice',
    reminderHint: 'We will wait before reminding you again.',
    neverShow: "Don't show this again",
    eyebrow: 'Canvas on the go',
    title: 'Take your notebook with you.',
    description: 'Scan the QR code with your iPhone.',
    bradleyAlt: 'Bradley, the Canvas mascot',
    serverFallback: 'Canvas Notebook',
    thisServer: 'This server',
    openApp: 'Open in the Mobile App',
    appStore: 'View in the App Store',
    copyLink: 'Copy setup link',
    copied: 'Link copied',
    privacy: 'No passwords, tokens, or session data are transferred.',
    loading: 'Preparing QR code',
    qrTitle: 'QR code to set up {server} in Canvas Mobile',
    scanHint: 'Scan with the iPhone camera',
    loadFailedTitle: 'QR code unavailable',
    loadFailed: 'The public instance information could not be loaded.',
    secureRequiredTitle: 'HTTPS required',
    secureRequired: 'Setup links require HTTPS.',
    retry: 'Try again',
    steps: {
      scan: { title: 'Scan the QR code', description: 'Open the camera.' },
      verify: { title: 'Verify the server', description: 'Confirm the instance identity.' },
      login: { title: 'Sign in securely', description: 'Use your normal credentials.' },
    },
  },
};

async function settle(delayMs = 0) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  });
}

function renderWithMessages(container: HTMLElement, children: React.ReactNode) {
  const root = createRoot(container);
  root.render(
    <NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={messages}>
      {children}
    </NextIntlClientProvider>,
  );
  return root;
}

async function main() {
  const { MobileAppSetupCard, MobileAppSetupDialog } = await import('../app/components/mobile/MobileAppSetupCard');
  const { HomeMobileAppPromo } = await import('../app/components/mobile/HomeMobileAppPromo');
  const settingsContainer = document.createElement('div');
  document.body.appendChild(settingsContainer);
  let settingsRoot: ReturnType<typeof createRoot>;
  await act(async () => {
    settingsRoot = renderWithMessages(settingsContainer, <MobileAppSetupCard placement="settings" />);
  });
  await settle();

  assert.match(settingsContainer.textContent ?? '', /Take your notebook with you\./u);
  assert.match(settingsContainer.textContent ?? '', /Customer Notebook/u);
  assert.match(settingsContainer.textContent ?? '', /No passwords, tokens, or session data/u);
  assert.equal(settingsContainer.querySelector('img[alt="Bradley, the Canvas mascot"]') !== null, true);
  assert.equal(settingsContainer.querySelector('svg title')?.textContent, 'QR code to set up Customer Notebook in Canvas Mobile');

  const setupAnchor = Array.from(settingsContainer.querySelectorAll('a')).find((anchor) => (
    anchor.textContent?.includes('Open in the Mobile App')
  ));
  assert.equal(setupAnchor?.getAttribute('href'), expectedSetupLink);
  const appStoreAnchor = Array.from(settingsContainer.querySelectorAll('a')).find((anchor) => (
    anchor.textContent?.includes('View in the App Store')
  ));
  assert.equal(appStoreAnchor?.getAttribute('href'), 'https://apps.apple.com/app/id6794582516');

  await act(async () => settingsRoot!.unmount());
  settingsContainer.remove();

  const dialogContainer = document.createElement('div');
  document.body.appendChild(dialogContainer);
  let dialogRoot: ReturnType<typeof createRoot>;
  let dialogOpen = true;
  let permanentlyDismissed = false;
  await act(async () => {
    dialogRoot = renderWithMessages(dialogContainer, (
      <MobileAppSetupDialog
        open={dialogOpen}
        onOpenChange={(open) => { dialogOpen = open; }}
        onPermanentDismiss={() => { permanentlyDismissed = true; }}
      />
    ));
  });
  await settle();
  assert.match(document.body.textContent ?? '', /Take your notebook with you\./u);
  assert.match(document.body.textContent ?? '', /We will wait before reminding you again\./u);
  assert.equal(document.body.querySelector('[role="dialog"]') !== null, true);
  assert.equal(document.body.querySelector('img[alt="Bradley, the Canvas mascot"]') !== null, true);

  const dismissButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="Dismiss the Mobile App notice"]');
  assert.ok(dismissButton);
  await act(async () => {
    dismissButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(dialogOpen, false);
  assert.equal(permanentlyDismissed, false);

  await act(async () => dialogRoot!.unmount());
  dialogContainer.remove();

  window.localStorage.clear();
  window.sessionStorage.clear();
  const homeContainer = document.createElement('div');
  document.body.appendChild(homeContainer);
  let homeRoot: ReturnType<typeof createRoot>;
  await act(async () => {
    homeRoot = renderWithMessages(homeContainer, <HomeMobileAppPromo />);
  });
  await settle();
  assert.equal(homeContainer.textContent, '', 'The home promotion must not be embedded or open immediately');

  await act(async () => homeRoot!.unmount());
  homeContainer.remove();
  console.log('mobile setup card UI test: ok');
}

void main();
