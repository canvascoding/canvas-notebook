import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

import { thirdPartyCompliancePaths } from './third-party-license-inventory';

type LockPackage = {
  version?: string;
  resolved?: string;
};

type CacheEntry = {
  packagePath: string;
  name: string;
  version: string;
  sourceUrl: string | null;
  licenseFileName: string | null;
  licenseText: string | null;
  noticeTexts: string[];
  copyrightNotices: string[];
};

type LicensePolicy = {
  packageOverrides?: Record<string, {
    licenseTextPath?: string | null;
  }>;
};

const LICENSE_PATTERN = /^(?:licen[cs]e|copying|copyright)(?:[._-].*)?$/iu;
const NOTICE_PATTERN = /^notice(?:[._-].*)?$/iu;

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd() + '\n';
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function packageNameFromLockPath(packagePath: string): string {
  const withoutRoot = packagePath.replace(/^node_modules\//u, '');
  const nestedPath = withoutRoot.split('/node_modules/').at(-1) || withoutRoot;
  const segments = nestedPath.split('/');
  return nestedPath.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function repositoryUrl(value: unknown): string | null {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'url' in value
      ? String((value as { url?: unknown }).url || '')
      : '';
  if (!raw) return null;
  return raw.replace(/^git\+/u, '').replace(/^git:\/\//u, 'https://').replace(/\.git$/u, '');
}

function extractCopyrightNotices(...texts: string[]): string[] {
  const values = new Set<string>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const normalized = line.trim().replace(/^[*#/\s-]+/u, '').trim();
      if (/\bcopyright\b|\(c\)|©/iu.test(normalized) && normalized.length <= 500) {
        values.add(normalized);
      }
    }
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function hasLocalLicenseFile(packagePath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(thirdPartyCompliancePaths.root, packagePath));
    return entries.some((entry) => LICENSE_PATTERN.test(entry));
  } catch {
    return false;
  }
}

async function extractPackageLicense(
  packagePath: string,
  lockPackage: LockPackage,
): Promise<CacheEntry> {
  const version = String(lockPackage.version || '');
  const name = packageNameFromLockPath(packagePath);
  if (!lockPackage.resolved?.startsWith('http')) {
    return {
      packagePath,
      name,
      version,
      sourceUrl: null,
      licenseFileName: null,
      licenseText: null,
      noticeTexts: [],
      copyrightNotices: [],
    };
  }

  const response = await fetch(lockPackage.resolved);
  if (!response.ok) {
    throw new Error(`Could not download ${name}@${version}: HTTP ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-license-cache-'));
  const archivePath = path.join(tempRoot, 'package.tgz');
  const extractRoot = path.join(tempRoot, 'package');
  await fs.mkdir(extractRoot, { recursive: true });
  await fs.writeFile(archivePath, archive);
  try {
    await tar.x({
      cwd: extractRoot,
      file: archivePath,
      strip: 1,
      filter: (entryPath) => {
        const normalized = entryPath.replace(/^package\//u, '');
        if (normalized === 'package.json') return true;
        if (normalized.includes('/')) return false;
        return LICENSE_PATTERN.test(normalized) || NOTICE_PATTERN.test(normalized);
      },
    });
    const entries = await fs.readdir(extractRoot);
    const licenseFileName = entries.filter((entry) => LICENSE_PATTERN.test(entry)).sort()[0] || null;
    const noticeFileNames = entries.filter((entry) => NOTICE_PATTERN.test(entry)).sort();
    const licenseText = licenseFileName
      ? normalizeText(await fs.readFile(path.join(extractRoot, licenseFileName), 'utf8'))
      : null;
    const noticeTexts = await Promise.all(
      noticeFileNames.map(async (entry) => normalizeText(await fs.readFile(path.join(extractRoot, entry), 'utf8'))),
    );
    const packageJson = await readOptionalJson<{
      repository?: unknown;
      homepage?: string;
    }>(path.join(extractRoot, 'package.json'));
    return {
      packagePath,
      name,
      version,
      sourceUrl: repositoryUrl(packageJson?.repository) || packageJson?.homepage || lockPackage.resolved,
      licenseFileName,
      licenseText,
      noticeTexts,
      copyrightNotices: extractCopyrightNotices(
        ...(licenseText ? [licenseText] : []),
        ...noticeTexts,
      ),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function main() {
  const lockfileRaw = await fs.readFile(path.join(thirdPartyCompliancePaths.root, 'package-lock.json'));
  const lockfile = JSON.parse(lockfileRaw.toString('utf8')) as {
    packages: Record<string, LockPackage>;
  };
  const policy = JSON.parse(await fs.readFile(thirdPartyCompliancePaths.policy, 'utf8')) as LicensePolicy;
  const candidates = await Promise.all(
    Object.entries(lockfile.packages)
      .filter(([packagePath, lockPackage]) => (
        packagePath.startsWith('node_modules/')
        && Boolean(lockPackage.version)
      ))
      .map(async ([packagePath, lockPackage]) => {
        const name = packageNameFromLockPath(packagePath);
        const version = String(lockPackage.version);
        const override = policy.packageOverrides?.[`${name}@${version}`]
          || policy.packageOverrides?.[name];
        const overrideHasLicense = Boolean(
          override?.licenseTextPath
          && await fs.access(path.resolve(thirdPartyCompliancePaths.root, override.licenseTextPath))
            .then(() => true)
            .catch(() => false),
        );
        return {
          packagePath,
          lockPackage,
          needsCache: !overrideHasLicense && !await hasLocalLicenseFile(packagePath),
        };
      }),
  );
  const missing = candidates
    .filter((entry) => entry.needsCache)
    .sort((left, right) => left.packagePath.localeCompare(right.packagePath));

  console.log(`Refreshing license cache for ${missing.length} package(s).`);
  const failures: string[] = [];
  const entries = await mapConcurrent(missing, 8, async (entry, index) => {
    let result: CacheEntry;
    try {
      result = await extractPackageLicense(entry.packagePath, entry.lockPackage);
    } catch (error) {
      const name = packageNameFromLockPath(entry.packagePath);
      const version = String(entry.lockPackage.version || '');
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}@${version}: ${message}`);
      result = {
        packagePath: entry.packagePath,
        name,
        version,
        sourceUrl: entry.lockPackage.resolved || null,
        licenseFileName: null,
        licenseText: null,
        noticeTexts: [],
        copyrightNotices: [],
      };
    }
    console.log(`[${index + 1}/${missing.length}] ${result.name}@${result.version}: ${result.licenseFileName || 'no license file'}`);
    return result;
  });
  const cache = {
    schemaVersion: 1,
    lockfileSha256: sha256(lockfileRaw),
    entries: Object.fromEntries(entries.map((entry) => [`${entry.packagePath}@${entry.version}`, entry])),
  };
  await fs.mkdir(path.dirname(thirdPartyCompliancePaths.licenseCache), { recursive: true });
  await fs.writeFile(
    thirdPartyCompliancePaths.licenseCache,
    JSON.stringify(cache, null, 2) + '\n',
    'utf8',
  );
  console.log(`Wrote ${thirdPartyCompliancePaths.licenseCache}.`);
  if (failures.length) {
    throw new Error(
      `License cache refresh completed with ${failures.length} download/extraction failure(s):\n`
      + failures.map((failure) => `- ${failure}`).join('\n'),
    );
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
