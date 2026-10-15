import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createPiTestDatabase } from './helpers/pi-test-database';

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-search-'));
  const previousEnv = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT,
    RIPGREP_CONFIG_PATH: process.env.RIPGREP_CONFIG_PATH };
  const workspace = path.join(fixture, 'workspace');
  const data = path.join(fixture, 'data');
  process.env.DATA = data;
  process.env.CANVAS_DATA_ROOT = data;
  delete process.env.RIPGREP_CONFIG_PATH;
  const internals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = internals._load;
  let database: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
  try {
    await fs.chmod(fixture, 0o700);
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.mkdir(data, { mode: 0o700 });
    database = await createPiTestDatabase();
    // Only isolate the configured DB. Tools, path policy and execFile are real;
    // no child argv, cwd, environment, output or process execution is replaced.
    internals._load = (request, parent, isMain) => {
      if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request)
        || /^(?:\.\.\/)+db$/u.test(request)) return database;
      return originalLoad(request, parent, isMain);
    };
    const { piTools } = await import('../app/lib/pi/core-tools');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const tools = ['grep', 'rg', 'glob'].map(name => {
      const tool = piTools.find(candidate => candidate.name === name);
      assert.ok(tool, `${name} must be the registered production tool`);
      return tool;
    });
    const context: AgentExecutionContext = { userId: 'search-user', sessionId: 'search-session', agentId: 'search-agent',
      workspaceId: 'search-workspace', workspaceType: 'personal', workspaceName: null, organizationId: null,
      customerId: null, projectId: null, workspaceRoot: workspace, workspaceRootRelativePath: null,
      canWrite: false, canDelete: false, canShare: false, legacy: false };
    const source = path.join(workspace, 'source.md');
    const target = path.join(workspace, 'managed-projection.md');
    const config = path.join(fixture, 'ripgrep.conf');
    const preprocessor = path.join(fixture, 'preprocessor');
    const originalTarget = '# Original projection\n';
    const optionPattern = `--pre=${preprocessor}`;
    const originalSource = `needle\n${optionPattern}\n-n\n--files\n${source}\n`;
    await fs.writeFile(source, originalSource, { mode: 0o600 });
    await fs.writeFile(target, originalTarget, { mode: 0o600 });
    await fs.writeFile(preprocessor, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      `const source = ${JSON.stringify(source)}, target = ${JSON.stringify(target)};`,
      // Before writing anything, require the one exact owned synthetic input.
      'if (process.argv.length !== 3 || fs.realpathSync(process.argv[2]) !== fs.realpathSync(source)) process.exit(73);',
      'fs.appendFileSync(target, "UNAUTHORIZED PREPROCESSOR WRITE\\n");',
      'process.stdout.write(fs.readFileSync(source));',
      '',
    ].join('\n'), { mode: 0o700 });

    const failures: string[] = [];
    let passed = 0;
    const check = async (name: string, body: () => Promise<void>) => {
      try { await body(); await unchanged(); passed++; console.log(`PASS ${name}`); }
      catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
      finally { delete process.env.RIPGREP_CONFIG_PATH; await fs.writeFile(target, originalTarget); }
    };
    const execute = async (tool: AgentTool, params: Record<string, unknown>, signal?: AbortSignal) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 5_000);
      try {
        const result = await runWithAgentExecutionContext(context, () => tool.execute(`search-${passed}`, params,
          signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal));
        assert.equal(deadline.signal.aborted, false, 'owned rg must finish within its test deadline');
        return textOf(result);
      } finally { clearTimeout(timer); }
    };
    const configure = async (lines: string[]) => {
      await fs.writeFile(config, lines.join('\n') + '\n', { mode: 0o600 });
      process.env.RIPGREP_CONFIG_PATH = config;
    };
    const unchanged = async () => {
      assert.equal(await fs.readFile(target, 'utf8'), originalTarget);
      assert.equal(await fs.readFile(source, 'utf8'), originalSource);
    };

    for (const tool of tools.filter(tool => tool.name !== 'glob')) {
      await check(`${tool.name}: real regex search and no matches`, async () => {
        assert.match(await execute(tool, { pattern: '^need(le)$', path: 'source.md' }), /1:needle/u);
        assert.equal(await execute(tool, { pattern: 'absent-token', path: 'source.md' }), '(no matches found)');
        assert.match(await execute(tool, { pattern: '[', path: 'source.md' }), /^Error:/u);
        await unchanged();
      });
      await check(`${tool.name}: option-shaped patterns cannot launch a preprocessor`, async () => {
        // Even the vulnerable original argv remains bounded: --regexp makes ALL
        // positionals input paths, both are this exact owned file. cwd '/' is
        // unchanged; no default recursive search is ever requested in RED.
        await configure(tool.name === 'grep' ? ['--regexp=.', '--max-depth=0', source] : ['--max-depth=0']);
        for (const [index, pattern] of [optionPattern, '-n', '--files'].entries()) {
          const result = await execute(tool, { pattern, path: 'source.md' });
          await unchanged();
          assert.equal(result, `${index + 2}:${pattern}\n`, `${pattern} must be searched as data`);
        }
      });
      await check(`${tool.name}: external rg config cannot execute a process`, async () => {
        await configure([`--pre=${preprocessor}`, '--max-depth=0']);
        const result = await execute(tool, { pattern: 'needle', path: 'source.md' });
        await unchanged();
        assert.match(result, /1:needle/u);
      });
    }

    const foreign = path.join(fixture, 'foreign.md');
    await fs.writeFile(foreign, 'needle in a different workspace\n', { mode: 0o600 });
    for (const tool of tools) {
      await check(`${tool.name}: config cannot extend the authorized search scope`, async () => {
        // With an injected regexp, the old tools treat their pattern as an input
        // path. Use the exact owned source as that pattern too, never '/needle'.
        await configure(tool.name === 'glob' ? ['--max-depth=0', foreign]
          : ['--regexp=needle', '--max-depth=0', foreign]);
        const result = await execute(tool, { pattern: tool.name === 'glob' ? '*.md' : source,
          path: tool.name === 'glob' ? workspace : source });
        assert.doesNotMatch(result, /foreign\.md|different workspace/u);
        if (tool.name === 'glob') assert.ok(result.split('\n').includes(source));
        else assert.equal(result, `5:${source}\n`);
        await unchanged();
      });
      await check(`${tool.name}: real path protection and abort`, async () => {
        const denied = 'Error: Agent file access is limited to the workspace bound to this chat session or trusted runtime intake paths.';
        assert.equal(await execute(tool, { pattern: 'needle', path: foreign }), denied);
        assert.equal(await execute(tool, { pattern: 'needle', path: path.join(data, 'secrets', 'secret.env') }), denied);
        assert.equal(await execute(tool, { pattern: 'needle', path: source }, AbortSignal.abort()), 'Error: Tool execution aborted.');
        assert.match(await execute(tool, { pattern: 'needle', path: path.join(workspace, 'missing') }), /^Error:/u);
        await unchanged();
      });
    }
    const rg = tools.find(tool => tool.name === 'rg')!;
    await check('rg: case, glob, hidden and result limits survive', async () => {
      await fs.writeFile(path.join(workspace, '.hidden.md'), 'NEEDLE\nNEEDLE\n', { mode: 0o600 });
      await fs.writeFile(path.join(workspace, 'other.txt'), 'needle\n', { mode: 0o600 });
      const result = await execute(rg, { pattern: 'needle', path: '.', glob: '*.md', ignoreCase: true, hidden: true, maxResults: 1 });
      assert.match(result, /\.hidden\.md:1:NEEDLE/u);
      assert.doesNotMatch(result, /\.hidden\.md:2:|other\.txt/u);
    });
    assert.equal(failures.length, 0, `${failures.length} failed search process cases: ${failures.join('; ')}`);
    console.log(`agent-search-process-test: ${passed} real tool/rg cases passed`);
  } finally {
    internals._load = originalLoad;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await database?.close();
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
