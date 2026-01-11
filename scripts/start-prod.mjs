import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const envPath = path.resolve('.env.local');

try {
  const content = readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  });
} catch {
  // ignore missing env file
}

const require = createRequire(import.meta.url);
require('../server.js');
