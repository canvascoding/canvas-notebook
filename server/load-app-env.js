/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function resolveEnvFilePath(filePath, cwd = process.cwd()) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function loadAppEnv(cwd = process.cwd()) {
  const configuredPath = process.env.CANVAS_ENV_FILE?.trim();
  const defaultPath =
    process.env.CANVAS_RUNTIME_ENV === 'docker'
      ? '.env.docker'
      : process.env.NODE_ENV === 'production'
        ? null
        : '.env.local';
  const selectedPath = configuredPath || defaultPath;
  if (!selectedPath) {
    return null;
  }

  const resolvedPath = resolveEnvFilePath(selectedPath, cwd);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  dotenv.config({
    path: resolvedPath,
    override: false,
  });

  process.env.CANVAS_ENV_FILE = resolvedPath;
  return resolvedPath;
}

module.exports = {
  loadAppEnv,
};
