const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveAppRoot() {
  const scriptDir = __dirname;
  const candidates = [
    process.env.CANVAS_APP_ROOT?.trim(),
    '/app',
    process.cwd(),
    path.resolve(scriptDir, '..', '..'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const tsxPath = path.join(candidate, 'node_modules', '.bin', 'tsx');
    const runnerPath = path.join(candidate, 'scripts', 'run-local-skill.ts');
    if (fs.existsSync(tsxPath) && fs.existsSync(runnerPath)) {
      return candidate;
    }
  }

  throw new Error('Could not locate Canvas Notebook app root for local skill execution.');
}

function runLocalSkill(skillName, payload) {
  const appRoot = resolveAppRoot();
  const tsxPath = path.join(appRoot, 'node_modules', '.bin', 'tsx');
  const runnerPath = path.join(appRoot, 'scripts', 'run-local-skill.ts');
  const result = spawnSync(tsxPath, [runnerPath, skillName, JSON.stringify(payload)], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

module.exports = {
  runLocalSkill,
};
