import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repository, 'packages/decision-models');
const targetFlag = process.argv.indexOf('--target');
const check = process.argv.includes('--check');
if (targetFlag < 0 || !process.argv[targetFlag + 1]) throw new Error('Provide --target /absolute/control-plane');
const targetRepository = await realpath(process.argv[targetFlag + 1]);
if (targetRepository === repository) throw new Error('Target must be a separate repository');
const target = path.join(targetRepository, 'packages/decision-models');
const files = ['package.json', 'tsconfig.json', 'README.md'];
async function collect(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Package sources cannot contain symlinks');
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), name);
    else if (entry.isFile()) files.push(name);
  }
}
await collect(path.join(source, 'src'), 'src');
files.sort();
const contents = await Promise.all(files.map(file => readFile(path.join(source, file))));
const manifest = {
  package: '@canvas/decision-models',
  version: JSON.parse(contents[files.indexOf('package.json')].toString()).version,
  files: Object.fromEntries(files.map((file, index) => [file, createHash('sha256').update(contents[index]).digest('hex')])),
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
if (check) {
  if (await readFile(path.join(source, 'source-manifest.json'), 'utf8') !== manifestText) throw new Error('Canonical package manifest is stale');
  if (await readFile(path.join(target, 'source-manifest.json'), 'utf8') !== manifestText) throw new Error('Target package manifest differs');
  for (let i = 0; i < files.length; i++) if (!contents[i].equals(await readFile(path.join(target, files[i])))) throw new Error(`Target source differs: ${files[i]}`);
} else {
  await mkdir(target, { recursive: true });
  for (let i = 0; i < files.length; i++) {
    await mkdir(path.dirname(path.join(target, files[i])), { recursive: true });
    await writeFile(path.join(target, files[i]), contents[i]);
  }
  await writeFile(path.join(source, 'source-manifest.json'), manifestText);
  await writeFile(path.join(target, 'source-manifest.json'), manifestText);
}
console.log(`Decision package ${manifest.version} ${check ? 'verified' : 'synchronized'}.`);
