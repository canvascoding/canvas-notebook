const fs = require('node:fs');
const path = require('node:path');

// Container images carry the resolved build configuration, rather than the
// TypeScript config and its build-time plugins. Use the same configuration as
// the built routes; falling back to Next defaults changes production behavior.
function loadProductionNextConfig(dev, directory = process.cwd()) {
  if (dev) return undefined;
  const filename = path.join(directory, '.next', 'required-server-files.json');
  const { config } = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.distDir !== 'string' || !config.distDir) {
    throw new Error('The production Next.js build configuration is missing or invalid.');
  }
  return config;
}

module.exports = { loadProductionNextConfig };
