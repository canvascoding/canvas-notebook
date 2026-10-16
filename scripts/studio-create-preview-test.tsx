// Actual CreateView selection/filtering and Studio chat context in JSDOM.
// Data hooks and unrelated children are controlled; no browser or media API.
import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { StudioGeneration, StudioGenerationOutput } from '../app/apps/studio/types/generation';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://studio-preview.fixture.invalid/studio', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Document', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
class FixtureResizeObserver { observe() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

async function main() {
  const createdAt = '2026-10-14T19:32:49.000Z';
  const good: StudioGenerationOutput = { id: 'output-good', generationId: 'generation-partial', variationIndex: 0, type: 'image',
    filePath: 'studio/workspaces/fixture/outputs/good.png', mediaUrl: '/api/studio/media/studio/workspaces/fixture/outputs/good.png',
    mimeType: 'image/png', fileSize: 148, width: 1024, height: 1024, isFavorite: false, createdAt };
  const blank: StudioGenerationOutput = { ...good, id: 'output-blank', variationIndex: 1, filePath: '', mediaUrl: null, mimeType: null, fileSize: null,
    metadata: JSON.stringify({ error: 'The provider rejected this variation.', errorCode: 'INVALID_PROVIDER_REQUEST' }) };
  const generation: StudioGeneration = { id: good.generationId, userId: 'fixture-user', mode: 'image', prompt: 'Create a poster', rawPrompt: 'Create a poster',
    studioPresetId: null, studioPresetName: null, aspectRatio: '1:1', provider: 'openai', model: 'gpt-image-2.5-sunburst', status: 'completed',
    outputs: [good, blank], createdAt, updatedAt: createdAt };
  const fetches: string[] = [];
  const watched: string[] = [];
  const noop = () => {};
  const noopAsync = async () => {};
  const generationHook = { generations: [generation], creators: [], recentlyCompletedIds: [], loading: false, error: null, hasMoreGenerations: false, loadingMore: false,
    fetchGenerations: noopAsync, loadMoreGenerations: noopAsync, fetchGeneration: async (id: string) => { fetches.push(id); },
    watchGeneration: (id: string) => watched.push(id), generate: async () => assert.fail('Generating is outside preview selection.'),
    toggleFavorite: noopAsync, deleteOutput: noopAsync, deleteGeneration: noopAsync };
  type PreviewProps = { open: boolean; generation: StudioGeneration | null; output: StudioGenerationOutput | null;
    allVisibleOutputs: Array<{ generation: StudioGeneration; output: StudioGenerationOutput }>;
    onNavigate: (generationId: string, outputId: string) => void; onClose: () => void };
  let lastPreview: PreviewProps | undefined;
  function PreviewProbe(props: PreviewProps) {
    lastPreview = props;
    return <div data-testid="preview-probe" data-open={String(props.open)}>
      <ul aria-label="Preview navigation">{props.allVisibleOutputs.map(({ output }) => <li key={output.id}>{output.id}</li>)}</ul>
      <button onClick={() => props.onNavigate(generation.id, good.id)}>Navigate to asset</button>
      <button onClick={() => props.onNavigate(generation.id, blank.id)}>Navigate to placeholder</button>
      {/* eslint-disable-next-line @next/next/no-img-element -- JSDOM prop probe, not a production media renderer. */}
      {props.open && props.output ? <img alt="Selected preview asset" src={props.output.mediaUrl || props.output.filePath} /> : null}
    </div>;
  }
  let searchParams = new URLSearchParams({ generation: generation.id, output: blank.id });
  const router = { replace: noop, push: noop };
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  const originalFetch = globalThis.fetch;
  const workspaceState = { activeWorkspaceId: 'preview-fixture-workspace' };
  const workspaceStore = Object.assign((selector: (state: typeof workspaceState) => unknown) => selector(workspaceState), { getState: () => workspaceState });
  const independentChildren = new Set(['SaveToWorkspaceDialog', 'ImageEditSelectionView', 'OutputGrid', 'FilterBar', 'ReferencePickerDialog', 'BatchDeleteDialog']);
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => searchParams };
    if (name === '@/i18n/navigation') return { Link: ({ children }: { children: React.ReactNode }) => <>{children}</>, useRouter: () => router };
    if (name === '@/app/store/workspace-store') return { useWorkspaceStore: workspaceStore };
    if (parent?.filename.endsWith('/CreateView.tsx')) {
      const basename = name.split('/').at(-1)?.replace(/\.tsx?$/u, '');
      if (basename === 'useStudioGeneration') return { useStudioGeneration: () => generationHook };
      if (basename === 'useStudioProducts') return { useStudioProducts: () => ({ products: [], loading: false, fetchProducts: noopAsync }) };
      if (basename === 'useStudioPersonas') return { useStudioPersonas: () => ({ personas: [], loading: false, fetchPersonas: noopAsync }) };
      if (basename === 'useStudioStyles') return { useStudioStyles: () => ({ styles: [], loading: false, fetchStyles: noopAsync }) };
      if (basename === 'useStudioPresets') return { useStudioPresets: () => ({ presets: [], fetchPresets: noopAsync }) };
      if (basename === 'useStudioBatchActions') return { useStudioBatchActions: () => ({ downloadAsZip: noopAsync }) };
      if (basename === 'StudioPreview') return { StudioPreview: PreviewProbe };
      if (basename === 'StudioPromptComposer') return { StudioPromptComposer: () => null, canGenerateWithStudioState: () => false };
      if (basename && independentChildren.has(basename)) return { [basename]: () => null };
    }
    return originalLoad(name, parent, isMain);
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), dom.window.location.origin);
    if (url.pathname === '/api/studio/starting-points') return Response.json({ success: true, startingPoints: [] });
    if (url.pathname === '/api/studio/config') return Response.json({ success: true, config: { localApiKeys: { openai: true, gemini: false, kie: false }, managedMediaAvailable: false, canManageCentralCredentials: false } });
    throw new Error(`Unexpected transport in preview fixture: ${url.pathname}`);
  };
  const { render, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
  try {
    const { CreateView } = await import('../app/apps/studio/components/create/CreateView');
    const { StudioChatProvider, useStudioChatContext } = await import('../app/apps/studio/context/studio-chat-context');
    function ContextProbe() {
      const { chatContext } = useStudioChatContext();
      return <output data-testid="chat-context">{JSON.stringify(chatContext)}</output>;
    }
    const tree = () => <NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={messages}>
      <StudioChatProvider><CreateView /><ContextProbe /></StudioChatProvider>
    </NextIntlClientProvider>;

    const invalidUrl = render(tree());
    await waitFor(() => assert.ok(fetches.includes(generation.id)));
    assert.ok(watched.includes(generation.id));
    assert.ok(lastPreview);
    assert.deepEqual(lastPreview.allVisibleOutputs.map(({ output }) => output.id), [good.id], 'The actual parent must filter blank history rows from preview navigation.');
    assert.equal(invalidUrl.queryByAltText('Selected preview asset'), null);
    assert.equal(lastPreview.open, false);
    assert.equal(lastPreview.output, null);
    assert.deepEqual(JSON.parse(invalidUrl.getByTestId('chat-context').textContent || 'null'), { currentPage: '/studio' },
      'An initial URL selecting a failed placeholder must not attach blank media to the agent context.');
    assert.deepEqual(within(invalidUrl.getByRole('list', { name: 'Preview navigation' })).getAllByRole('listitem').map((item) => item.textContent), [good.id]);
    cleanup();

    searchParams = new URLSearchParams({ generation: generation.id, output: good.id });
    const validUrl = render(tree());
    await waitFor(() => assert.ok(validUrl.queryByAltText('Selected preview asset')));
    assert.ok(lastPreview);
    assert.equal(lastPreview.open, true);
    assert.equal(lastPreview.generation, generation);
    assert.equal(lastPreview.output, good, 'URL selection must resolve the original asset object.');
    assert.equal(validUrl.getByAltText('Selected preview asset').getAttribute('src'), good.mediaUrl);
    await waitFor(() => assert.equal(JSON.parse(validUrl.getByTestId('chat-context').textContent || 'null')?.studioContext?.currentOutputId, good.id));
    const selectedContext = JSON.parse(validUrl.getByTestId('chat-context').textContent || 'null');
    assert.equal(selectedContext.studioContext.currentOutputId, good.id);
    assert.equal(selectedContext.studioContext.outputFilePath, good.filePath);
    assert.equal(selectedContext.studioContext.outputMediaUrl, good.mediaUrl);

    await act(async () => fireEvent.click(validUrl.getByRole('button', { name: 'Navigate to placeholder' })));
    assert.equal(lastPreview.open, false, 'Invalid child navigation must not bypass parent media validation.');
    assert.equal(lastPreview.output, null);
    assert.equal(validUrl.queryByAltText('Selected preview asset'), null);
    assert.deepEqual(JSON.parse(validUrl.getByTestId('chat-context').textContent || 'null'), { currentPage: '/studio' });
    await act(async () => fireEvent.click(validUrl.getByRole('button', { name: 'Navigate to asset' })));
    assert.equal(lastPreview.output, good);
    assert.equal(lastPreview.open, true);
    assert.deepEqual(lastPreview.allVisibleOutputs.map(({ output }) => output.id), [good.id]);
    console.log('studio-create-preview-test: mounted parent filters blank outputs from navigation, URL selection and chat context');
  } finally {
    cleanup();
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
