import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  const { buildPiToolRegistry, createRipgrepTool, createStudioGenerateVideoTool, piTools } = await import('../app/lib/pi/tool-registry');

  const studioCalls: StudioGenerateRequest[] = [];
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
  assert.equal(allTools.some((tool) => tool.name === 'image_generation'), false);
  assert.equal(allTools.some((tool) => tool.name === 'video_generation'), false);

  console.log('pi-tool-registry-test: ok');

  moduleInternals._load = originalLoad;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
