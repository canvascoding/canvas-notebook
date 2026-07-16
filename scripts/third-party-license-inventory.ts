import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { extractCopyrightNotices } from './third-party-license-text';

export type ThirdPartyUsage = 'runtime' | 'build-bundled' | 'asset' | 'native' | 'development-only';
export type ThirdPartyPolicyDecision = 'allowed' | 'review_required' | 'blocked';

export type ThirdPartyComponent = {
  name: string;
  versionOrCommit: string;
  sourceUrl: string;
  packagePathOrArtifact: string;
  usage: ThirdPartyUsage;
  distributedIn: string[];
  declaredLicense: string;
  verifiedLicense: string;
  licenseTextRef: string | null;
  licenseTextSha256: string | null;
  copyrightNotices: string[];
  modified: boolean;
  modificationNotice?: string;
  policyDecision: ThirdPartyPolicyDecision;
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: string;
};

type PackageOverride = {
  verifiedLicense?: string;
  licenseTextPath?: string | null;
  copyrightNotices?: string[];
  sourceUrl?: string;
  verificationSource?: string;
  reason?: string;
  policyDecision?: ThirdPartyPolicyDecision;
  reviewedBy?: string;
  reviewedAt?: string;
};

type AdditionalComponent = Omit<ThirdPartyComponent, 'licenseTextRef' | 'licenseTextSha256'> & {
  licenseTextPath: string | null;
};

type LicensePolicy = {
  schemaVersion: number;
  releaseApproval: {
    status: 'pending' | 'approved';
    reviewedBy: string | null;
    reviewedAt: string | null;
    notes: string;
  };
  licenseDecisions: Record<string, ThirdPartyPolicyDecision>;
  blockedLicensePatterns: string[];
  packageUsageOverrides: Array<{
    namePrefix: string;
    usage: ThirdPartyUsage;
    distributedIn: string[];
    reason: string;
  }>;
  packageOverrides: Record<string, PackageOverride>;
  additionalComponents: AdditionalComponent[];
};

type LicenseCacheEntry = {
  packagePath: string;
  name: string;
  version: string;
  sourceUrl: string | null;
  sourceRevision?: string | null;
  verificationSource?: string | null;
  verificationNote?: string | null;
  licenseFileName: string | null;
  licenseText: string | null;
  noticeTexts: string[];
  copyrightNotices: string[];
};

type LicenseCache = {
  schemaVersion: number;
  lockfileSha256: string;
  entries: Record<string, LicenseCacheEntry>;
};

type LockPackage = {
  version?: string;
  resolved?: string;
  license?: string;
  dev?: boolean;
  optional?: boolean;
};

type InstalledPackageJson = {
  name?: string;
  version?: string;
  license?: string;
  repository?: string | { url?: string };
  homepage?: string;
  author?: string | { name?: string; email?: string; url?: string };
};

type InternalComponent = {
  component: ThirdPartyComponent;
  licenseText: string | null;
};

export type ThirdPartyInventory = {
  schemaVersion: number;
  generator: string;
  packageVersion: string;
  lockfileSha256: string;
  summary: {
    totalComponents: number;
    npmComponents: number;
    nonNpmComponents: number;
    runtimeComponents: number;
    developmentOnlyComponents: number;
    allowed: number;
    reviewRequired: number;
    blocked: number;
  };
  releaseGate: {
    status: 'approved' | 'blocked';
    approvalStatus: 'pending' | 'approved';
    approvalReviewedBy: string | null;
    approvalReviewedAt: string | null;
    blockers: Array<{
      name: string;
      versionOrCommit: string;
      reason: string;
    }>;
  };
  components: ThirdPartyComponent[];
};

export type GeneratedComplianceArtifacts = {
  inventory: ThirdPartyInventory;
  inventoryJson: string;
  noticesMarkdown: string;
};

const ROOT = path.resolve(__dirname, '..');
const POLICY_PATH = path.join(ROOT, 'docs/compliance/third-party-license-policy.json');
const LOCKFILE_PATH = path.join(ROOT, 'package-lock.json');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const LICENSE_CACHE_PATH = path.join(ROOT, 'docs/compliance/third-party-license-cache.json');
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|copyright)(?:[._-].*)?$/iu;
const NOTICE_FILE_PATTERN = /^notice(?:[._-].*)?$/iu;

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readOptionalJson<T>(filePath: string): T | null {
  try {
    return readJson<T>(filePath);
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd() + '\n';
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function relativeToRoot(filePath: string): string {
  return path.relative(ROOT, filePath).replaceAll(path.sep, '/');
}

function readOptionalText(filePath: string): string | null {
  try {
    return normalizeText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function repositoryUrl(repository: InstalledPackageJson['repository']): string | null {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  return raw
    .replace(/^git\+/u, '')
    .replace(/^git:\/\//u, 'https://')
    .replace(/\.git$/u, '');
}

function authorLabel(author: InstalledPackageJson['author']): string | null {
  if (!author) return null;
  if (typeof author === 'string') return author.trim() || null;
  const pieces = [author.name, author.email ? `<${author.email}>` : null].filter(Boolean);
  return pieces.join(' ').trim() || null;
}

function findPackageNoticeFiles(packageDirectory: string): {
  licensePath: string | null;
  noticePaths: string[];
} {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(packageDirectory);
  } catch {
    return { licensePath: null, noticePaths: [] };
  }

  const licenseName = entries
    .filter((entry) => LICENSE_FILE_PATTERN.test(entry))
    .sort((left, right) => left.localeCompare(right))[0];
  const noticePaths = entries
    .filter((entry) => NOTICE_FILE_PATTERN.test(entry))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(packageDirectory, entry));
  return {
    licensePath: licenseName ? path.join(packageDirectory, licenseName) : null,
    noticePaths,
  };
}

function declaredPackageUsage(
  policy: LicensePolicy,
  packagePath: string,
  lockPackage: LockPackage,
  lockPackages: Record<string, LockPackage>,
): {
  usage: ThirdPartyUsage;
  distributedIn: string[];
  reason?: string;
} {
  const name = packageNameFromLockPath(packagePath);
  const directOverride = policy.packageUsageOverrides.find((entry) => name.startsWith(entry.namePrefix));
  if (directOverride) {
    return {
      usage: directOverride.usage,
      distributedIn: directOverride.distributedIn,
      reason: directOverride.reason,
    };
  }

  let parentPath = packagePath;
  while (parentPath.includes('/node_modules/')) {
    parentPath = parentPath.slice(0, parentPath.lastIndexOf('/node_modules/'));
    const parentName = packageNameFromLockPath(parentPath);
    const parentOverride = policy.packageUsageOverrides.find((entry) => (
      parentName.startsWith(entry.namePrefix)
    ));
    if (parentOverride) {
      return {
        usage: parentOverride.usage,
        distributedIn: parentOverride.distributedIn,
        reason: `Inherited from ${parentName}: ${parentOverride.reason}`,
      };
    }
    if (lockPackages[parentPath]?.dev) {
      return {
        usage: 'development-only',
        distributedIn: ['source-development-install'],
        reason: `Inherited development-only classification from ${parentName}.`,
      };
    }
  }

  if (lockPackage.dev) {
    return {
      usage: 'development-only',
      distributedIn: ['source-development-install'],
    };
  }
  return {
    usage: 'runtime',
    distributedIn: ['source-release', 'next-server', 'docker-image', 'electron-web-app'],
  };
}

function policyDecision(
  policy: LicensePolicy,
  verifiedLicense: string,
  override?: PackageOverride,
): ThirdPartyPolicyDecision {
  if (override?.policyDecision) return override.policyDecision;
  const policyLicense = verifiedLicense.startsWith('(') && verifiedLicense.endsWith(')')
    ? verifiedLicense.slice(1, -1).trim()
    : verifiedLicense;
  if (policy.blockedLicensePatterns.some((pattern) => policyLicense.includes(pattern))) {
    return 'blocked';
  }
  return policy.licenseDecisions[policyLicense] ?? 'review_required';
}

function overrideForPackage(
  policy: LicensePolicy,
  name: string,
  version: string,
): PackageOverride | undefined {
  return policy.packageOverrides[`${name}@${version}`] ?? policy.packageOverrides[name];
}

function packageNameFromLockPath(packagePath: string): string {
  const withoutRoot = packagePath.replace(/^node_modules\//u, '');
  const nestedPath = withoutRoot.split('/node_modules/').at(-1) || withoutRoot;
  const segments = nestedPath.split('/');
  return nestedPath.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function createNpmComponent(
  policy: LicensePolicy,
  licenseCache: LicenseCache | null,
  lockPackages: Record<string, LockPackage>,
  packagePath: string,
  lockPackage: LockPackage,
): InternalComponent | null {
  if (!lockPackage.version) return null;
  const packageDirectory = path.join(ROOT, packagePath);
  const installedPackage = readOptionalJson<InstalledPackageJson>(path.join(packageDirectory, 'package.json')) || {};
  const name = installedPackage.name || packageNameFromLockPath(packagePath);
  const version = installedPackage.version || lockPackage.version;
  const override = overrideForPackage(policy, name, version);
  const declaredLicense = String(lockPackage.license || installedPackage.license || 'UNKNOWN');
  const verifiedLicense = override?.verifiedLicense || declaredLicense;
  const noticeFiles = findPackageNoticeFiles(packageDirectory);
  const cacheKey = `${packagePath}@${version}`;
  const cached = licenseCache?.entries[cacheKey];
  const configuredLicensePath = override?.licenseTextPath
    ? path.resolve(ROOT, override.licenseTextPath)
    : null;
  // A cache entry comes from the exact lockfile tarball and is therefore the
  // canonical evidence across host platforms. Optional native packages differ
  // between macOS/Linux and arm64/amd64; preferring an installed LICENSE file
  // would make the generated manifest depend on the machine running the build.
  const resolvedLicensePath = configuredLicensePath
    || (cached ? null : noticeFiles.licensePath);
  const licenseText = resolvedLicensePath
    ? readOptionalText(resolvedLicensePath)
    : cached
      ? cached.licenseText
        ? normalizeText(cached.licenseText)
        : null
      : null;
  const additionalNoticeTexts = cached
    ? (cached.noticeTexts || []).map(normalizeText)
    : noticeFiles.noticePaths.map(readOptionalText);
  const copyrightNotices = override?.copyrightNotices?.length
    ? [...override.copyrightNotices].sort((left, right) => left.localeCompare(right))
    : extractCopyrightNotices(licenseText, ...additionalNoticeTexts);

  const usage = declaredPackageUsage(policy, packagePath, lockPackage, lockPackages);

  let decision = policyDecision(policy, verifiedLicense, override);
  const reviewReasons: string[] = [];
  if (override?.reason) reviewReasons.push(override.reason);
  if (override?.verificationSource) {
    reviewReasons.push(`Verification source: ${override.verificationSource}`);
  }
  if (usage.reason) reviewReasons.push(usage.reason);
  if (cached?.verificationSource) {
    reviewReasons.push(`License text source: ${cached.verificationSource}`);
  }
  if (cached?.sourceRevision) {
    reviewReasons.push(`Published source revision: ${cached.sourceRevision}`);
  }
  if (cached?.verificationNote) {
    reviewReasons.push(cached.verificationNote);
  }
  if (!licenseText) {
    reviewReasons.push('No verified license text was found in the installed package or a versioned override.');
    if (usage.usage !== 'development-only') decision = 'review_required';
  }
  if (verifiedLicense.includes('MIT') && copyrightNotices.length === 0) {
    reviewReasons.push('The MIT copyright notice could not be attributed automatically.');
    if (usage.usage !== 'development-only') decision = 'review_required';
  }

  const sourceUrl = override?.sourceUrl
    || cached?.sourceUrl
    || repositoryUrl(installedPackage.repository)
    || installedPackage.homepage
    || lockPackage.resolved
    || `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(version)}`;
  const author = authorLabel(installedPackage.author);
  if (!copyrightNotices.length && author) {
    reviewReasons.push(`Package author metadata: ${author}`);
  }

  return {
    component: {
      name,
      versionOrCommit: version,
      sourceUrl,
      packagePathOrArtifact: packagePath,
      usage: usage.usage,
      distributedIn: usage.distributedIn,
      declaredLicense,
      verifiedLicense,
      licenseTextRef: resolvedLicensePath
        ? relativeToRoot(resolvedLicensePath)
        : cached?.licenseText
          ? `docs/compliance/third-party-license-cache.json#${cacheKey}`
          : null,
      licenseTextSha256: licenseText ? sha256(licenseText) : null,
      copyrightNotices,
      modified: false,
      policyDecision: decision,
      ...(reviewReasons.length ? { reviewNotes: reviewReasons.join(' ') } : {}),
      ...(override?.reviewedBy ? { reviewedBy: override.reviewedBy } : {}),
      ...(override?.reviewedAt ? { reviewedAt: override.reviewedAt } : {}),
    },
    licenseText,
  };
}

function createAdditionalComponent(component: AdditionalComponent): InternalComponent {
  const licensePath = component.licenseTextPath
    ? path.resolve(ROOT, component.licenseTextPath)
    : null;
  const licenseText = licensePath ? readOptionalText(licensePath) : null;
  return {
    component: {
      name: component.name,
      versionOrCommit: component.versionOrCommit,
      sourceUrl: component.sourceUrl,
      packagePathOrArtifact: component.packagePathOrArtifact,
      usage: component.usage,
      distributedIn: component.distributedIn,
      declaredLicense: component.declaredLicense,
      verifiedLicense: component.verifiedLicense,
      licenseTextRef: licensePath ? relativeToRoot(licensePath) : null,
      licenseTextSha256: licenseText ? sha256(licenseText) : null,
      copyrightNotices: component.copyrightNotices,
      modified: component.modified,
      ...(component.modificationNotice ? { modificationNotice: component.modificationNotice } : {}),
      policyDecision: component.policyDecision,
      ...(component.reviewNotes ? { reviewNotes: component.reviewNotes } : {}),
      ...(component.reviewedBy ? { reviewedBy: component.reviewedBy } : {}),
      ...(component.reviewedAt ? { reviewedAt: component.reviewedAt } : {}),
    },
    licenseText,
  };
}

function createSeedSkillComponents(): InternalComponent[] {
  const seedRoot = path.join(ROOT, 'seed_skills');
  if (!fs.existsSync(seedRoot)) return [];
  return fs.readdirSync(seedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const skillDirectory = path.join(seedRoot, entry.name);
      const noticeFiles = findPackageNoticeFiles(skillDirectory);
      if (!noticeFiles.licensePath) return [];
      const licenseText = readOptionalText(noticeFiles.licensePath);
      if (!licenseText) return [];
      const verifiedLicense = licenseText.includes('Apache License')
        ? 'Apache-2.0'
        : licenseText.includes('MIT License')
          ? 'MIT'
          : 'UNKNOWN';
      const copyrights = extractCopyrightNotices(licenseText);
      return [{
        component: {
          name: `seed-skill:${entry.name}`,
          versionOrCommit: 'repository-version',
          sourceUrl: 'repository-bundled',
          packagePathOrArtifact: relativeToRoot(skillDirectory),
          usage: 'asset' as const,
          distributedIn: ['source-release', 'docker-image'],
          declaredLicense: verifiedLicense,
          verifiedLicense,
          licenseTextRef: relativeToRoot(noticeFiles.licensePath),
          licenseTextSha256: sha256(licenseText),
          copyrightNotices: copyrights,
          modified: false,
          policyDecision: verifiedLicense === 'UNKNOWN' ? 'review_required' as const : 'allowed' as const,
          ...(!copyrights.length && verifiedLicense === 'MIT'
            ? { reviewNotes: 'MIT seed skill has no attributable copyright notice.' }
            : {}),
        },
        licenseText,
      }];
    });
}

function componentSortKey(component: ThirdPartyComponent): string {
  return [
    component.usage,
    component.name.toLowerCase(),
    component.versionOrCommit,
    component.packagePathOrArtifact,
  ].join('\u0000');
}

function buildNotices(
  inventory: ThirdPartyInventory,
  internals: InternalComponent[],
): string {
  const distributed = internals.filter(({ component }) => component.usage !== 'development-only');
  const licenseGroups = new Map<string, {
    text: string;
    components: ThirdPartyComponent[];
  }>();
  for (const internal of distributed) {
    if (!internal.licenseText || !internal.component.licenseTextSha256) continue;
    const existing = licenseGroups.get(internal.component.licenseTextSha256);
    if (existing) {
      existing.components.push(internal.component);
    } else {
      licenseGroups.set(internal.component.licenseTextSha256, {
        text: internal.licenseText,
        components: [internal.component],
      });
    }
  }

  const lines = [
    '# Canvas Notebook Third-Party Notices',
    '',
    'This file is generated from `package-lock.json`, installed package license files,',
    'versioned overrides, and the bundled non-npm component inventory.',
    '',
    `- Canvas Notebook version: ${inventory.packageVersion}`,
    `- Lockfile SHA-256: \`${inventory.lockfileSha256}\``,
    `- Distributed components: ${distributed.length}`,
    `- Release gate: **${inventory.releaseGate.status}**`,
    '',
    'Canvas Notebook itself is licensed separately under the root `LICENSE` file.',
    'Third-party trademarks and branding are not granted by the software licenses below.',
    '',
    '## Distributed component index',
    '',
    '| Component | Version/commit | Usage | License | Decision |',
    '|---|---|---|---|---|',
    ...distributed.map(({ component }) => (
      `| ${component.name.replaceAll('|', '\\|')} | ${component.versionOrCommit.replaceAll('|', '\\|')} | ${component.usage} | ${component.verifiedLicense.replaceAll('|', '\\|')} | ${component.policyDecision} |`
    )),
    '',
  ];

  if (inventory.releaseGate.blockers.length) {
    lines.push(
      '## Commercial release blockers',
      '',
      'The following entries require a documented responsible/legal decision before a commercial release:',
      '',
      ...inventory.releaseGate.blockers.map((blocker) => (
        `- **${blocker.name} ${blocker.versionOrCommit}:** ${blocker.reason}`
      )),
      '',
    );
  }

  lines.push('## License texts and copyright notices', '');
  for (const [hash, group] of [...licenseGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedComponents = [...group.components].sort((left, right) => componentSortKey(left).localeCompare(componentSortKey(right)));
    const notices = [...new Set(sortedComponents.flatMap((component) => component.copyrightNotices))]
      .sort((left, right) => left.localeCompare(right));
    lines.push(
      `### License text ${hash.slice(0, 12)}`,
      '',
      `Applies to ${sortedComponents.map((component) => `${component.name}@${component.versionOrCommit}`).join(', ')}.`,
      '',
    );
    if (notices.length) {
      lines.push('Copyright notices:', '', ...notices.map((notice) => `- ${notice}`), '');
    }
    lines.push('```text', group.text.trimEnd(), '```', '');
  }

  return normalizeText(lines.join('\n'));
}

export function generateThirdPartyComplianceArtifacts(): GeneratedComplianceArtifacts {
  const policy = readJson<LicensePolicy>(POLICY_PATH);
  const lockfileRaw = fs.readFileSync(LOCKFILE_PATH);
  const lockfile = JSON.parse(lockfileRaw.toString('utf8')) as {
    packages?: Record<string, LockPackage>;
  };
  const packageJson = readJson<{ version: string }>(PACKAGE_PATH);
  const licenseCache = readOptionalJson<LicenseCache>(LICENSE_CACHE_PATH);
  if (licenseCache && licenseCache.lockfileSha256 !== sha256(lockfileRaw)) {
    throw new Error(
      'docs/compliance/third-party-license-cache.json is stale for the current package-lock.json. '
      + 'Run npm run licenses:refresh-cache.',
    );
  }
  const npmComponents = Object.entries(lockfile.packages || {})
    .filter(([packagePath, value]) => packagePath.startsWith('node_modules/') && Boolean(value.version))
    .map(([packagePath, value]) => createNpmComponent(
      policy,
      licenseCache,
      lockfile.packages || {},
      packagePath,
      value,
    ))
    .filter((value): value is InternalComponent => Boolean(value));
  const additionalComponents = policy.additionalComponents.map(createAdditionalComponent);
  const internals = [...npmComponents, ...additionalComponents, ...createSeedSkillComponents()]
    .sort((left, right) => componentSortKey(left.component).localeCompare(componentSortKey(right.component)));
  const components = internals.map((entry) => entry.component);
  const releaseBlockers = components
    .filter((component) => component.usage !== 'development-only' && component.policyDecision !== 'allowed')
    .map((component) => ({
      name: component.name,
      versionOrCommit: component.versionOrCommit,
      reason: component.reviewNotes
        || `Policy decision is ${component.policyDecision} for ${component.verifiedLicense}.`,
    }));
  if (policy.releaseApproval.status !== 'approved') {
    releaseBlockers.unshift({
      name: 'first-commercial-release-approval',
      versionOrCommit: packageJson.version,
      reason: policy.releaseApproval.notes,
    });
  }
  const inventory: ThirdPartyInventory = {
    schemaVersion: 1,
    generator: 'scripts/generate-third-party-notices.ts',
    packageVersion: packageJson.version,
    lockfileSha256: sha256(lockfileRaw),
    summary: {
      totalComponents: components.length,
      npmComponents: npmComponents.length,
      nonNpmComponents: components.length - npmComponents.length,
      runtimeComponents: components.filter((component) => component.usage !== 'development-only').length,
      developmentOnlyComponents: components.filter((component) => component.usage === 'development-only').length,
      allowed: components.filter((component) => component.policyDecision === 'allowed').length,
      reviewRequired: components.filter((component) => component.policyDecision === 'review_required').length,
      blocked: components.filter((component) => component.policyDecision === 'blocked').length,
    },
    releaseGate: {
      status: releaseBlockers.length ? 'blocked' : 'approved',
      approvalStatus: policy.releaseApproval.status,
      approvalReviewedBy: policy.releaseApproval.reviewedBy,
      approvalReviewedAt: policy.releaseApproval.reviewedAt,
      blockers: releaseBlockers,
    },
    components,
  };
  return {
    inventory,
    inventoryJson: JSON.stringify(inventory, null, 2) + '\n',
    noticesMarkdown: buildNotices(inventory, internals),
  };
}

export const thirdPartyCompliancePaths = {
  root: ROOT,
  inventory: path.join(ROOT, 'docs/compliance/third-party-components.json'),
  notices: path.join(ROOT, 'THIRD_PARTY_NOTICES.md'),
  policy: POLICY_PATH,
  licenseCache: LICENSE_CACHE_PATH,
};
