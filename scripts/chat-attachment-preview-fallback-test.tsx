import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { AttachmentPreviewItem } from '../app/components/canvas-agent-chat/AttachmentPreviewItem';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
});

for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : dom.window[key],
  });
}

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

async function main() {
  const root = createRoot(document.getElementById('root')!);
  const uploadId = 'screenshot---12345678-1234-1234-1234-123456789abc.png';
  const previewUrl = `/api/files/${uploadId}/preview?w=192&preset=mini`;
  const mediaUrl = `/api/files/${uploadId}`;

  await act(async () => {
    root.render(
      <AttachmentPreviewItem
        attachment={{
          name: 'screenshot.png',
          id: uploadId,
          contentKind: 'image',
          previewUrl,
          mediaUrl,
        }}
        context="message"
      />,
    );
  });

  const image = document.querySelector<HTMLImageElement>('img')!;
  assert.equal(image.getAttribute('src'), previewUrl);

  await act(async () => {
    image.dispatchEvent(new dom.window.Event('error', { bubbles: true }));
  });

  assert.equal(image.getAttribute('src'), mediaUrl);
  await act(async () => root.unmount());
  console.log('chat-attachment-preview-fallback-test: ok');
}

void main();
