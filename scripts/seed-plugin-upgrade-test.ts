import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
  const repositoryRoot = process.cwd();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-seed-plugin-upgrade-'));
  const dataRoot = path.join(fixtureRoot, 'data');
  const pluginRoot = path.join(fixtureRoot, 'seed_plugins', 'document-suite');
  const skillRoot = path.join(fixtureRoot, 'seed_skills', 'docx');
  const bootstrapScript = path.join(repositoryRoot, 'scripts', 'bootstrap-agent-runtime.ts');
  const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  async function writeSeed(version: string, marker: string) {
    await fs.mkdir(path.join(pluginRoot, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(path.join(pluginRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'document-suite',
      version,
      description: 'Upgrade fixture',
      source: 'seed',
      skillRefs: ['docx'],
    }, null, 2));
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: docx',
      'description: "Upgrade fixture skill"',
      '---',
      '',
      `# ${marker}`,
      '',
    ].join('\n'));
  }

  async function runBootstrap() {
    await execFileAsync(process.execPath, [
      tsxCli,
      '--tsconfig',
      path.join(repositoryRoot, 'tsconfig.json'),
      bootstrapScript,
    ], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATA: dataRoot,
        CANVAS_DATA_ROOT: dataRoot,
        CANVAS_DATABASE_PROVIDER: 'sqlite',
        DATABASE_URL: '',
        CANVAS_BOOTSTRAP_SEED_PLUGINS: 'document-suite',
        CANVAS_BOOTSTRAP_SEED_SKILLS: '__none__',
      },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  try {
    await writeSeed('1.0.0', 'ORIGINAL MANAGED CONTENT');
    await runBootstrap();
    const installedSkillPath = path.join(dataRoot, 'skills', 'docx', 'SKILL.md');
    assert.match(await fs.readFile(installedSkillPath, 'utf8'), /ORIGINAL MANAGED CONTENT/);
    const firstPluginRegistry = JSON.parse(
      await fs.readFile(path.join(dataRoot, 'plugins', 'registry.json'), 'utf8'),
    ) as { plugins: Record<string, { installedAt: string; version: string }> };
    const installedAt = firstPluginRegistry.plugins['document-suite'].installedAt;

    await writeSeed('1.1.0', 'UPDATED MANAGED CONTENT');
    await runBootstrap();
    assert.match(await fs.readFile(installedSkillPath, 'utf8'), /UPDATED MANAGED CONTENT/);
    const upgradedPluginRegistry = JSON.parse(
      await fs.readFile(path.join(dataRoot, 'plugins', 'registry.json'), 'utf8'),
    ) as { plugins: Record<string, { installedAt: string; version: string }> };
    assert.equal(upgradedPluginRegistry.plugins['document-suite'].version, '1.1.0');
    assert.equal(upgradedPluginRegistry.plugins['document-suite'].installedAt, installedAt);

    await fs.appendFile(installedSkillPath, '\nUser-owned local customization.\n');
    await writeSeed('1.2.0', 'NEW SEED MUST NOT OVERWRITE USER CONTENT');
    await runBootstrap();
    const preservedSkill = await fs.readFile(installedSkillPath, 'utf8');
    assert.match(preservedSkill, /UPDATED MANAGED CONTENT/);
    assert.match(preservedSkill, /User-owned local customization/);
    assert.doesNotMatch(preservedSkill, /NEW SEED MUST NOT OVERWRITE USER CONTENT/);

    const finalPluginRegistry = JSON.parse(
      await fs.readFile(path.join(dataRoot, 'plugins', 'registry.json'), 'utf8'),
    ) as { plugins: Record<string, { version: string; skills: Array<{ preexistingStandalone?: boolean }> }> };
    assert.equal(finalPluginRegistry.plugins['document-suite'].version, '1.2.0');
    assert.equal(finalPluginRegistry.plugins['document-suite'].skills[0].preexistingStandalone, true);

    console.log('seed-plugin-upgrade-test: ok');
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

void main();
