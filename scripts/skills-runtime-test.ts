import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  });
  assert.equal(prepared.commandSpecs.length, 3);
  const singleWrapperPath = path.join(prepared.wrapperDir, 'single-command');
  await fs.access(singleWrapperPath);
  await fs.access(path.join(prepared.wrapperDir, 'multi-one'));
  await fs.access(path.join(prepared.wrapperDir, 'multi-two'));
  const wrapperContent = await fs.readFile(singleWrapperPath, 'utf8');
  assert.match(wrapperContent, /CANVAS_SKILLS_LAUNCHER_PATH/);
  assert.match(wrapperContent, /CANVAS_APP_ROOT/);
  assert.doesNotMatch(wrapperContent, new RegExp(launcherPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const globalWrites: string[] = [];
  const originalWriteFileSync = fsSync.writeFileSync;
  try {
    fsSync.writeFileSync = ((file: fsSync.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof file === 'string' && file.startsWith('/usr/local/bin/')) {
        globalWrites.push(file);
      }
      return originalWriteFileSync(file, ...(args as [never, never?]));
    }) as typeof fsSync.writeFileSync;
    runtime.prepareSkillsRuntime({
      cwd: tempRoot,
      repoSkillsDir,
    });
  } finally {
    fsSync.writeFileSync = originalWriteFileSync;
  }
  assert.deepEqual(globalWrites, []);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    console.warn = (message?: unknown, ...args: unknown[]) => {
      warnings.push([message, ...args].map(String).join(' '));
    };
    const unwritableGlobalDir = path.join(tempRoot, 'readonly-bin');
    await fs.mkdir(unwritableGlobalDir, { recursive: true, mode: 0o555 });
    runtime.prepareSkillsRuntime({
      cwd: tempRoot,
      repoSkillsDir,
      installGlobalWrappers: true,
      globalWrapperDir: unwritableGlobalDir,
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipping global wrapper install/i);
  assert.match(warnings[0], /Using .*\/bin via PATH instead/i);

  const missingEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  delete missingEnv.CANVAS_APP_ROOT;
  delete missingEnv.CANVAS_SKILLS_LAUNCHER_PATH;

  const missingEnvResult = spawnSync(singleWrapperPath, [], {
    cwd: tempRoot,
    env: missingEnv,
    encoding: 'utf8',
  });
  assert.equal(missingEnvResult.status, 1);
  assert.match(missingEnvResult.stderr, /Missing skill launcher path/i);

  const appRootResult = spawnSync(singleWrapperPath, [], {
    cwd: tempRoot,
    env: {
      ...process.env,
      CANVAS_APP_ROOT: tempRoot,
    },
    encoding: 'utf8',
  });
  assert.equal(appRootResult.status, 0);

  const explicitLauncherResult = spawnSync(singleWrapperPath, [], {
    cwd: tempRoot,
    env: {
      ...process.env,
      CANVAS_SKILLS_LAUNCHER_PATH: launcherPath,
    },
    encoding: 'utf8',
  });
  assert.equal(explicitLauncherResult.status, 0);

  console.log('skills-runtime-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
