// Actual mounted OutputGrid, thumbnails and failure dialogs in JSDOM.
// No browser automation or provider/transport calls.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { StudioGeneration, StudioGenerationOutput } from '../app/apps/studio/types/generation';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://studio-output.fixture.invalid/studio', pretendToBeVisual: true,
});
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLSelectElement', 'HTMLImageElement', 'SVGElement', 'Element',
  'Document', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle',
  'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};

async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Mounted output regression tests must not make network requests.'); };
  const { render, fireEvent, within, cleanup } = await import('@testing-library/react');
  try {
    const { OutputGrid } = await import('../app/apps/studio/components/create/OutputGrid');
    const createdAt = new Date().toISOString();
    const output = (id: string, patch: Partial<StudioGenerationOutput> = {}): StudioGenerationOutput => ({
      id, generationId: 'generation-fixture', variationIndex: 0, type: 'image', filePath: '', fileName: `failed-${id}`,
      mediaUrl: null, fileSize: null, mimeType: null, width: null, height: null, isFavorite: false, createdAt,
      metadata: JSON.stringify({ error: `Provider rejected ${id}.`, errorCode: 'INVALID_PROVIDER_REQUEST' }), ...patch,
    });
    const good = output('good-image', { filePath: 'studio/fixture/good.png', fileName: 'good.png',
      mediaUrl: '/api/studio/media/studio/fixture/good.png', mimeType: 'image/png', fileSize: 1234, isFavorite: true, metadata: null });
    const nonFavorite = output('other-image', { filePath: 'studio/fixture/other.png', fileName: 'other.png',
      mediaUrl: '/api/studio/media/studio/fixture/other.png', mimeType: 'image/png', fileSize: 1234, metadata: null });
    const failed = output('failed-variation');
    const favoriteFailed = output('favorite-failed-variation', { isFavorite: true });
    const generation = (status: StudioGeneration['status'], outputs: StudioGenerationOutput[], metadata?: string): StudioGeneration => ({
      id: 'generation-fixture', userId: 'fixture-user', mode: 'image', prompt: 'Generate a poster.', rawPrompt: 'Generate a poster.',
      studioPresetId: null, studioPresetName: null, aspectRatio: '1:1', provider: 'openai', model: 'gpt-image-2.5-sunburst',
      status, outputs, createdAt, updatedAt: createdAt, metadata,
    });
    const deleted: Array<{ generation: StudioGeneration; output: StudioGenerationOutput }> = [];
    const deletedGenerations: StudioGeneration[] = [];
    const opened: Array<{ generation: StudioGeneration; output: StudioGenerationOutput }> = [];
    const props = {
      emptyState: <div>No outputs fixture</div>, filterEmptyState: <div>No matching outputs fixture</div>,
      onOutputOpen: (selection: { generation: StudioGeneration; output: StudioGenerationOutput }) => { opened.push(selection); },
      onToggleFavorite: () => assert.fail('Favoriting is outside this failure test.'),
      onCreateVariation: () => assert.fail('Generation is outside this failure test.'),
      onCreateVideo: () => assert.fail('Generation is outside this failure test.'),
      onDelete: (receivedGeneration: StudioGeneration, receivedOutput: StudioGenerationOutput) => {
        deleted.push({ generation: receivedGeneration, output: receivedOutput });
      },
      onDeleteGeneration: (receivedGeneration: StudioGeneration) => { deletedGenerations.push(receivedGeneration); },
    };
    const tree = (children: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={messages}>
      {children}
    </NextIntlClientProvider>;
    const failureTitle = messages.studio.outputError.title;

    const totalFailure = generation('failed', [failed, favoriteFailed], JSON.stringify({ error: 'Provider rejected failed-variation.' }));
    const total = render(tree(<OutputGrid {...props} generations={[totalFailure]} />));
    assert.equal(total.getAllByRole('heading', { name: failureTitle }).length, 2,
      'Blank persisted output rows render real error cards instead of empty image thumbnails');
    assert.equal(total.queryAllByRole('button', { name: 'Open Image output' }).length, 0);
    assert.equal(total.queryAllByRole('img').length, 0);
    assert.ok(total.getByText('Provider rejected failed-variation.'));
    assert.ok(total.getByText('Provider rejected favorite-failed-variation.'));
    cleanup();

    const partialGeneration = generation('completed', [good, failed], JSON.stringify({ failedOutputCount: 1 }));
    const partial = render(tree(<OutputGrid {...props} generations={[partialGeneration]} />));
    assert.equal(partial.getAllByRole('heading', { name: failureTitle }).length, 1);
    assert.equal(partial.getAllByRole('button', { name: 'Open Image output' }).length, 1);
    assert.ok(partial.getByRole('img', { name: good.filePath }));
    await act(async () => fireEvent.click(partial.getByRole('button', { name: 'Open Image output' })));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].output.id, good.id);
    await act(async () => fireEvent.click(partial.getByRole('button', { name: messages.studio.outputError.delete, exact: true })));
    const confirmDelete = partial.getByRole('alertdialog');
    await act(async () => fireEvent.click(within(confirmDelete).getByRole('button', { name: messages.studio.outputError.delete, exact: true })));
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].generation, partialGeneration);
    assert.equal(deleted[0].output, failed);
    assert.equal(deletedGenerations.length, 0, 'Deleting a failed variation cannot delete its generation or successful outputs');
    assert.equal(deleted.some((entry) => entry.output.id === good.id), false);
    cleanup();

    const filterGeneration = generation('completed', [good, nonFavorite, favoriteFailed]);
    const failedFilter = render(tree(<OutputGrid {...props} generations={[filterGeneration]} mediaFilter="failed" />));
    assert.equal(failedFilter.getAllByRole('heading', { name: failureTitle }).length, 1);
    assert.equal(failedFilter.queryAllByRole('button', { name: 'Open Image output' }).length, 0);
    assert.equal(failedFilter.queryAllByRole('img').length, 0);
    cleanup();
    const imageFilter = render(tree(<OutputGrid {...props} generations={[filterGeneration]} mediaFilter="image" />));
    assert.equal(imageFilter.queryByRole('heading', { name: failureTitle }), null);
    assert.equal(imageFilter.getAllByRole('button', { name: 'Open Image output' }).length, 2);
    assert.equal(imageFilter.getAllByRole('img').length, 2);
    cleanup();
    const favorites = render(tree(<OutputGrid {...props} generations={[filterGeneration]} mediaFilter="favorites" />));
    assert.equal(favorites.queryByRole('heading', { name: failureTitle }), null);
    assert.equal(favorites.getAllByRole('button', { name: 'Open Image output' }).length, 1);
    assert.ok(favorites.getByRole('img', { name: good.filePath }));
    assert.equal(favorites.queryByRole('img', { name: nonFavorite.filePath }), null);
    cleanup();

    const preflightFailure = generation('failed', [good], JSON.stringify({ error: 'The chosen reference is no longer available.' }));
    const preflight = render(tree(<OutputGrid {...props} generations={[preflightFailure]} />));
    assert.ok(preflight.getByRole('heading', { name: failureTitle }));
    assert.ok(preflight.getByText('The chosen reference is no longer available.'));
    assert.ok(preflight.getByRole('img', { name: good.filePath }), 'An earlier successful asset remains visible after a generation-level replay failure');
    assert.equal(preflight.getAllByRole('button', { name: 'Open Image output' }).length, 1);
    assert.equal(deleted.length, 1);
    assert.equal(deletedGenerations.length, 0);
    cleanup();

    const partialReplayFailure = generation('failed', [good, failed],
      JSON.stringify({ error: 'The chosen reference is no longer available.' }));
    const replay = render(tree(<OutputGrid {...props} generations={[partialReplayFailure]} />));
    assert.equal(replay.getAllByRole('heading', { name: failureTitle }).length, 2,
      'An older failed variation cannot hide a new generation-level preflight error');
    assert.ok(replay.getByText('Provider rejected failed-variation.'));
    assert.ok(replay.getByText('The chosen reference is no longer available.'));
    assert.ok(replay.getByRole('img', { name: good.filePath }));
    assert.equal(replay.getAllByRole('button', { name: 'Open Image output' }).length, 1);
    console.log('studio-output-failures-test: mounted failure cards, filters, deletion scope and prior assets passed');
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
