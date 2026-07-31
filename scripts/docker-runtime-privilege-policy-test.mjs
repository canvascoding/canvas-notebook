import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = await readFile(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
const entrypoint = await readFile(path.join(repositoryRoot, 'scripts/docker-entrypoint.sh'), 'utf8');

assert.doesNotMatch(
  dockerfile,
  /\bNOPASSWD\s*:\s*ALL\b/,
  'The runtime image must never grant passwordless unrestricted sudo.'
);
assert.doesNotMatch(
  dockerfile,
  /apt-get install[^\n]*\bsudo\b/,
  'The runtime image must not install sudo.'
);
assert.doesNotMatch(
  entrypoint,
  /(?:^|\s)sudo(?:\s|$)/m,
  'The container entrypoint must not rely on runtime privilege escalation.'
);
assert.match(
  dockerfile,
  /^USER \$\{APP_USER\}$/m,
  'The final runtime image must run as the unprivileged application user.'
);
assert.match(
  entrypoint,
  /https:\/\/ollama\.com\/download\/ollama-linux-\$\{ollama_arch\}\.tar\.zst/,
  'Optional Ollama installation should use the user-writable runtime cache.'
);
assert.match(
  entrypoint,
  /ln -sf \/data\/cache\/ollama\/bin\/ollama "\$\{NPM_CONFIG_PREFIX\}\/bin\/ollama"/,
  'The user-local Ollama binary must remain available on the configured PATH.'
);

console.log('docker-runtime-privilege-policy-test: ok');
