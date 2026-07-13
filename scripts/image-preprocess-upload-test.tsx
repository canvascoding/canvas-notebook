import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import type { ConvertParams } from '../app/components/shared/ImagePreprocessDialog';
import {
  useImagePreprocess,
  type UseImagePreprocessOptions,
  type UseImagePreprocessReturn,
} from '../app/hooks/useImagePreprocess';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'File', { value: dom.window.File, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let latestHookResult: UseImagePreprocessReturn | null = null;

function HookHarness(props: UseImagePreprocessOptions) {
  const hookResult = useImagePreprocess(props);
  useEffect(() => {
    latestHookResult = hookResult;
  }, [hookResult]);
  return null;
}

function currentHookResult(): UseImagePreprocessReturn {
  assert.ok(latestHookResult, 'hook should be rendered');
  return latestHookResult;
}

async function main() {
  const uploadCalls: Array<{ fileName: string; refreshTree?: boolean }> = [];
  const completedTargets: Array<string | undefined> = [];
  const files = Array.from({ length: 66 }, (_, index) => (
    new File(['image'], `image-${index + 1}.heic`, { type: 'image/heic' })
  ));
  const convertParams: ConvertParams[] = files.map(() => ({
    format: 'jpg',
    quality: 0.85,
  }));

  const hookOptions: UseImagePreprocessOptions = {
    onUpload: async (uploadFiles, _convertParams, _targetDir, _pathMap, options) => {
      uploadCalls.push({ fileName: uploadFiles[0]?.name ?? '', refreshTree: options?.refreshTree });
    },
    onBatchComplete: async (targetDir) => {
      completedTargets.push(targetDir);
    },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<HookHarness {...hookOptions} />);
  });

  await act(async () => {
    await currentHookResult().handleFiles(files, 'assets');
  });
  assert.equal(currentHookResult().dialogState?.files.length, 66);

  await act(async () => {
    await currentHookResult().handleConfirm(convertParams);
  });

  assert.equal(uploadCalls.length, 66, 'each preprocessed file should retain isolated upload error handling');
  assert.ok(uploadCalls.every((call) => call.refreshTree === false), 'per-file uploads must defer tree refresh');
  assert.deepEqual(completedTargets, ['assets'], 'the batch should refresh its target exactly once');
  assert.equal(currentHookResult().progressItems.filter((item) => item.status === 'success').length, 66);

  await act(async () => {
    root.unmount();
  });
  container.remove();

  console.log('image preprocess upload test passed');
}

void main();
