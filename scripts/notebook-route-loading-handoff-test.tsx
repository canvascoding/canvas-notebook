import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import NotebookLoading from '../app/[locale]/(routes)/notebook/loading';
import { NotebookLoadingSkeleton } from '../app/components/notebook/NotebookLoadingSkeleton';
import { ChatLoadingSkeleton } from '../app/components/canvas-agent-chat/ChatLoadingSkeleton';
import { DocumentLoadingSkeleton } from '../app/components/editor/DocumentLoadingSkeleton';
import { NOTEBOOK_EXPLORER_DEFAULT_WIDTH } from '../app/lib/notebook/layout-state';

const label = messages.notebook.loadingPreview;
const render = (child: React.ReactNode) => new JSDOM(renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{child}</NextIntlClientProvider>,
)).window.document;

const route = render(<NotebookLoading />);
const routeShell = route.querySelector('[data-testid="notebook-loading-skeleton"]');
assert.equal(routeShell?.getAttribute('role'), 'status');
assert.equal(routeShell?.getAttribute('aria-label'), label);
assert.equal(routeShell?.querySelector('aside')?.getAttribute('style'), `width:${NOTEBOOK_EXPLORER_DEFAULT_WIDTH}px`);
assert.ok(route.querySelector('.h-14'), 'route fallback reserves the real notebook header height');
assert.ok(route.querySelector('.h-11'), 'route fallback reserves the real notebook toolbar height');
assert.ok(routeShell.querySelector('[data-testid="chat-messages-skeleton"]'), 'default route starts with the shared chat loader');
assert.equal(routeShell.querySelector('[data-testid="file-loading-skeleton"]'), null);

const chat = render(<ChatLoadingSkeleton label={label} />);
assert.equal(
  routeShell.querySelector('[data-testid="chat-messages-skeleton"]')?.outerHTML,
  chat.querySelector('[data-testid="chat-messages-skeleton"]')?.outerHTML,
  'route loading and dashboard chat loading have the same message silhouette',
);

const pendingDocument = render(<NotebookLoadingSkeleton document />);
const documentSkeleton = pendingDocument.querySelector('[data-testid="file-loading-skeleton"]');
assert.ok(documentSkeleton, 'document route intent selects the shared document loader');
assert.equal(pendingDocument.querySelector('[data-testid="chat-messages-skeleton"]'), null);
assert.equal(documentSkeleton.querySelectorAll('.h-10').length, 1, 'document loading has one header of the real editor height');
const dashboardDocument = render(<DocumentLoadingSkeleton label={label} showHeader />);
assert.equal(
  documentSkeleton.outerHTML,
  dashboardDocument.querySelector('[data-testid="file-loading-skeleton"]')?.outerHTML,
  'pre-hydration document loading and dashboard file-read loading have the same silhouette',
);

console.log('notebook-route-loading-handoff-test: ok');
