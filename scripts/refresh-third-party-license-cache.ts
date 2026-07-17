import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

import { thirdPartyCompliancePaths } from './third-party-license-inventory';
import {
  decodeBasicHtmlEntities,
  extractCopyrightNotices,
} from './third-party-license-text';

type LockPackage = {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  license?: string;
};

type CacheEntry = {
  packagePath: string;
  name: string;
  version: string;
  packageResolved: string | null;
  packageIntegrity: string | null;
  lookupCompleted: boolean;
  sourceUrl: string | null;
  sourceRevision: string | null;
  verificationSource: string | null;
  verificationNote: string | null;
  licenseFileName: string | null;
  licenseText: string | null;
  noticeTexts: string[];
  copyrightNotices: string[];
};

type LicensePolicy = {
  packageOverrides?: Record<string, {
    licenseTextPath?: string | null;
  }>;
  sourceRevisionOverrides?: Record<string, SourceRevisionOverride>;
};

type SourceRevisionOverride = {
  repositoryUrl: string;
  revision: string;
  licensePath?: string;
  reason: string;
};

const LICENSE_PATTERN = /^(?:licen[cs]e|copying|copyright)(?:[._-].*)?$/iu;
const NOTICE_PATTERN = /^notice(?:[._-].*)?$/iu;
const README_PATTERN = /^readme(?:[._-].*)?$/iu;
const UPSTREAM_LICENSE_CANDIDATES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
  'license',
  'license.md',
  'license.txt',
  'licence',
  'licence.md',
  'licence.txt',
] as const;

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

function githubRepository(value: unknown): {
  baseUrl: string;
  owner: string;
  repository: string;
} | null {
  const normalized = repositoryUrl(value)
    ?.replace(/^git@github\.com:/u, 'https://github.com/')
    .replace(/#.*$/u, '')
    .replace(/\.git$/u, '')
    .replace(/\/tree\/.*$/u, '')
    .replace(/\/$/u, '');
  const match = normalized?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/u);
  if (!match) return null;
  return {
    baseUrl: match[0],
    owner: match[1],
    repository: match[2],
  };
}

function encodePath(value: string): string {
  return value.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function fetchRegistryMetadata(name: string, version: string): Promise<{
  gitHead?: string;
  repository?: unknown;
  homepage?: string;
} | null> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  if (!response.ok) return null;
  return response.json() as Promise<{
    gitHead?: string;
    repository?: unknown;
    homepage?: string;
  }>;
}

async function fetchExactUpstreamLicense(
  name: string,
  version: string,
  declaredLicense: string,
  packageJson: {
    gitHead?: string;
    repository?: unknown;
    homepage?: string;
  } | null,
  registryMetadata: {
    gitHead?: string;
    repository?: unknown;
    homepage?: string;
  } | null,
  sourceRevisionOverride?: SourceRevisionOverride,
): Promise<{
  sourceUrl: string;
  sourceRevision: string;
  verificationSource: string;
  licenseFileName: string;
  licenseText: string;
  verificationNote: string | null;
} | null> {
  const repositoryValue = sourceRevisionOverride?.repositoryUrl
    || registryMetadata?.repository
    || packageJson?.repository;
  const github = githubRepository(repositoryValue);
  const publishedGitHead = sourceRevisionOverride?.revision
    || registryMetadata?.gitHead
    || packageJson?.gitHead;
  if (!github) return null;

  const repositoryDirectory = (
    repositoryValue
    && typeof repositoryValue === 'object'
    && 'directory' in repositoryValue
    && typeof (repositoryValue as { directory?: unknown }).directory === 'string'
  )
    ? String((repositoryValue as { directory: string }).directory)
    : '';
  const candidatePaths = [
    ...(sourceRevisionOverride?.licensePath ? [sourceRevisionOverride.licensePath] : []),
    ...UPSTREAM_LICENSE_CANDIDATES.map((candidate) => (
      repositoryDirectory ? `${repositoryDirectory}/${candidate}` : candidate
    )),
    ...UPSTREAM_LICENSE_CANDIDATES,
  ];

  const unscopedName = name.includes('/') ? name.split('/').at(-1) || name : name;
  const revisionCandidates = publishedGitHead
    ? [publishedGitHead]
    : [
      `v${version}`,
      `${name}@${version}`,
      `${unscopedName}@${version}`,
      version,
    ];

  for (const revisionCandidate of [...new Set(revisionCandidates)]) {
    for (const candidatePath of [...new Set(candidatePaths)]) {
      const candidateRawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repository)}/${encodeURIComponent(revisionCandidate)}/${encodePath(candidatePath)}`;
      const candidateResponse = await fetch(candidateRawUrl);
      if (!candidateResponse.ok) continue;
      const candidateLicenseText = normalizeText(await candidateResponse.text());
      if (!candidateLicenseText.trim()) continue;
      if (
        declaredLicense.includes('LGPL')
        && !/GNU LESSER GENERAL PUBLIC LICENSE/iu.test(candidateLicenseText)
      ) {
        // Some binary-only packages point at a repository whose root LICENSE
        // covers the build scripts, not the bundled library declared by npm.
        // Never substitute that unrelated text for the package declaration.
        continue;
      }

      let sourceRevision = revisionCandidate;
      if (!publishedGitHead) {
        const commitResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repository)}/commits/${encodeURIComponent(revisionCandidate)}`,
          { headers: { Accept: 'application/vnd.github+json' } },
        );
        if (!commitResponse.ok) continue;
        const commit = await commitResponse.json() as { sha?: string };
        if (!commit.sha) continue;
        sourceRevision = commit.sha;
      }

      const verificationSource = `https://raw.githubusercontent.com/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repository)}/${encodeURIComponent(sourceRevision)}/${encodePath(candidatePath)}`;
      const exactResponse = sourceRevision === revisionCandidate
        ? candidateResponse
        : await fetch(verificationSource);
      if (!exactResponse.ok) continue;
      const licenseText = sourceRevision === revisionCandidate
        ? candidateLicenseText
        : normalizeText(await exactResponse.text());
      if (!licenseText.trim()) continue;
      return {
        sourceUrl: `${github.baseUrl}/tree/${sourceRevision}`,
        sourceRevision,
        verificationSource,
        licenseFileName: `UPSTREAM:${candidatePath}`,
        licenseText,
        verificationNote: sourceRevisionOverride?.reason || null,
      };
    }
  }
  return null;
}

function extractLicenseFromReadme(value: string): string | null {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  const headingIndex = lines.findIndex((line, index) => (
    /^#{1,6}\s*licen[cs]e\s*#*\s*$/iu.test(line.trim())
    || (
      /^licen[cs]e\s*$/iu.test(line.trim())
      && /^[-=]{3,}\s*$/u.test(lines[index + 1] || '')
    )
  ));
  if (headingIndex < 0) return null;
  const setextHeading = !lines[headingIndex].trim().startsWith('#');
  const headingLevel = setextHeading
    ? 2
    : lines[headingIndex].match(/^#+/u)?.[0].length || 6;
  const sectionStart = headingIndex + (setextHeading ? 2 : 1);
  let endIndex = lines.length;
  for (let index = sectionStart; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#+)\s+/u);
    const isSetextHeading = index + 1 < lines.length && /^[-=]{3,}\s*$/u.test(lines[index + 1]);
    if ((heading && heading[1].length <= headingLevel) || isSetextHeading) {
      endIndex = index;
      break;
    }
  }
  const section = normalizeText(decodeBasicHtmlEntities(
    lines.slice(sectionStart, endIndex).join('\n'),
  ));
  const containsFullLicense = (
    section.includes('Permission is hereby granted')
    && /THE SOFTWARE IS PROVIDED/iu.test(section)
  ) || (
    /Apache License\s*,?\s*Version 2\.0/iu.test(section)
    && /TERMS AND CONDITIONS/iu.test(section)
  ) || (
    /Redistribution and use in source and binary forms/iu.test(section)
    && /THIS SOFTWARE IS PROVIDED/iu.test(section)
  );
  return containsFullLicense ? section : null;
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
  sourceRevisionOverride?: SourceRevisionOverride,
): Promise<CacheEntry> {
  const version = String(lockPackage.version || '');
  const name = packageNameFromLockPath(packagePath);
  if (!lockPackage.resolved?.startsWith('http')) {
    return {
      packagePath,
      name,
      version,
      packageResolved: lockPackage.resolved || null,
      packageIntegrity: lockPackage.integrity || null,
      lookupCompleted: true,
      sourceUrl: null,
      sourceRevision: null,
      verificationSource: null,
      verificationNote: sourceRevisionOverride?.reason || null,
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
        // Most npm tarballs use package/ as their archive root, while
        // DefinitelyTyped packages use the unscoped package name (for example
        // trusted-types/). Strip any single archive root instead of assuming
        // package/, otherwise exact LICENSE files in valid npm tarballs are
        // silently missed.
        const normalized = entryPath.replace(/^(?:\.\/)?[^/]+\//u, '');
        if (normalized === 'package.json') return true;
        if (normalized.includes('/')) return false;
        return LICENSE_PATTERN.test(normalized)
          || NOTICE_PATTERN.test(normalized)
          || README_PATTERN.test(normalized);
      },
    });
    const entries = await fs.readdir(extractRoot);
    const licenseFileName = entries.filter((entry) => LICENSE_PATTERN.test(entry)).sort()[0] || null;
    const noticeFileNames = entries.filter((entry) => NOTICE_PATTERN.test(entry)).sort();
    const readmeFileName = entries.filter((entry) => README_PATTERN.test(entry)).sort()[0] || null;
    const directLicenseText = licenseFileName
      ? normalizeText(await fs.readFile(path.join(extractRoot, licenseFileName), 'utf8'))
      : null;
    const readmeText = readmeFileName
      ? normalizeText(await fs.readFile(path.join(extractRoot, readmeFileName), 'utf8'))
      : null;
    const readmeLicenseText = !directLicenseText && readmeText
      ? extractLicenseFromReadme(readmeText)
      : null;
    const licenseText = directLicenseText || readmeLicenseText;
    const packagedNoticeTexts = await Promise.all(
      noticeFileNames.map(async (entry) => normalizeText(await fs.readFile(path.join(extractRoot, entry), 'utf8'))),
    );
    const noticeTexts = [
      ...packagedNoticeTexts,
      ...(readmeText && /\bcopyright\b|\(c\)|©/iu.test(readmeText) ? [readmeText] : []),
    ];
    const packageJson = await readOptionalJson<{
      gitHead?: string;
      repository?: unknown;
      homepage?: string;
    }>(path.join(extractRoot, 'package.json'));
    const registryMetadata = sourceRevisionOverride
      ? null
      : await fetchRegistryMetadata(name, version);
    const upstreamLicense = licenseText
      ? null
      : await fetchExactUpstreamLicense(
        name,
        version,
        String(lockPackage.license || ''),
        packageJson,
        registryMetadata,
        sourceRevisionOverride,
      );
    const resolvedLicenseText = licenseText || upstreamLicense?.licenseText || null;
    const incompleteCompositeLicense = (
      Boolean(directLicenseText)
      && String(lockPackage.license || '').includes('LGPL')
      && !/GNU LESSER GENERAL PUBLIC LICENSE/iu.test(directLicenseText || '')
    );
    const exactPackageEvidenceNote = incompleteCompositeLicense
      ? `The exact npm tarball LICENSE covers only part of the declared ${lockPackage.license} expression; the LGPL and bundled-library terms remain unresolved.`
      : !licenseText && String(lockPackage.license || '').includes('LGPL')
        ? `The exact npm tarball contains no complete ${lockPackage.license} license text. The repository-root Apache-2.0 license covers the sharp-libvips build scripts and was rejected as evidence for the bundled libraries.`
      : readmeLicenseText
        ? 'The complete license text is embedded in the exact npm tarball README license section.'
        : null;
    const registryRepository = githubRepository(registryMetadata?.repository);
    const publishedRevision = sourceRevisionOverride?.revision
      || registryMetadata?.gitHead
      || packageJson?.gitHead
      || null;
    const publishedSourceUrl = registryRepository && publishedRevision
      ? `${registryRepository.baseUrl}/tree/${publishedRevision}`
      : null;
    return {
      packagePath,
      name,
      version,
      packageResolved: lockPackage.resolved || null,
      packageIntegrity: lockPackage.integrity || null,
      lookupCompleted: true,
      sourceUrl: upstreamLicense?.sourceUrl
        || publishedSourceUrl
        || repositoryUrl(packageJson?.repository)
        || repositoryUrl(registryMetadata?.repository)
        || packageJson?.homepage
        || registryMetadata?.homepage
        || lockPackage.resolved,
      sourceRevision: upstreamLicense?.sourceRevision || publishedRevision,
      verificationSource: upstreamLicense?.verificationSource
        || (licenseText ? `${lockPackage.resolved}#${licenseFileName || `${readmeFileName}#License`}` : null),
      verificationNote: upstreamLicense?.verificationNote
        || exactPackageEvidenceNote,
      licenseFileName: upstreamLicense?.licenseFileName
        || licenseFileName
        || (readmeLicenseText ? `${readmeFileName}#License` : null),
      licenseText: resolvedLicenseText,
      noticeTexts,
      copyrightNotices: extractCopyrightNotices(
        ...(resolvedLicenseText ? [resolvedLicenseText] : []),
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
  const lockfileSha256 = sha256(lockfileRaw);
  const lockfile = JSON.parse(lockfileRaw.toString('utf8')) as {
    packages: Record<string, LockPackage>;
  };
  const policy = JSON.parse(await fs.readFile(thirdPartyCompliancePaths.policy, 'utf8')) as LicensePolicy;
  const previousCache = await readOptionalJson<{
    schemaVersion?: number;
    lockfileSha256?: string;
    entries?: Record<string, CacheEntry>;
  }>(thirdPartyCompliancePaths.licenseCache);
  // Cache entries are bound to an exact package path, version, registry URL
  // and integrity hash. A root package-version bump changes the full lockfile
  // hash without changing those immutable package artifacts, so keep their
  // already verified evidence instead of making releases depend on a fresh
  // GitHub lookup. Changed artifacts and changed source overrides still force
  // a refresh below.
  const previousEntries = previousCache?.entries || {};
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
        const cacheKey = `${packagePath}@${version}`;
        const sourceRevisionOverride = policy.sourceRevisionOverrides?.[`${name}@${version}`];
        const existing = previousEntries[cacheKey];
        const cacheRelevant = !overrideHasLicense && (
          Boolean(lockPackage.optional)
          || !await hasLocalLicenseFile(packagePath)
        );
        const previousSchema = previousCache?.schemaVersion || 0;
        const existingLookupCompleted = Boolean(existing) && (
          previousSchema < 6 || existing.lookupCompleted === true
        );
        const artifactChanged = Boolean(
          existing
          && previousSchema >= 6
          && (
            existing.packageResolved !== (lockPackage.resolved || null)
            || existing.packageIntegrity !== (lockPackage.integrity || null)
          ),
        );
        const needsRefresh = !existingLookupCompleted
          || artifactChanged
          || Boolean(
            previousSchema < 5
            && name.startsWith('@img/sharp'),
          )
          || Boolean(sourceRevisionOverride && existing.sourceRevision !== sourceRevisionOverride.revision);
        return {
          packagePath,
          lockPackage,
          cacheKey,
          cacheRelevant,
          sourceRevisionOverride,
          needsCache: cacheRelevant && needsRefresh,
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
      result = await extractPackageLicense(
        entry.packagePath,
        entry.lockPackage,
        entry.sourceRevisionOverride,
      );
    } catch (error) {
      const name = packageNameFromLockPath(entry.packagePath);
      const version = String(entry.lockPackage.version || '');
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}@${version}: ${message}`);
      result = {
        packagePath: entry.packagePath,
        name,
        version,
        packageResolved: entry.lockPackage.resolved || null,
        packageIntegrity: entry.lockPackage.integrity || null,
        lookupCompleted: true,
        sourceUrl: entry.lockPackage.resolved || null,
        sourceRevision: null,
        verificationSource: null,
        verificationNote: entry.sourceRevisionOverride?.reason || null,
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
    schemaVersion: 6,
    lockfileSha256,
    entries: {
      ...Object.fromEntries(
        candidates
          .filter((entry) => entry.cacheRelevant && previousEntries[entry.cacheKey])
          .map((entry) => {
            const previous = previousEntries[entry.cacheKey];
            const migratedLicenseText = (
              previous.licenseText
              && previous.licenseFileName?.startsWith('README')
            )
              ? normalizeText(decodeBasicHtmlEntities(previous.licenseText))
              : previous.licenseText;
            return [
              entry.cacheKey,
              {
                ...previous,
                packageResolved: entry.lockPackage.resolved || null,
                packageIntegrity: entry.lockPackage.integrity || null,
                lookupCompleted: true,
                licenseText: migratedLicenseText,
                copyrightNotices: extractCopyrightNotices(
                  migratedLicenseText || '',
                  ...(previous.noticeTexts || []),
                ),
              },
            ];
          }),
      ),
      ...Object.fromEntries(entries.map((entry) => [`${entry.packagePath}@${entry.version}`, entry])),
    },
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
