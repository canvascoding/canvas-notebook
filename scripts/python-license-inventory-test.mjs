import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = fs.readFileSync(new URL('./capture-runtime-component-inventory.mjs', import.meta.url), 'utf8');
const match = source.match(/const pythonInventoryScript = String\.raw`([\s\S]*?)`;/u);
assert(match, 'the Python runtime inventory collector must be available');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-python-license-inventory-'));
try {
  const distInfo = path.join(root, 'auditav-18.1.0.dist-info');
  const licenses = path.join(distInfo, 'licenses');
  const bytecode = path.join(licenses, '__pycache__');
  fs.mkdirSync(bytecode, { recursive: true });
  fs.writeFileSync(path.join(distInfo, 'METADATA'), 'Metadata-Version: 2.3\nName: auditav\nVersion: 18.1.0\nLicense-Expression: BSD-3-Clause\n');
  fs.writeFileSync(path.join(licenses, 'LICENSE'), 'BSD-3-Clause license text\n');
  fs.writeFileSync(path.join(licenses, 'AUTHORS'), 'PyAV-style attribution\n');
  fs.writeFileSync(path.join(bytecode, 'AUTHORS.cpython-311.pyc'), 'bytecode');
  fs.writeFileSync(path.join(distInfo, 'RECORD'), [
    'auditav-18.1.0.dist-info/METADATA,,',
    'auditav-18.1.0.dist-info/licenses/LICENSE,,',
    'auditav-18.1.0.dist-info/licenses/AUTHORS,,',
    'auditav-18.1.0.dist-info/licenses/__pycache__/AUTHORS.cpython-311.pyc,,',
    'auditav-18.1.0.dist-info/RECORD,,',
  ].join('\n'));
  const result = spawnSync('python3', ['-c', match[1]], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  assert.equal(result.status, 0, result.stderr);
  const packages = JSON.parse(result.stdout);
  const fixture = packages.find((candidate) => candidate.name === 'auditav' && candidate.version === '18.1.0');
  assert(fixture, 'the synthetic wheel must be discovered');
  assert.deepEqual(
    fixture.licenseFiles.map((entry) => path.basename(entry.path)).sort(),
    ['AUTHORS', 'LICENSE'],
  );
  assert(fixture.licenseFiles.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)));
  console.log('Python PEP-639 license evidence excludes nested bytecode while retaining text files');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
