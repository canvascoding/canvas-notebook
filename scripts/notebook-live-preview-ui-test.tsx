import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import type { CollaborationDocument } from '../app/lib/collaboration/client';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event', 'EventTarget', 'DOMParser'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
async function main() {
  const { useLiveMarkdown } = await import('../app/components/editor/MarkdownDocumentModes');
  const { MediaViewer } = await import('../app/components/editor/MediaViewer');
  const root = createRoot(document.getElementById('root')!);
  const doc = new Y.Doc(); doc.getText('content').insert(0, '---\nmarp: true\n---\n# Before');
  const collaboration = { doc, session: { representation: 'plain_text' } } as CollaborationDocument;
  function Preview() {
    const live = useLiveMarkdown(collaboration, 'fallback');
    return <div data-testid="slides">{live.content}</div>;
  }
  await act(async () => root.render(<Preview />));
  assert.ok(document.body.textContent?.includes('# Before'));
  await act(async () => doc.transact(() => {
    doc.getText('content').delete(0, doc.getText('content').length);
    doc.getText('content').insert(0, '---\nmarp: true\n---\n# From agent');
  }));
  assert.ok(document.body.textContent?.includes('# From agent'), 'Yjs changes reach a mounted preview without a text editor');

  let loads = 0; let plays = 0;
  dom.window.HTMLMediaElement.prototype.load = function () { loads += 1; this.currentTime = 0; };
  dom.window.HTMLMediaElement.prototype.play = async function () { plays += 1; };
  await act(async () => root.render(<MediaViewer path="clip.mp4" kind="video" sourceUrl="/clip?revision=1" />));
  const video = document.querySelector('video')!;
  video.currentTime = 36; video.volume = 0.4; video.playbackRate = 1.5;
  Object.defineProperty(video, 'paused', { value: false, configurable: true });
  Object.defineProperty(video, 'duration', { value: 100, configurable: true });
  await act(async () => root.render(<MediaViewer path="clip.mp4" kind="video" sourceUrl="/clip?revision=2" />));
  assert.equal(document.querySelector('video'), video, 'revision keeps the player element');
  assert.equal(loads, 2);
  await act(async () => video.dispatchEvent(new dom.window.Event('loadedmetadata')));
  assert.equal(video.currentTime, 36);
  assert.equal(video.volume, 0.4);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(plays, 1);
  video.currentTime = 80;
  await act(async () => root.render(<MediaViewer path="clip.mp4" kind="video" sourceUrl="/clip?revision=3" />));
  Object.defineProperty(video, 'duration', { value: 20, configurable: true });
  await act(async () => video.dispatchEvent(new dom.window.Event('loadedmetadata')));
  assert.equal(video.currentTime, 20, 'a shorter replacement clamps the restored position');
  await act(async () => root.unmount()); doc.destroy(); dom.window.close();
  console.log('notebook-live-preview-ui-test: ok');
}
void main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
