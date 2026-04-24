import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GenerateImageRequestBody } from '../app/lib/integrations/image-generation-service';
import type { GenerateVideoRequestBody } from '../app/lib/integrations/veo-generation-service';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function writeDynamicSkill(
  skillsDir: string,
  name: string,
  manifest: Record<string, unknown>,
) {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Dynamic test skill for ${name}\n---\n\n# ${name}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

async function writeDynamicWrapper(binDir: string, name: string) {
  const wrapperPath = path.join(binDir, name);
  await fs.writeFile(
    wrapperPath,
    [
      '#!/bin/sh',
      'printf "ARGS:"',
      'for arg in "$@"; do',
      '  printf " [%s]" "$arg"',
      'done',
      'printf "\\n"',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(wrapperPath, 0o755);
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

  const { buildPiToolRegistry, createImageGenerationTool, createRipgrepTool, createVideoGenerationTool, piTools } = await import('../app/lib/pi/tool-registry');
  const { getDynamicSkillTools, invalidateSkillsCache } = await import('../app/lib/skills/skill-tools');

  const imageCalls: GenerateImageRequestBody[] = [];
  const videoCalls: GenerateVideoRequestBody[] = [];

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

  const originalData = process.env.DATA;
  const tempDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-dynamic-skills-'));
  const skillsRoot = path.join(tempDataRoot, 'skills');
  const binRoot = path.join(skillsRoot, 'bin');
  const workspaceRoot = path.join(tempDataRoot, 'workspace');
  await fs.mkdir(binRoot, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  await writeDynamicSkill(skillsRoot, 'browser-tools', {
    name: 'browser-tools',
    commands: [
      {
        name: 'browser-start',
        exec: ['node', 'browser-start.js'],
        envScope: 'none',
        installStrategy: 'none',
        inputMode: 'structured',
        inputs: [
          {
            name: 'profile',
            type: 'boolean',
            description: 'Use the profile flag.',
            binding: { kind: 'flag', flag: '--profile' },
          },
        ],
      },
      {
        name: 'browser-nav',
        exec: ['node', 'browser-nav.js'],
        envScope: 'none',
        installStrategy: 'none',
        inputMode: 'structured',
        inputs: [
          {
            name: 'url',
            type: 'string',
            required: true,
            description: 'Target URL.',
            binding: { kind: 'positional' },
          },
          {
            name: 'new_tab',
            type: 'boolean',
            description: 'Open a new tab.',
            binding: { kind: 'flag', flag: '--new' },
          },
          {
            name: 'reload',
            type: 'boolean',
            description: 'Reload after navigation.',
            binding: { kind: 'flag', flag: '--reload' },
          },
        ],
      },
      {
        name: 'browser-screenshot',
        exec: ['node', 'browser-screenshot.js'],
        envScope: 'none',
        installStrategy: 'none',
        inputMode: 'none',
      },
      {
        name: 'browser-content',
        exec: ['node', 'browser-content.js'],
        envScope: 'none',
        installStrategy: 'none',
        inputMode: 'structured',
        inputs: [
          {
            name: 'url',
            type: 'string',
            required: true,
            description: 'Readable content target URL.',
            binding: { kind: 'positional' },
          },
        ],
      },
      {
        name: 'browser-eval',
        exec: ['node', 'browser-eval.js'],
        envScope: 'none',
        installStrategy: 'none',
        inputMode: 'structured',
        inputs: [
          {
            name: 'code',
            type: 'string',
            required: true,
            description: 'Code to evaluate.',
            binding: { kind: 'positional' },
          },
        ],
      },
    ],
  });

  await writeDynamicSkill(skillsRoot, 'legacy-skill', {
    name: 'legacy-skill',
    commands: [
      {
        name: 'legacy-command',
        exec: ['bash', 'legacy.sh'],
        envScope: 'none',
        installStrategy: 'none',
      },
    ],
  });

  for (const name of [
    'browser-start',
    'browser-nav',
    'browser-screenshot',
    'browser-content',
    'browser-eval',
    'legacy-command',
  ]) {
    await writeDynamicWrapper(binRoot, name);
  }

  process.env.DATA = tempDataRoot;
  invalidateSkillsCache();

  const dynamicTools = await getDynamicSkillTools();
  assert.equal(dynamicTools.some((tool) => tool.name === 'browser_start'), true);
  assert.equal(dynamicTools.some((tool) => tool.name === 'legacy_command'), true);

  const allTools = await buildPiToolRegistry();
  const browserStartTool = allTools.find((tool) => tool.name === 'browser_start');
  const browserNavTool = allTools.find((tool) => tool.name === 'browser_nav');
  const browserScreenshotTool = allTools.find((tool) => tool.name === 'browser_screenshot');
  const browserContentTool = allTools.find((tool) => tool.name === 'browser_content');
  const browserEvalTool = allTools.find((tool) => tool.name === 'browser_eval');
  const legacyCommandTool = allTools.find((tool) => tool.name === 'legacy_command');

  assert(browserStartTool);
  assert(browserNavTool);
  assert(browserScreenshotTool);
  assert(browserContentTool);
  assert(browserEvalTool);
  assert(legacyCommandTool);

  assert.deepEqual(Object.keys((browserStartTool.parameters as { properties?: Record<string, unknown> }).properties || {}), ['profile']);
  assert.deepEqual(Object.keys((browserNavTool.parameters as { properties?: Record<string, unknown> }).properties || {}), ['url', 'new_tab', 'reload']);
  assert.deepEqual(Object.keys((browserScreenshotTool.parameters as { properties?: Record<string, unknown> }).properties || {}), []);
  assert.deepEqual(Object.keys((browserContentTool.parameters as { properties?: Record<string, unknown> }).properties || {}), ['url']);
  assert.deepEqual(Object.keys((browserEvalTool.parameters as { properties?: Record<string, unknown> }).properties || {}), ['code']);
  assert.deepEqual(Object.keys((legacyCommandTool.parameters as { properties?: Record<string, unknown> }).properties || {}), ['prompt']);

  const browserStartIgnoredPrompt = await browserStartTool.execute('browser-start-ignore', { prompt: 'Start Chromium for a browser tools test.' } as never);
  assert.equal(getText(browserStartIgnoredPrompt).trim(), 'ARGS:');

  const browserStartProfile = await browserStartTool.execute('browser-start-profile', { profile: true });
  assert.equal(getText(browserStartProfile).trim(), 'ARGS: [--profile]');

  const browserNavResult = await browserNavTool.execute('browser-nav-structured', {
    url: 'https://example.com',
    new_tab: true,
    reload: true,
  });
  assert.equal(getText(browserNavResult).trim(), 'ARGS: [https://example.com] [--new] [--reload]');

  const browserContentResult = await browserContentTool.execute('browser-content-structured', {
    url: 'https://example.com/article',
  });
  assert.equal(getText(browserContentResult).trim(), 'ARGS: [https://example.com/article]');

  const browserEvalResult = await browserEvalTool.execute('browser-eval-structured', {
    code: 'document.title',
  });
  assert.equal(getText(browserEvalResult).trim(), 'ARGS: [document.title]');

  const browserScreenshotResult = await browserScreenshotTool.execute('browser-screenshot-none', { prompt: 'ignored' } as never);
  assert.equal(getText(browserScreenshotResult).trim(), 'ARGS:');

  const legacyCommandResult = await legacyCommandTool.execute('legacy-command-prompt', {
    prompt: 'keep legacy prompt mode',
  });
  assert.equal(getText(legacyCommandResult).trim(), 'ARGS: [keep legacy prompt mode]');

  invalidateSkillsCache();
  if (originalData === undefined) {
    delete process.env.DATA;
  } else {
    process.env.DATA = originalData;
  }

  console.log('pi-tool-registry-test: ok');

  moduleInternals._load = originalLoad;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
