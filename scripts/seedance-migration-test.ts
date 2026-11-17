import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { getDefaultModelForProvider, getModelsForProvider } from '../app/lib/integrations/image-generation-constants';
import { parseMobileStudioGenerationRequest, serializeMobileStudioGeneration } from '../app/lib/mobile/studio';

async function main() {
const dom = new JSDOM('', { url: 'https://canvas.test' });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
const saved = { mode: 'video', provider: 'bytedance', model: 'bytedance/seedance-2', aspectRatio: '21:9', videoDuration: 12, videoResolution: '1080p', videoGenerateAudio: false, videoWebSearch: true, videoNsfwChecker: true };
dom.window.localStorage.setItem('studio-generation-options', JSON.stringify(saved));
const { createStudioGenerationStore } = await import('../app/store/studio-generation-store');
const state = createStudioGenerationStore().getState();
assert.equal(state.model, 'bytedance/seedance-2-5');
assert.equal(state.videoDuration, 12);
assert.equal(state.videoResolution, '1080p');
assert.equal(state.aspectRatio, '21:9');
assert.equal(state.videoGenerateAudio, false);
assert.equal(state.videoWebSearch, true);
assert.equal(state.videoNsfwChecker, true);
assert.equal(JSON.parse(dom.window.localStorage.getItem('studio-generation-options')!).model, state.model);
assert.equal(getDefaultModelForProvider('video', 'bytedance'), state.model);
assert.equal(getModelsForProvider('video', 'bytedance').length, 1);
state.setRawPrompt('Keep this draft');
state.setModel('bytedance/seedance-2');
const request = parseMobileStudioGenerationRequest({ mode: 'video', provider: 'bytedance', prompt: 'p'.repeat(20_000), startFramePath: 'studio/frames/first.png', endFramePath: 'studio/frames/last.png' });
assert.equal(request.model, state.model);
assert.equal(request.video_duration, 5);
assert.equal(request.video_resolution, '720p');
assert.equal(request.aspect_ratio, '16:9');
assert.equal(request.end_frame_path, 'studio/frames/last.png');
assert.throws(() => parseMobileStudioGenerationRequest({ mode: 'video', provider: 'bytedance', model: 'bytedance/seedance-2', prompt: 'Old request' }), /MODEL_RETIRED/);
assert.throws(() => parseMobileStudioGenerationRequest({ mode: 'video', provider: 'bytedance', prompt: 'Invalid frame', endFramePath: 'studio/frames/last.png' }), /requires a first/);
const generation = { id: 'fixture', mode: 'video', provider: 'bytedance', model: state.model, rawPrompt: 'p'.repeat(20_000), metadata: JSON.stringify({ extraReferenceUrls: Array.from({ length: 30 }, (_, i) => `studio/refs/${i}.png`) }), outputs: [] } as unknown as Parameters<typeof serializeMobileStudioGeneration>[0];
assert.equal(serializeMobileStudioGeneration(generation).references.files.length, 30);
assert.equal(serializeMobileStudioGeneration(generation).fullPrompt.length, 20_000);
console.log('seedance-migration-test: persisted selections, mobile frames/defaults and complete reference replay passed');

}
main().catch(error => { console.error(error); process.exitCode = 1; });
