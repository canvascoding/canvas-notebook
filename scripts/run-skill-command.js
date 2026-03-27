#!/usr/bin/env node

const { loadAppEnv } = require('../server/load-app-env');
const { runSkillCommand } = require('../server/skills-runtime');

loadAppEnv(process.cwd());

const [commandName, ...args] = process.argv.slice(2);

if (!commandName) {
  console.error('Usage: run-skill-command.js <command-name> [args...]');
  process.exit(1);
}

try {
  const exitCode = runSkillCommand(commandName, args, {
    cwd: process.cwd(),
    executionCwd: process.cwd(),
  });
  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
