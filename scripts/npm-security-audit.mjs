import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const advisory = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
// Parser bytes after applying upstream micromatch/picomatch@7be3276fb8bd215a8c73fa066bcaf696c244ad88.
const patchedParserHashes = new Map([
  ['2.3.2', '1e6d1c7e918de620b6bc353c254c95abe34851c76d975662bf9f218f4323a2b9'],
  ['4.0.5', '8f4126281f0143b298b2d3dd5014a7a0ed6a921c56c4406be88ef21658576e9e'],
]);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function verifyPicomatchPatches(root) {
  const packages = readJson(path.join(root, 'package-lock.json')).packages;
  const copies = Object.entries(packages).filter(([name]) => name.endsWith('/node_modules/picomatch') || name === 'node_modules/picomatch');
  if (!copies.length) throw new Error('No locked Picomatch copies found for the audit exception.');
  return new Set(copies.map(([name, pkg]) => {
    const directory = path.resolve(root, name);
    if (!directory.startsWith(path.join(root, 'node_modules') + path.sep) || realpathSync(directory) !== directory) {
      throw new Error(`Unexpected Picomatch installation path: ${name}`);
    }
    const installed = readJson(path.join(directory, 'package.json'));
    const hash = createHash('sha256').update(readFileSync(path.join(directory, 'lib/parse.js'))).digest('hex');
    if (installed.name !== 'picomatch' || installed.version !== pkg.version || hash !== patchedParserHashes.get(pkg.version)) {
      throw new Error(`Unverified Picomatch patch: ${name}@${pkg.version}`);
    }
    return name;
  }));
}

export function auditBlockers(vulnerabilities, verifiedPaths) {
  const root = vulnerabilities.picomatch;
  const verifiedAdvisory = root?.nodes?.length > 0 && root.nodes.every(node => verifiedPaths.has(node))
    && root?.via?.length === 1 && root.via[0]?.name === 'picomatch' && root.via[0]?.url === advisory;
  const names = Object.keys(vulnerabilities);
  if (!verifiedAdvisory) return names;

  return names.filter(name => {
    const visited = new Set();
    const pending = [name];
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === 'picomatch') continue;
      const causes = Object.hasOwn(vulnerabilities, current) && vulnerabilities[current].via;
      if (!Array.isArray(causes) || !causes.length || causes.some(cause => typeof cause !== 'string')) {
        return true;
      }
      pending.push(...causes);
    }
    // npm can report cycles among mutually dependent packages. Require an actual
    // path to the verified advisory and reject any other root or unknown cause.
    return !visited.has('picomatch');
  });
}

function runAudit() {
  const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const audit = spawnSync('npm', ['audit', '--audit-level=low', '--json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  if (audit.error) throw audit.error;
  const report = JSON.parse(audit.stdout);
  if (
    report.error || report.auditReportVersion !== 2
    || !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || ![0, 1].includes(audit.status)
  ) {
    throw new Error(`npm audit did not return a valid report (exit ${audit.status}). ${audit.stderr}`);
  }
  const { vulnerabilities } = report;
  const names = Object.keys(vulnerabilities);
  if (!names.length && audit.status !== 0) throw new Error('npm audit failed without reporting any findings.');

  const verifiedPaths = vulnerabilities.picomatch ? verifyPicomatchPatches(root) : new Set();
  const remaining = auditBlockers(vulnerabilities, verifiedPaths);
  for (const name of remaining) console.error(name, JSON.stringify(vulnerabilities[name]));
  if (remaining.length) throw new Error(`npm audit blocked by ${remaining.length} finding(s).`);
  if (names.length) console.log(`Verified all ${verifiedPaths.size} patched Picomatch copies. Excepted GHSA-fc5q-39xc-vjpf and its derived findings.`);
  else console.log('npm audit reported no findings.');
}

if (import.meta.main) {
  try {
    runAudit();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
