#!/usr/bin/env node

const { loadAppEnv } = require('../server/load-app-env');
const { prepareSkillsRuntime } = require('../server/skills-runtime');

loadAppEnv(process.cwd());

try {
  const result = prepareSkillsRuntime({ cwd: process.cwd() });
  console.log(`[skills-runtime] Prepared ${result.commandSpecs.length} command wrappers in ${result.wrapperDir}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[skills-runtime] Failed to prepare skills runtime: ${message}`);
  process.exit(1);
}
