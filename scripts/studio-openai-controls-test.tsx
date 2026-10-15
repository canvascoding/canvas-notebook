// Mounted component and payload contracts in JSDOM with controlled transport.
// This does not exercise a browser, OpenAI, or backend authorization.
import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://studio-controls.fixture.invalid/studio', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
  'HTMLSelectElement', 'HTMLImageElement', 'SVGElement', 'Element', 'Document', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
  'Event', 'CustomEvent', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  const originalFetch = globalThis.fetch;
  let searchParams = new URLSearchParams();
  const errors: string[] = [];
  const workspaceState = { activeWorkspaceId: 'studio-controls-workspace' };
  const workspaceStore = Object.assign((selector?: (state: typeof workspaceState) => unknown) => selector?.(workspaceState) ?? workspaceState,
    { getState: () => workspaceState });
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => searchParams };
    if (name === '@/app/store/workspace-store') return { useWorkspaceStore: workspaceStore, selectActiveWorkspace: () => null };
    if (name === '@/app/store/file-store') return { useFileStore: () => ({ refreshDirectory: async () => assert.fail('Saving is outside this controls test.') }) };
    if (name === '@/app/apps/studio/components/create/ReferencePickerDialog') return { ReferencePickerDialog: () => null };
    if (name === '@/app/components/workspaces/WorkspaceDestinationPicker') return { WorkspaceDestinationPicker: () => null };
    if (name === 'sonner') return { toast: { success: () => {}, error: (message: string) => errors.push(message) } };
    return originalLoad(name, parent, isMain);
  };
  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  try {
    const { ControlBar } = await import('../app/apps/studio/components/create/ControlBar');
    const { AspectRatioEditorView } = await import('../app/apps/studio/components/aspect-ratio/AspectRatioEditorView');
    const { StudioChatProvider } = await import('../app/apps/studio/context/studio-chat-context');
    const { createStudioGenerationStore } = await import('../app/store/studio-generation-store');
    const { buildStudioGeneratePayload } = await import('../app/apps/studio/utils/studio-generate-payload');
    const models = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] as const;
    const generated: Array<Record<string, unknown>> = [];
    const previews: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin);
      if (url.pathname === '/api/studio/generate' && init?.method === 'POST') {
        generated.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ success: true, generationId: 'controls-fixture-generation', status: 'pending' }, { status: 201 });
      }
      if (url.pathname === '/api/studio/aspect-ratio/models' && (!init?.method || init.method === 'GET')) {
        assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), workspaceState.activeWorkspaceId);
        return Response.json({ success: true, providers: [{ id: 'openai', name: 'OpenAI GPT Image',
          models: models.map((id) => ({ id, label: id, shortLabel: id, description: id })), aspectRatios: ['1:1', '16:9'],
          supportsQuality: true, supportsOutputFormat: true, supportsBackground: true, supportsImageSize: true }] });
      }
      if (url.pathname === '/api/studio/aspect-ratio/preview' && init?.method === 'POST') {
        assert.equal(new Headers(init.headers).get('x-canvas-workspace-id'), workspaceState.activeWorkspaceId);
        previews.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ success: true, preview: { path: 'studio/edits/controls-fixture-preview.png', name: 'preview.png',
          mediaUrl: '/api/studio/media/studio/edits/controls-fixture-preview.png', mode: 'ai_extend', width: 1024, height: 1024, mimeType: 'image/png' } });
      }
      throw new Error(`Unexpected network request in controls fixture: ${init?.method ?? 'GET'} ${url.pathname}`);
    };
    const tree = (children: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={messages}>{children}</NextIntlClientProvider>;

    for (const model of models) {
      dom.window.localStorage.setItem('studio-generation-options', JSON.stringify({ mode: 'image', provider: 'openai', model,
        inputFidelity: 'high', quality: 'auto', background: 'auto', outputFormat: 'jpeg', outputCompression: 80, imageSize: '1024x1024', showMoreOptions: false }));
      const store = createStudioGenerationStore();
      assert.equal(store.getState().inputFidelity, 'high', 'The fixture must restore the stale persisted value.');
      store.getState().setRawPrompt('Create a poster from the reference.');
      store.getState().addFileRef({ id: '/api/studio/media/studio/controls-fixture-reference.png', name: 'reference.png', mediaKind: 'image' });
      function ControlsFixture() {
        const state = store();
        return <ControlBar mode={state.mode} onModeChange={state.setMode} presets={[]} selectedPreset={state.presetRef} onPresetChange={state.setPresetRef}
          aspectRatio={state.aspectRatio} onAspectRatioChange={state.setAspectRatio} count={state.count} onCountChange={state.setCount}
          provider={state.provider} onProviderChange={state.setProvider} model={state.model} onModelChange={state.setModel}
          quality={state.quality} onQualityChange={state.setQuality} outputFormat={state.outputFormat} onOutputFormatChange={state.setOutputFormat}
          background={state.background} onBackgroundChange={state.setBackground} moderation={state.moderation} onModerationChange={state.setModeration}
          outputCompression={state.outputCompression} onOutputCompressionChange={state.setOutputCompression} inputFidelity={state.inputFidelity} onInputFidelityChange={state.setInputFidelity}
          imageSize={state.imageSize} onImageSizeChange={state.setImageSize} onOpenAIImageFormatChange={state.setOpenAIImageFormat}
          videoResolution={state.videoResolution} onVideoResolutionChange={state.setVideoResolution} videoDuration={state.videoDuration} onVideoDurationChange={state.setVideoDuration}
          videoGenerateAudio={state.videoGenerateAudio} onVideoGenerateAudioChange={state.setVideoGenerateAudio} videoWebSearch={state.videoWebSearch} onVideoWebSearchChange={state.setVideoWebSearch}
          videoNsfwChecker={state.videoNsfwChecker} onVideoNsfwCheckerChange={state.setVideoNsfwChecker} isGenerating={false} canGenerate showMoreOptions={state.showMoreOptions}
          onShowMoreOptionsChange={state.setShowMoreOptions} onGenerate={() => {
            void fetch('/api/studio/generate', { method: 'POST', body: JSON.stringify(buildStudioGeneratePayload(state)) });
          }} />;
      }
      const view = render(tree(<ControlsFixture />));
      await act(async () => fireEvent.click(view.getByRole('button', { name: 'More Options' })));
      assert.equal(view.queryByLabelText(/Reference Fidelity/iu), null);
      assert.equal(view.queryByText(/Reference Fidelity/iu), null);
      const quality = view.getByLabelText('Quality') as HTMLSelectElement;
      assert.ok([...quality.options].some((option) => option.value === 'xhigh'));
      assert.ok([...quality.options].some((option) => option.value === 'max'));
      await act(async () => fireEvent.change(quality, { target: { value: 'max' } }));
      await act(async () => fireEvent.change(view.getByLabelText('Background'), { target: { value: 'transparent' } }));
      const format = view.getByLabelText('Output Format') as HTMLSelectElement;
      assert.equal(format.value, 'png', 'Choosing transparency repairs stale JPEG output.');
      assert.ok(![...format.options].some((option) => option.value === 'jpeg'));
      await act(async () => fireEvent.change(format, { target: { value: 'webp' } }));
      await act(async () => fireEvent.change(view.getByLabelText('Compression (%)'), { target: { value: '0' } }));
      await act(async () => fireEvent.change(view.getByLabelText('Moderation'), { target: { value: 'low' } }));
      await act(async () => fireEvent.click(view.getByRole('button', { name: 'Generate' })));
      const payload = generated.at(-1);
      assert.ok(payload);
      assert.equal(payload.model, model);
      assert.equal(Object.hasOwn(payload, 'input_fidelity'), false);
      assert.equal(payload.quality, 'max');
      assert.equal(payload.background, 'transparent');
      assert.equal(payload.output_format, 'webp');
      assert.equal(payload.output_compression, 0);
      assert.equal(payload.moderation, 'low');
      assert.deepEqual(payload.extra_reference_urls, ['/api/studio/media/studio/controls-fixture-reference.png']);
      assert.equal(store.getState().inputFidelity, 'high', 'Hiding an unsupported option must not depend on erasing persisted state.');
      await act(async () => fireEvent.click(view.getByRole('button', { name: 'Less Options' })));
      assert.equal(view.queryByLabelText('Quality'), null);
      cleanup();
    }

    const labels = messages.studio.aspectRatioEditor;
    for (const model of models) {
      searchParams = new URLSearchParams({ ref: 'studio/controls-fixture-source.png', provider: 'openai', model });
      const view = render(tree(<StudioChatProvider><AspectRatioEditorView /></StudioChatProvider>));
      const sourceImage = view.getByAltText('controls-fixture-source.png');
      Object.defineProperty(sourceImage, 'naturalWidth', { value: 1024, configurable: true });
      Object.defineProperty(sourceImage, 'naturalHeight', { value: 1024, configurable: true });
      await act(async () => fireEvent.load(sourceImage));
      const stage = sourceImage.parentElement;
      assert.ok(stage);
      await act(async () => fireEvent.pointerDown(view.getByRole('button', { name: 'Resize nw' }), { clientX: 100, clientY: 100, button: 0 }));
      await act(async () => fireEvent.pointerMove(stage, { clientX: -200, clientY: -200, shiftKey: true }));
      await act(async () => fireEvent.pointerUp(stage));
      await waitFor(() => assert.equal((view.getByLabelText(labels.model) as HTMLSelectElement).value, model));
      assert.equal(view.queryByLabelText(/Reference fidelity/iu), null);
      assert.equal(view.queryByText(/Reference fidelity/iu), null);
      await act(async () => fireEvent.change(view.getByLabelText(labels.quality), { target: { value: 'xhigh' } }));
      await act(async () => fireEvent.change(view.getByLabelText(labels.format), { target: { value: 'jpeg' } }));
      await act(async () => fireEvent.change(view.getByLabelText(labels.background), { target: { value: 'transparent' } }));
      const format = view.getByLabelText(labels.format) as HTMLSelectElement;
      assert.equal(format.value, 'png');
      assert.ok(![...format.options].some((option) => option.value === 'jpeg'));
      await act(async () => fireEvent.change(format, { target: { value: 'webp' } }));
      await act(async () => fireEvent.click(view.getByRole('button', { name: labels.createPreview })));
      await waitFor(() => assert.equal(previews.at(-1)?.model, model));
      const payload = previews.at(-1);
      assert.ok(payload);
      assert.equal(payload.mode, 'ai_extend');
      assert.equal(payload.quality, 'xhigh');
      assert.equal(payload.background, 'transparent');
      assert.equal(payload.outputFormat, 'webp');
      assert.equal(Object.hasOwn(payload, 'inputFidelity'), false, 'The editor default high fidelity must not reach the preview API.');
      assert.equal(errors.length, 0, 'Mounted interactions must not hide transport or render failures.');
      cleanup();
    }
    assert.equal(generated.length, 2);
    assert.equal(previews.length, 2);
    console.log('studio-openai-controls-test: mounted create/outpainting controls and serialized payloads passed for Sunburst/Flare');
  } finally {
    cleanup();
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
