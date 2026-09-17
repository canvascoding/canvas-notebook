import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileReviewPolicyV1,
  parseFileVersionCapabilitiesV1,
} from '../app/lib/file-version-center/contracts';
import {
  FILE_REVIEW_PRODUCT_COPY_V1,
  FILE_VERSION_CENTER_LIMITS_V1,
  FILE_VERSION_CENTER_PREVIEW_POLICY_V1,
  FILE_VERSION_CENTER_PROTECTED_SOURCES_V1,
  FILE_VERSION_CENTER_RATE_LIMITS_V1,
  assertFileVersionScopeV1,
  classifyFileVersionFileV1,
  evaluateFileVersionCaptureAdmissionV1,
  evaluateFileVersionRetentionV1,
  isFileVersionCompareAdmittedV1,
  resolveEffectiveFileReviewPolicyV1,
  resolveFileVersionCapabilitiesV1,
  resolveFileVersionRolloutV1,
  type FileVersionCaptureAdmissionInputV1,
  type FileVersionCaptureAdmissionDecisionV1,
  type FileVersionCompareAdmissionInputV1,
  type FileVersionRetentionDecisionV1,
  type FileVersionRetentionInputV1,
  type FileVersionRolloutDecisionV1,
  type FileVersionScopeInputV1,
  type ResolveFileReviewPolicyInputV1,
  type ResolveFileVersionCapabilitiesInputV1,
} from '../app/lib/file-version-center/policy-v1';

type NamedCase<Input, Expected> = {
  name: string;
  input: Input;
  expected: Expected;
};

type Fixtures = {
  fixtureVersion: string;
  contractVersion: number;
  rolloutCases: Array<{
    name: string;
    value: string | null;
    expected: FileVersionRolloutDecisionV1;
  }>;
  capabilityCases: Array<NamedCase<
    ResolveFileVersionCapabilitiesInputV1,
    ReturnType<typeof resolveFileVersionCapabilitiesV1>
  >>;
  scopeCases: Array<{
    name: string;
    input: FileVersionScopeInputV1;
    allowed: boolean;
  }>;
  policyCases: Array<NamedCase<
    ResolveFileReviewPolicyInputV1,
    ReturnType<typeof resolveEffectiveFileReviewPolicyV1>
  >>;
  retentionCases: Array<NamedCase<
    FileVersionRetentionInputV1,
    FileVersionRetentionDecisionV1
  >>;
  captureCases: Array<NamedCase<
    FileVersionCaptureAdmissionInputV1,
    FileVersionCaptureAdmissionDecisionV1
  >>;
  compareCases: Array<{
    name: string;
    input: FileVersionCompareAdmissionInputV1;
    admitted: boolean;
  }>;
  productCopy: typeof FILE_REVIEW_PRODUCT_COPY_V1;
};

const fixturePath = path.resolve(
  __dirname,
  '../app/lib/file-version-center/fixtures/file-version-center-policy-v1.json',
);

function assertScopeDenied(input: FileVersionScopeInputV1, name: string): void {
  assert.throws(
    () => assertFileVersionScopeV1(input),
    (error: unknown) => error instanceof FileVersionCenterContractError
      && error.code === FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
    name,
  );
}

async function main() {
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixtures;
  assert.equal(fixtures.fixtureVersion, '1.1.0');
  assert.equal(fixtures.contractVersion, FILE_VERSION_CENTER_CONTRACT_VERSION);

  for (const testCase of fixtures.rolloutCases) {
    assert.deepEqual(resolveFileVersionRolloutV1(testCase.value), testCase.expected, testCase.name);
  }
  assert.deepEqual(
    resolveFileVersionRolloutV1(undefined),
    fixtures.rolloutCases.find((testCase) => testCase.expected.mode === 'full')?.expected,
  );
  assert.deepEqual(
    [...new Set(fixtures.rolloutCases
      .filter((testCase) => testCase.expected.notifications)
      .map((testCase) => testCase.expected.mode))],
    ['full'],
  );

  for (const testCase of fixtures.capabilityCases) {
    const actual = resolveFileVersionCapabilitiesV1(testCase.input);
    assert.deepEqual(actual, testCase.expected, testCase.name);
    parseFileVersionCapabilitiesV1(actual);
  }
  assert.equal(classifyFileVersionFileV1('README.MD'), 'markdown');
  assert.equal(classifyFileVersionFileV1('notes.txt'), 'text');
  assert.equal(classifyFileVersionFileV1('src/page.tsx'), 'code');
  assert.equal(classifyFileVersionFileV1('report.xlsx'), 'office');
  assert.equal(classifyFileVersionFileV1('photo.jpeg'), 'binary');

  for (const testCase of fixtures.scopeCases) {
    if (testCase.allowed) {
      assert.doesNotThrow(() => assertFileVersionScopeV1(testCase.input), testCase.name);
    } else {
      assertScopeDenied(testCase.input, testCase.name);
    }
  }

  for (const testCase of fixtures.policyCases) {
    const actual = resolveEffectiveFileReviewPolicyV1(testCase.input);
    assert.deepEqual(actual, testCase.expected, testCase.name);
    parseFileReviewPolicyV1(actual);
  }
  const missingPolicy = resolveEffectiveFileReviewPolicyV1({
    requestedMode: null,
    policyRevision: null,
    preferenceState: 'missing',
    persistenceState: 'ready',
    hardSafetyRequiresReview: false,
    workspacePolicy: 'allow_user_choice',
    operationExplicitlyRequiresReview: false,
  });
  assert.equal(missingPolicy.requestedMode, 'safe_direct');
  assert.equal(missingPolicy.effectiveMode, 'safe_direct');
  assert.equal(missingPolicy.locked, false);
  assert.equal(missingPolicy.reason, 'default_safe_direct');
  const failedPolicy = resolveEffectiveFileReviewPolicyV1({
    requestedMode: 'safe_direct',
    policyRevision: 9,
    preferenceState: 'error',
    persistenceState: 'unavailable',
    hardSafetyRequiresReview: false,
    workspacePolicy: 'unknown',
    operationExplicitlyRequiresReview: false,
  });
  assert.equal(failedPolicy.effectiveMode, 'review_required');
  assert.equal(failedPolicy.locked, true);

  for (const testCase of fixtures.retentionCases) {
    assert.deepEqual(
      evaluateFileVersionRetentionV1(testCase.input),
      testCase.expected,
      testCase.name,
    );
  }
  assert.deepEqual(
    [...FILE_VERSION_CENTER_PROTECTED_SOURCES_V1].sort(),
    ['agent_apply', 'external_import', 'initial', 'legacy_guest', 'manual', 'restore'],
  );
  assert.deepEqual(
    evaluateFileVersionRetentionV1({
      source: 'automatic_checkpoint',
      ageDays: -1,
      newestRank: 101,
      lineageArchivedAgeDays: null,
      referencedByPendingReview: false,
    }),
    { retain: true, reason: 'invalid_measurement' },
  );

  for (const testCase of fixtures.captureCases) {
    assert.deepEqual(
      evaluateFileVersionCaptureAdmissionV1(testCase.input),
      testCase.expected,
      testCase.name,
    );
  }
  assert.deepEqual(
    evaluateFileVersionCaptureAdmissionV1({
      incomingRawBytes: -1,
      incomingStoredBytes: 0,
      lineageStoredBytes: 0,
      workspaceStoredBytes: 0,
      lineageVersionCount: 0,
      safelyReclaimableLineageBytes: 0,
      safelyReclaimableWorkspaceBytes: 0,
      safelyReclaimableVersionCount: 0,
    }),
    { accepted: false, reason: 'invalid_measurement' },
  );
  assert.deepEqual(
    evaluateFileVersionCaptureAdmissionV1({
      incomingRawBytes: 1,
      incomingStoredBytes: 1,
      lineageStoredBytes: 0,
      workspaceStoredBytes: 0,
      lineageVersionCount: 0,
      safelyReclaimableLineageBytes: 1,
      safelyReclaimableWorkspaceBytes: 0,
      safelyReclaimableVersionCount: 0,
    }),
    { accepted: false, reason: 'invalid_measurement' },
  );

  for (const testCase of fixtures.compareCases) {
    assert.equal(isFileVersionCompareAdmittedV1(testCase.input), testCase.admitted, testCase.name);
  }

  assert.equal(FILE_VERSION_CENTER_LIMITS_V1.maxRawVersionBytes, 1_048_576);
  assert.equal(FILE_VERSION_CENTER_LIMITS_V1.maxVersionsPerLineage, 500);
  assert.equal(FILE_VERSION_CENTER_LIMITS_V1.minNewestVersionsPerLineage, 100);
  assert.equal(FILE_VERSION_CENTER_LIMITS_V1.automaticCheckpointRetentionDays, 90);
  assert.equal(FILE_VERSION_CENTER_LIMITS_V1.archivedLineageGraceDays, 30);
  assert.equal(FILE_VERSION_CENTER_LIMITS_V1.auditMetadataRetentionDays, 365);
  assert.ok(
    FILE_VERSION_CENTER_LIMITS_V1.maxDiffHunks
      >= FILE_VERSION_CENTER_CONTRACT_LIMITS.diffHunksPerPage,
  );
  assert.deepEqual(FILE_VERSION_CENTER_RATE_LIMITS_V1.compare, {
    perUserPerMinute: 30,
    perIpPerMinute: 120,
  });
  assert.deepEqual(FILE_VERSION_CENTER_RATE_LIMITS_V1.restore, {
    perUserPerMinute: 10,
    perIpPerMinute: 60,
  });

  assert.equal(FILE_VERSION_CENTER_PREVIEW_POLICY_V1.markdown.rawHtml, false);
  assert.equal(FILE_VERSION_CENTER_PREVIEW_POLICY_V1.markdown.remoteResources, false);
  assert.equal(FILE_VERSION_CENTER_PREVIEW_POLICY_V1.markdown.activeLinks, false);
  assert.equal(FILE_VERSION_CENTER_PREVIEW_POLICY_V1.text.executableContent, false);

  assert.deepEqual(FILE_REVIEW_PRODUCT_COPY_V1, fixtures.productCopy);
  assert.match(FILE_REVIEW_PRODUCT_COPY_V1.description, /neue Agentenänderungen/u);
  assert.match(FILE_REVIEW_PRODUCT_COPY_V1.safeDirect, /wenn sicher/u);
  assert.match(FILE_REVIEW_PRODUCT_COPY_V1.unavailable, /Prüfung.*erforderlich/u);

  console.log('file version center policy v1 tests passed');
}

void main();
