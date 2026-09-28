import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Value } from 'typebox/value';

import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  FileVersionCompareResponseSchemaV1,
  buildFileVersionCenterDeepLinkV1,
  parseFileChangeGroupV1,
  parseFileReviewPolicyUpdateRequestV1,
  parseFileReviewPolicyV1,
  parseFileVersionCapabilitiesV1,
  parseFileVersionCenterDeepLinkV1,
  parseFileVersionCenterErrorResponseV1,
  parseFileVersionCenterRequestV1,
  parseFileVersionCompareRequestV1,
  parseFileVersionCompareResponseV1,
  parseFileVersionRestoreRequestV1,
  parseFileVersionRestoreResponseV1,
  parseFileVersionTimelineResponseV1,
  removeFileVersionCenterDeepLinkV1,
  type FileVersionCenterErrorCode,
  type FileVersionCenterRequestV1,
} from '../app/lib/file-version-center/contracts';

type Fixtures = {
  fixtureVersion: string;
  contractVersion: number;
  valid: {
    openRequests: unknown[];
    capabilities: unknown;
    policy: unknown;
    timelinePage: unknown;
    compareRequest: unknown;
    diffPages: unknown[];
    restoreRequest: unknown;
    restoreResponse: unknown;
    policyUpdate: unknown;
    changeGroup: unknown;
    errorResponse: unknown;
  };
  invalid: Record<string, unknown>;
};

const fixturePath = path.resolve(
  __dirname,
  '../app/lib/file-version-center/fixtures/file-version-center-contract-v1.json',
);

function expectContractError(
  action: () => unknown,
  code?: FileVersionCenterErrorCode,
): FileVersionCenterContractError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof FileVersionCenterContractError);
    if (code) assert.equal(error.code, code);
    return error;
  }
  assert.fail('Expected a file version center contract error.');
}

function requestWithPath(pathHint: string): unknown {
  return {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'path', workspaceId: 'workspace-1', pathHint },
    initialView: 'history',
    source: 'deep_link',
  };
}

function assertDeepLinkRoundtrip(request: FileVersionCenterRequestV1, href: string): void {
  const link = buildFileVersionCenterDeepLinkV1(href, request);
  assert.ok(link.length <= FILE_VERSION_CENTER_CONTRACT_LIMITS.deepLinkCharacters);
  assert.equal(link.includes('/data/'), false);
  assert.equal(/token|grantId|authorization/iu.test(link), false);

  const query = link.split('?', 2)[1]?.split('#', 1)[0] ?? '';
  const decoded = parseFileVersionCenterDeepLinkV1(new URLSearchParams(query));
  assert.ok(decoded);
  assert.equal(decoded.contractVersion, FILE_VERSION_CENTER_CONTRACT_VERSION);
  assert.deepEqual(decoded.target, request.target);
  assert.deepEqual(decoded.selectedEntry, request.selectedEntry);
  assert.equal(decoded.branchOverview, request.branchOverview);
  assert.equal(decoded.initialView, request.initialView);
  assert.equal(decoded.source, 'deep_link');
  assert.equal(new URL(link, 'https://canvas.test').searchParams.get('fvrcSource'), null);

  const removed = removeFileVersionCenterDeepLinkV1(link);
  assert.equal(removed, href);
}

const spoofedNotificationSource = parseFileVersionCenterDeepLinkV1(new URLSearchParams(
  'fvrc=1&fvrcTarget=lineage&fvrcWorkspace=workspace-one&fvrcRef=lineage-one&fvrcView=reviews&fvrcSelectedKind=agent_operation&fvrcSelectedId=operation-one&fvrcSource=notification',
));
assert.equal(spoofedNotificationSource?.source, 'deep_link', 'URL input can never create a trusted notification source');

async function main() {
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixtures;
  assert.equal(fixtures.fixtureVersion, '1.0.0');
  assert.equal(fixtures.contractVersion, FILE_VERSION_CENTER_CONTRACT_VERSION);

  const openRequests = fixtures.valid.openRequests.map(parseFileVersionCenterRequestV1);
  assert.equal(openRequests.length, 4);
  for (const request of openRequests) {
    assertDeepLinkRoundtrip(request, '/notebook?chat=open#editor');
  }

  const branchRequest = parseFileVersionCenterRequestV1({
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
    selectedEntry: { kind: 'agent_operation', id: 'operation-root-exact' },
    branchOverview: true,
    initialView: 'reviews',
    source: 'deep_link',
  });
  const branchHref = buildFileVersionCenterDeepLinkV1('/notebook?chat=open#editor', branchRequest);
  const branchParams = new URLSearchParams(branchHref.split('?', 2)[1]?.split('#', 1)[0] ?? '');
  assert.equal(branchParams.get('fvrcBranch'), '1');
  const decodedBranch = parseFileVersionCenterDeepLinkV1(branchParams);
  assert.equal(decodedBranch?.branchOverview, true);
  assert.deepEqual(decodedBranch?.selectedEntry, { kind: 'agent_operation', id: 'operation-root-exact' },
    'branch overview round-trips the exact selected root operation');
  assertDeepLinkRoundtrip(branchRequest, '/notebook?chat=open#editor');

  const noSelectionHref = buildFileVersionCenterDeepLinkV1('/notebook', {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
    initialView: 'history',
    source: 'deep_link',
  });
  assert.equal(new URLSearchParams(noSelectionHref.split('?', 2)[1]).has('fvrcBranch'), false,
    'ordinary historical links remain free of the opt-in branch key');
  const staleBranchHref = buildFileVersionCenterDeepLinkV1('/notebook?fvrcBranch=1', {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
    initialView: 'history',
    source: 'deep_link',
  });
  assert.equal(new URLSearchParams(staleBranchHref.split('?', 2)[1]).has('fvrcBranch'), false,
    'serializing a non-branch request clears stale branch intent from the current URL');

  const branchBase = 'fvrc=1&fvrcTarget=lineage&fvrcWorkspace=workspace-one&fvrcRef=lineage-one&fvrcView=reviews';
  for (const malformed of [
    `${branchBase}&fvrcBranch=0&fvrcSelectedKind=agent_operation&fvrcSelectedId=operation-one`,
    `${branchBase}&fvrcBranch=true&fvrcSelectedKind=agent_operation&fvrcSelectedId=operation-one`,
    `${branchBase}&fvrcBranch=1`,
    `${branchBase}&fvrcBranch=1&fvrcSelectedKind=revision&fvrcSelectedId=revision-one`,
    'fvrc=1&fvrcTarget=lineage&fvrcWorkspace=workspace-one&fvrcRef=lineage-one&fvrcBranch=1&fvrcView=history&fvrcSelectedKind=agent_operation&fvrcSelectedId=operation-one',
    `${branchBase}&fvrcSelectedKind=agent_operation`,
    `${branchBase}&fvrcSelectedId=operation-one`,
    `${branchBase}&fvrcSelectedKind=unknown&fvrcSelectedId=operation-one`,
  ]) {
    expectContractError(
      () => parseFileVersionCenterDeepLinkV1(new URLSearchParams(malformed)),
      FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
    );
  }
  expectContractError(() => parseFileVersionCenterRequestV1({ ...branchRequest, branchOverview: false }),
    FILE_VERSION_CENTER_ERROR_CODES.invalidRequest);
  expectContractError(() => parseFileVersionCenterRequestV1({ ...branchRequest, selectedEntry: undefined }),
    FILE_VERSION_CENTER_ERROR_CODES.invalidRequest);

  parseFileVersionCapabilitiesV1(fixtures.valid.capabilities);
  parseFileReviewPolicyV1(fixtures.valid.policy);
  parseFileVersionTimelineResponseV1(fixtures.valid.timelinePage);
  parseFileVersionCompareRequestV1(fixtures.valid.compareRequest);
  fixtures.valid.diffPages.forEach(parseFileVersionCompareResponseV1);
  parseFileVersionRestoreRequestV1(fixtures.valid.restoreRequest);
  parseFileVersionRestoreResponseV1(fixtures.valid.restoreResponse);
  parseFileReviewPolicyUpdateRequestV1(fixtures.valid.policyUpdate);
  parseFileChangeGroupV1(fixtures.valid.changeGroup);
  parseFileVersionCenterErrorResponseV1(fixtures.valid.errorResponse);

  const diffPages = fixtures.valid.diffPages.map(parseFileVersionCompareResponseV1);
  assert.equal(diffPages[0]?.page.hasMore, true);
  assert.equal(diffPages[0]?.page.nextCursor, 'diff-cursor-2');
  assert.equal(diffPages[1]?.page.hasMore, false);
  assert.equal(diffPages[1]?.page.nextCursor, null);
  assert.deepEqual(diffPages[0]?.current.fence, diffPages[1]?.current.fence);
  assert.deepEqual(diffPages[0]?.candidate.selection, diffPages[1]?.candidate.selection);

  expectContractError(
    () => parseFileVersionCenterRequestV1(fixtures.invalid.absolutePathTarget),
    FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
  );
  expectContractError(
    () => parseFileVersionCenterRequestV1(fixtures.invalid.traversalPathTarget),
    FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
  );
  expectContractError(
    () => parseFileVersionCenterRequestV1(fixtures.invalid.contentInReference),
    FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
  );
  expectContractError(
    () => parseFileVersionCenterRequestV1(fixtures.invalid.grantInReference),
    FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
  );
  expectContractError(
    () => parseFileVersionCenterRequestV1(fixtures.invalid.unsupportedVersion),
    FILE_VERSION_CENTER_ERROR_CODES.unsupportedVersion,
  );
  expectContractError(
    () => parseFileChangeGroupV1(fixtures.invalid.nonContiguousChangeGroup),
    FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
  );

  for (const unsafePath of [
    '../secret.env',
    'docs/../secret.env',
    'C:\\data\\secret.env',
    '\\\\server\\share\\secret.env',
    'file:///data/secret.env',
    'docs//README.md',
    'docs/./README.md',
    'docs\\README.md',
  ]) {
    expectContractError(
      () => parseFileVersionCenterRequestV1(requestWithPath(unsafePath)),
      FILE_VERSION_CENTER_ERROR_CODES.invalidTarget,
    );
  }

  expectContractError(
    () => parseFileVersionCenterRequestV1(
      requestWithPath(`docs/${'a'.repeat(FILE_VERSION_CENTER_CONTRACT_LIMITS.pathHintCharacters)}.md`),
    ),
    FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
  );
  expectContractError(
    () => parseFileVersionCenterRequestV1({
      ...requestWithPath('docs/README.md') as Record<string, unknown>,
      padding: 'x'.repeat(FILE_VERSION_CENTER_CONTRACT_LIMITS.payloadBytes),
    }),
    FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge,
  );

  const firstDiffPage = fixtures.valid.diffPages[0] as Record<string, unknown>;
  const oversizedLine = {
    ...firstDiffPage,
    hunks: [{
      id: 'hunk-oversized', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [{ kind: 'context', oldLineNumber: 1, newLineNumber: 1,
        text: 'x'.repeat(FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters + 1) }],
    }],
  };
  assert.equal(Value.Check(FileVersionCompareResponseSchemaV1, oversizedLine), false);

  const hunk = (firstDiffPage.hunks as unknown[])[0];
  const oversizedHunkPage = {
    ...firstDiffPage,
    hunks: Array.from(
      { length: FILE_VERSION_CENTER_CONTRACT_LIMITS.diffHunksPerPage + 1 },
      (_, index) => ({ ...(hunk as Record<string, unknown>), id: `hunk-${index}` }),
    ),
  };
  assert.equal(Value.Check(FileVersionCompareResponseSchemaV1, oversizedHunkPage), false);

  const codes = Object.values(FILE_VERSION_CENTER_ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length, 'Error codes must remain unique.');
  assert.ok(codes.every((code) => /^FVRC_[A-Z_]+$/u.test(code)));

  const unsupportedLink = new URLSearchParams('fvrc=2&fvrcTarget=lineage&fvrcWorkspace=w&fvrcRef=l');
  expectContractError(
    () => parseFileVersionCenterDeepLinkV1(unsupportedLink),
    FILE_VERSION_CENTER_ERROR_CODES.unsupportedVersion,
  );
  const absentLink = parseFileVersionCenterDeepLinkV1(new URLSearchParams('chat=open'));
  assert.equal(absentLink, null);

  console.log('file version center contract v1 tests passed');
}

void main();
