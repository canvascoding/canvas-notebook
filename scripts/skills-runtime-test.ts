import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

function encryptValue(value: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(secret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

async function writeSkill(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill for ${name}\n---\n\n# ${name}\n`);
  await fs.writeFile(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function main() {
  const runtime = await import('../server/skills-runtime.js');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-skills-runtime-'));
  const repoSkillsDir = path.join(tempRoot, 'skills');
  const invalidSkillsDir = path.join(tempRoot, 'invalid-skills');
  const launcherPath = path.join(tempRoot, 'scripts', 'run-skill-command.js');

  await fs.mkdir(repoSkillsDir, { recursive: true });
  await fs.mkdir(invalidSkillsDir, { recursive: true });
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(launcherPath, '#!/usr/bin/env node\n', 'utf8');

  await writeSkill(repoSkillsDir, 'single-skill', {
    name: 'single-skill',
    commands: [
      {
        name: 'single-command',
        exec: ['node', 'index.js'],
        envScope: 'integrations',
        installStrategy: 'npm',
      },
    ],
  });

  await writeSkill(repoSkillsDir, 'multi-skill', {
    name: 'multi-skill',
    commands: [
      {
        name: 'multi-one',
        exec: ['node', 'one.js'],
        envScope: 'none',
        installStrategy: 'none',
      },
      {
        name: 'multi-two',
        exec: ['bash', 'two.sh'],
        envScope: 'agents',
        installStrategy: 'none',
      },
    ],
  });

  await writeSkill(invalidSkillsDir, 'broken-skill', {
    name: 'broken-skill',
    commands: [
      {
        name: 'broken-command',
        exec: [],
        envScope: 'integrations',
        installStrategy: 'none',
      },
    ],
  });

  const specs = runtime.listSkillCommandSpecs({ cwd: tempRoot, skillsDir: repoSkillsDir });
  assert.deepEqual(
    specs.map((spec: { name: string }) => spec.name).sort(),
    ['multi-one', 'multi-two', 'single-command'],
  );

  assert.throws(
    () => runtime.listSkillCommandSpecs({ cwd: tempRoot, skillsDir: invalidSkillsDir }),
    /missing a valid exec definition/i,
  );

  const secretsDir = path.join(tempRoot, 'data', 'secrets');
  const masterSecret = 'integration-secret-for-test';
  process.env.INTEGRATIONS_ENV_MASTER_KEY = masterSecret;
  await fs.mkdir(secretsDir, { recursive: true });
  await fs.writeFile(
    path.join(secretsDir, 'Canvas-Integrations.env'),
    [
      'BRAVE_API_KEY=plain-token',
      `GROQ_API_KEY=${encryptValue('super-secret-token', masterSecret)}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const envMap = runtime.readScopedEnvMap('integrations', tempRoot) as Record<string, string>;
  assert.equal(envMap.BRAVE_API_KEY, 'plain-token');
  assert.equal(envMap.GROQ_API_KEY, 'super-secret-token');

  const prepared = runtime.prepareSkillsRuntime({
    cwd: tempRoot,
    repoSkillsDir,
    installGlobalWrappers: false,
    launcherPath,
  });
  assert.equal(prepared.commandSpecs.length, 3);
  await fs.access(path.join(prepared.wrapperDir, 'single-command'));
  await fs.access(path.join(prepared.wrapperDir, 'multi-one'));
  await fs.access(path.join(prepared.wrapperDir, 'multi-two'));

  console.log('skills-runtime-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
