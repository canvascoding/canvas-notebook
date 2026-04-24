import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GenerateImageRequestBody } from '../app/lib/integrations/image-generation-service';
import type { GenerateVideoRequestBody } from '../app/lib/integrations/veo-generation-service';
import type { StudioGenerateRequest } from '../app/lib/integrations/studio-generation-service';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function main() {
  process.env.QMD_ENABLED = 'false';

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  const { buildPiToolRegistry, createImageGenerationTool, createRipgrepTool, createStudioGenerateVideoTool, createVideoGenerationTool, piTools } = await import('../app/lib/pi/tool-registry');

  const imageCalls: GenerateImageRequestBody[] = [];
  const videoCalls: GenerateVideoRequestBody[] = [];
  const studioCalls: StudioGenerateRequest[] = [];

  const imageTool = createImageGenerationTool({
    generateImagesFn: async (body) => {
      imageCalls.push(body);
      return {
        model: body.model || 'gemini-3.1-flash-image-preview',
        provider: body.provider || 'gemini',
        aspectRatio: body.aspectRatio || '1:1',
        imageCount: body.imageCount || 1,
        outputDir: 'image-generation/generations',
        successCount: 1,
        failureCount: 0,
        results: [
          {
            index: 0,
            path: 'image-generation/generations/generated.png',
            metadataPath: 'image-generation/generations/generated.json',
            mediaUrl: '/api/media/image-generation/generations/generated.png',
          },
        ],
      };
    },
  });

  const videoTool = createVideoGenerationTool({
    generateVideoFn: async (body) => {
      videoCalls.push(body);
      return {
        path: 'veo-studio/video-generation/generated.mp4',
        metadataPath: 'veo-studio/video-generation/generated.json',
        mediaUrl: '/api/media/veo-studio/video-generation/generated.mp4',
      };
    },
  });
  const studioTool = createStudioGenerateVideoTool({
    userId: 'test-user',
    executeStudioGenerationFn: async (_userId, body) => {
      studioCalls.push(body);
      return {
        generationId: 'studio-seedance-generation',
        status: 'completed',
        mode: body.mode || 'video',
        prompt: body.prompt,
        outputs: [
          {
            id: 'studio-output',
            variationIndex: 0,
            filePath: 'generated.mp4',
            mediaUrl: '/api/studio/media/generated.mp4',
            mimeType: 'video/mp4',
            fileSize: 1234,
          },
        ],
      };
    },
  });
  const rgTool = createRipgrepTool();

  assert.equal(piTools.some((tool) => tool.name === 'rg'), true);
  assert.equal(piTools.some((tool) => tool.name === 'qmd'), false);
  assert.equal(piTools.some((tool) => tool.name === 'qmd_search'), false);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-rg-tool-'));
  const matchFile = path.join(tempDir, 'match.ts');
  const otherFile = path.join(tempDir, 'other.md');
  await fs.writeFile(matchFile, 'const SearchToken = "needle";\nconst secondNeedle = "needle";\n', 'utf8');
  await fs.writeFile(otherFile, 'no interesting text here\n', 'utf8');

  const rgMatchResult = await rgTool.execute('rg-match', {
    pattern: 'needle',
    path: tempDir,
    glob: '*.ts',
    ignoreCase: true,
    maxResults: 5,
  });
  assert.match(getText(rgMatchResult), /match\.ts:1:const SearchToken = "needle";/);

  const rgNoMatchResult = await rgTool.execute('rg-empty', {
    pattern: 'definitely-not-here',
    path: tempDir,
  });
  assert.equal(getText(rgNoMatchResult), '(no matches found)');

  const rgInvalidPathResult = await rgTool.execute('rg-error', {
    pattern: 'needle',
    path: path.join(tempDir, 'missing-dir'),
  });
  assert.match(getText(rgInvalidPathResult), /^Error:/);

  const imageReferenceResult = await imageTool.execute('img-ref', {
    count: 2,
    aspect_ratio: '16:9',
    reference_image_paths: [
      './public/images/examples/aura_serum_produktfoto.png',
      'public/images/examples/aura_serum_produktfoto.png',
    ],
  });
  assert.match(getText(imageReferenceResult), /Image generation complete: 1 successful, 0 failed/);
  assert.equal(imageCalls.length, 1);
  assert.equal(imageCalls[0].prompt, undefined);
  assert.deepEqual(imageCalls[0].referenceImagePaths, ['public/images/examples/aura_serum_produktfoto.png']);
  assert.equal(imageCalls[0].imageCount, 2);

  const imageLegacyResult = await imageTool.execute('img-legacy', {
    prompt: 'A polished product shot',
    count: 1,
    model: 'gemini-2.5-flash-image',
  });
  assert.match(getText(imageLegacyResult), /Image generation complete: 1 successful, 0 failed/);
  assert.equal(imageCalls.length, 2);
  assert.equal(imageCalls[1].prompt, 'A polished product shot');
  assert.deepEqual(imageCalls[1].referenceImagePaths, []);
  assert.equal(imageCalls[1].model, 'gemini-2.5-flash-image');

  const imageMissingInputResult = await imageTool.execute('img-error', {
    count: 1,
  });
  assert.equal(getText(imageMissingInputResult), 'Error: Either prompt or reference_image_paths is required.');

  const videoFramesResult = await videoTool.execute('video-frames', {
    mode: 'frames_to_video',
    start_frame_path: './public/images/examples/tech_banner_future_of_innovation.png',
    end_frame_path: 'public/images/examples/reise_banner_find_your_paradise.png',
    is_looping: true,
    resolution: '1080p',
    model: 'veo-3.1-generate-preview',
  });
  assert.match(getText(videoFramesResult), /Video generation started!/);
  assert.equal(videoCalls.length, 1);
  assert.equal(videoCalls[0].mode, 'frames_to_video');
  assert.equal(videoCalls[0].startFramePath, 'public/images/examples/tech_banner_future_of_innovation.png');
  assert.equal(videoCalls[0].endFramePath, 'public/images/examples/reise_banner_find_your_paradise.png');
  assert.equal(videoCalls[0].isLooping, true);
  assert.equal(videoCalls[0].model, 'veo-3.1-generate-preview');

  const videoReferenceResult = await videoTool.execute('video-ref', {
    prompt: 'Animate the product reveal',
    mode: 'references_to_video',
    reference_image_paths: [
      'public/images/examples/aura_serum_produktfoto.png',
      './public/images/examples/tech_banner_future_of_innovation.png',
    ],
  });
  assert.match(getText(videoReferenceResult), /Video generation started!/);
  assert.equal(videoCalls.length, 2);
  assert.equal(videoCalls[1].prompt, 'Animate the product reveal');
  assert.deepEqual(videoCalls[1].referenceImagePaths, [
    'public/images/examples/aura_serum_produktfoto.png',
    'public/images/examples/tech_banner_future_of_innovation.png',
  ]);

  const videoExtendResult = await videoTool.execute('video-extend', {
    mode: 'extend_video',
    input_video_path: 'workspace-assets/sample-input.mp4',
  });
  assert.match(getText(videoExtendResult), /Video generation started!/);
  assert.equal(videoCalls.length, 3);
  assert.equal(videoCalls[2].mode, 'extend_video');
  assert.equal(videoCalls[2].inputVideoPath, 'workspace-assets/sample-input.mp4');

  const videoLegacyResult = await videoTool.execute('video-legacy', {
    prompt: 'A calm beach at sunrise',
  });
  assert.match(getText(videoLegacyResult), /Video generation started!/);
  assert.equal(videoCalls.length, 4);
  assert.equal(videoCalls[3].mode, 'text_to_video');
  assert.equal(videoCalls[3].prompt, 'A calm beach at sunrise');
  assert.equal(videoCalls[3].model, 'veo-3.1-fast-generate-preview');

  const videoTextError = await videoTool.execute('video-text-error', {
    mode: 'text_to_video',
  });
  assert.equal(getText(videoTextError), 'Error: prompt is required for text_to_video mode.');

  const videoFramesError = await videoTool.execute('video-frames-error', {
    mode: 'frames_to_video',
  });
  assert.equal(getText(videoFramesError), 'Error: start_frame_path is required for frames_to_video mode.');

  const videoReferenceError = await videoTool.execute('video-ref-error', {
    mode: 'references_to_video',
    reference_image_paths: ['public/images/examples/aura_serum_produktfoto.png'],
  });
  assert.equal(
    getText(videoReferenceError),
    'Error: prompt and at least one reference_image_paths entry are required for references_to_video mode.',
  );

  const videoExtendError = await videoTool.execute('video-extend-error', {
    mode: 'extend_video',
  });
  assert.equal(getText(videoExtendError), 'Error: input_video_path is required for extend_video mode.');

  const studioSeedanceResult = await studioTool.execute('studio-seedance', {
    prompt: 'A cinematic product reveal',
    provider: 'bytedance',
    model: 'bytedance/seedance-2',
    aspect_ratio: '21:9',
    resolution: '480p',
    duration: 15,
    generate_audio: false,
    web_search: true,
    nsfw_checker: true,
  });
  assert.match(getText(studioSeedanceResult), /Studio video generation completed \(1 output/);
  assert.equal(studioCalls.length, 1);
  assert.equal(studioCalls[0].provider, 'bytedance');
  assert.equal(studioCalls[0].model, 'bytedance/seedance-2');
  assert.equal(studioCalls[0].aspect_ratio, '21:9');
  assert.equal(studioCalls[0].video_resolution, '480p');
  assert.equal(studioCalls[0].video_duration, 15);
  assert.equal(studioCalls[0].video_generate_audio, false);
  assert.equal(studioCalls[0].video_web_search, true);
  assert.equal(studioCalls[0].video_nsfw_checker, true);

  // Verify skill tools are no longer registered in the tool registry
  const allTools = buildPiToolRegistry();
  assert.equal(allTools.every((tool) => !['browser_start', 'browser_nav', 'brave_search', 'transcribe'].includes(tool.name)), true);

  console.log('pi-tool-registry-test: ok');

  moduleInternals._load = originalLoad;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
