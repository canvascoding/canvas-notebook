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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-data-'));
  process.env.DATA = dataDir;

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

  const { enableToolInConfig, getDefaultEnabledToolNames, serializeEnabledToolNames } = await import('../app/lib/pi/enabled-tools');
  const { buildPiToolRegistry, createRipgrepTool, createStudioGenerateImageTool, createStudioGenerateVideoTool, getPiToolMetadata, getPiTools, piTools } = await import('../app/lib/pi/tool-registry');

  const studioCalls: StudioGenerateRequest[] = [];
  const studioImageCalls: StudioGenerateRequest[] = [];
  const studioImageMediaUrl = '/api/studio/media/studio/outputs/studio-gen-ente-statt-affe-0-2026-05-29T15-38-00-000Z-test.jpg';
  const studioImageTool = createStudioGenerateImageTool({
    userId: 'test-user',
    executeStudioGenerationFn: async (_userId, body) => {
      studioImageCalls.push(body);
      return {
        generationId: 'studio-image-generation',
        status: 'completed',
        mode: body.mode || 'image',
        prompt: body.prompt,
        outputs: [
          {
            id: 'studio-image-output',
            variationIndex: 0,
            filePath: 'studio-gen-ente-statt-affe-0-2026-05-29T15-38-00-000Z-test.jpg',
            mediaUrl: studioImageMediaUrl,
            mimeType: 'image/jpeg',
            fileSize: 2345,
          },
        ],
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
  const readTool = piTools.find((tool) => tool.name === 'read');
  const lsTool = piTools.find((tool) => tool.name === 'ls');
  const bashTool = piTools.find((tool) => tool.name === 'bash');

  assert.equal(piTools.some((tool) => tool.name === 'rg'), true);
  assert.equal(piTools.some((tool) => tool.name === 'qmd'), false);
  assert.equal(piTools.some((tool) => tool.name === 'qmd_search'), false);
  assert.ok(readTool);
  assert.ok(lsTool);
  assert.ok(bashTool);

  const secretsDir = path.join(dataDir, 'secrets');
  const secretFile = path.join(secretsDir, 'Canvas-Integrations.env');
  await fs.mkdir(secretsDir, { recursive: true });
  await fs.writeFile(secretFile, 'OPENROUTER_API_KEY=should-not-leak\n', 'utf8');

  const blockedReadResult = await readTool.execute('read-secret', { path: secretFile });
  assert.match(getText(blockedReadResult), /restricted/i);

  const blockedLsResult = await lsTool.execute('ls-secret', { path: secretsDir });
  assert.match(getText(blockedLsResult), /restricted/i);

  const blockedRgResult = await rgTool.execute('rg-secret', {
    pattern: 'OPENROUTER',
    path: secretsDir,
  });
  assert.match(getText(blockedRgResult), /restricted/i);

  const blockedBashResult = await bashTool.execute('bash-secret-env', { command: 'printenv' });
  assert.match(getText(blockedBashResult), /environment variables|restricted secret paths/i);

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

  const studioImageResult = await studioImageTool.execute('studio-image', {
    prompt: 'Eine Ente statt einem Affen',
    provider: 'gemini',
  });
  const studioImageText = getText(studioImageResult);
  assert.match(studioImageText, /Studio image generation completed \(1 output/);
  assert.match(studioImageText, /Markdown image \(copy exactly\): !\[studio-0\]\(\/api\/studio\/media\/studio\/outputs\/studio-gen-ente-statt-affe/);
  assert.match(studioImageText, /Do not invent, shorten, slugify, or rewrite the image URL/);
  assert.equal(studioImageCalls.length, 1);
  assert.equal(studioImageCalls[0].mode, 'image');

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
  const defaultEnabledTools = getDefaultEnabledToolNames(allTools.map((tool) => tool.name));
  assert.equal(defaultEnabledTools.has('mcp'), true);
  assert.equal(defaultEnabledTools.has('memory'), true);
  assert.equal(allTools.some((tool) => tool.name === 'memory'), true);
  assert.equal(defaultEnabledTools.has('delegate_task'), true);
  assert.equal(allTools.some((tool) => tool.name === 'delegate_task'), true);
  assert.equal(defaultEnabledTools.has('session_search'), true);
  assert.equal(allTools.some((tool) => tool.name === 'session_search'), true);
  assert.equal(allTools.some((tool) => tool.name === 'studio_bulk_generate'), true);
  assert.equal(defaultEnabledTools.has('studio_bulk_generate'), false);
  assert.equal((await getPiTools()).some((tool) => tool.name === 'studio_bulk_generate'), false);
  assert.deepEqual(
    enableToolInConfig('studio_bulk_generate', [], allTools.map((tool) => tool.name)),
    allTools.map((tool) => tool.name),
  );
  assert.deepEqual(serializeEnabledToolNames(defaultEnabledTools, allTools.map((tool) => tool.name)), []);
  assert.equal(allTools.every((tool) => !['browser_start', 'browser_nav', 'brave_search', 'transcribe'].includes(tool.name)), true);
  assert.equal(allTools.some((tool) => tool.name === 'image_generation'), false);
  assert.equal(allTools.some((tool) => tool.name === 'video_generation'), false);
  assert.equal(allTools.some((tool) => tool.name === 'studio_edit_image'), false);

  const metadata = await getPiToolMetadata();
  const memoryMetadata = metadata.find((tool) => tool.name === 'memory');
  assert.ok(memoryMetadata);
  assert.equal(memoryMetadata.group, 'Memory');
  assert.deepEqual(memoryMetadata.toolsets, ['memory']);
  assert.equal(memoryMetadata.planningModeAllowed, false);
  const sessionSearchMetadata = metadata.find((tool) => tool.name === 'session_search');
  assert.ok(sessionSearchMetadata);
  assert.equal(sessionSearchMetadata.group, 'Session');
  assert.deepEqual(sessionSearchMetadata.toolsets, ['session_search']);
  assert.equal(sessionSearchMetadata.planningModeAllowed, true);
  const delegateTaskMetadata = metadata.find((tool) => tool.name === 'delegate_task');
  assert.ok(delegateTaskMetadata);
  assert.equal(delegateTaskMetadata.group, 'Delegation');
  assert.deepEqual(delegateTaskMetadata.toolsets, ['delegation']);
  assert.equal(delegateTaskMetadata.planningModeAllowed, false);

  console.log('pi-tool-registry-test: ok');

  moduleInternals._load = originalLoad;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
