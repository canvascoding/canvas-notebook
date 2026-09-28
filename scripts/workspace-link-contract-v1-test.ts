import assert from 'node:assert/strict';

import {
  WORKSPACE_FILE_OPERATION_RULES_V1,
  WORKSPACE_LINK_CONTRACT_VERSION_V1,
  WORKSPACE_LINK_RESOLUTION_RULES_V1,
} from '../app/lib/markdown/workspace-link-contract-v1';
import {
  buildWorkspaceLinkIndexFromDocuments,
  rewriteWorkspaceWikiLinksForRename,
} from '../app/lib/markdown/workspace-link-index-core';
import {
  WORKSPACE_LINK_CASES_V1,
  WORKSPACE_OPERATION_CASES_V1,
} from './fixtures/workspace-link-contract-v1';

assert.equal(WORKSPACE_LINK_CONTRACT_VERSION_V1, 1);
assert.equal(WORKSPACE_LINK_RESOLUTION_RULES_V1.markdown, 'exact-relative-or-workspace-root');
assert.equal(WORKSPACE_LINK_RESOLUTION_RULES_V1.wiki, 'unique-obsidian-candidate');
assert.equal(WORKSPACE_FILE_OPERATION_RULES_V1.stalePlan, 'reject-before-write');

const ids = new Set<string>();
for (const fixture of WORKSPACE_LINK_CASES_V1) {
  assert(!ids.has(fixture.id), `duplicate fixture: ${fixture.id}`);
  ids.add(fixture.id);
  assert(fixture.sourcePath.endsWith('.md'), fixture.id);

  const { expected, markdown } = fixture;
  if (expected.parse === 'parsed') {
    assert(expected.syntax, `${fixture.id}: parsed syntax required`);
    assert(expected.targetLiteral, `${fixture.id}: parsed target required`);
    const firstOffset = markdown.indexOf(expected.targetLiteral);
    assert(firstOffset >= 0, `${fixture.id}: target literal absent from source`);
    assert.equal(markdown.indexOf(expected.targetLiteral, firstOffset + 1), -1,
      `${fixture.id}: target literal must have a unique edit range`);
    assert.equal(markdown.slice(firstOffset, firstOffset + expected.targetLiteral.length), expected.targetLiteral);
    if (fixture.id === 'unicode-offset') {
      assert.equal(firstOffset, 7, 'UTF-16 offset counts the emoji as two code units');
      assert.equal(Buffer.byteLength(markdown.slice(0, firstOffset), 'utf8'), 9,
        'UTF-8 byte offset counts the emoji as four bytes');
    }
  } else {
    assert.equal(expected.syntax, null, fixture.id);
    assert.equal(expected.targetLiteral, null, fixture.id);
  }

  if (expected.resolve === 'resolved') {
    assert(expected.targetPath, `${fixture.id}: resolved target path required`);
    assert(fixture.catalog.some((item) => item.path === expected.targetPath),
      `${fixture.id}: resolved target must be in fixture catalog`);
  } else {
    assert.equal(expected.targetPath, null, fixture.id);
  }
  if (expected.rewrite === 'rewrite') {
    assert(expected.nextTargetLiteral, `${fixture.id}: rewritten target required`);
    assert(fixture.renamedTargetPath, `${fixture.id}: renamed path required`);
  } else {
    assert.equal(expected.nextTargetLiteral, null, fixture.id);
  }
}

assert.deepEqual(new Set(WORKSPACE_LINK_CASES_V1.map((fixture) => fixture.expected.parse)),
  new Set(['parsed', 'ignored', 'not-evaluated', 'omitted']));
assert.deepEqual(new Set(WORKSPACE_LINK_CASES_V1.map((fixture) => fixture.expected.resolve)),
  new Set(['resolved', 'missing', 'ambiguous', 'outside-workspace', 'external', 'anchor-only', 'not-evaluated', 'omitted']));
const fixtureSyntaxes = new Set(WORKSPACE_LINK_CASES_V1.map((fixture) => fixture.expected.syntax));
for (const syntax of ['inline-link', 'inline-image', 'reference-link', 'reference-image', 'reference-definition', 'wiki-link', 'wiki-embed']) {
  assert(fixtureSyntaxes.has(syntax as typeof WORKSPACE_LINK_CASES_V1[number]['expected']['syntax']),
    `missing ${syntax} fixture`);
}

let baselineCases = 0;
for (const fixture of WORKSPACE_LINK_CASES_V1) {
  if (fixture.phase !== 'baseline') continue;
  baselineCases += 1;
  const index = buildWorkspaceLinkIndexFromDocuments([
    { path: fixture.sourcePath, content: fixture.markdown },
    ...fixture.catalog
      .filter((item) => item.path !== fixture.sourcePath && item.path.endsWith('.md'))
      .map((item) => ({ path: item.path, content: item.content ?? '# Target' })),
  ]);
  const edges = index.edges.filter((edge) => edge.sourcePath === fixture.sourcePath);

  if (fixture.expected.parse !== 'parsed') {
    assert.equal(edges.length, 0, `${fixture.id}: ignored source must create no edge`);
    continue;
  }

  assert.equal(edges.length, 1, `${fixture.id}: expected one parsed edge`);
  const edge = edges[0];
  assert.equal(edge.kind, fixture.expected.syntax === 'wiki-link' ? 'wiki' : 'markdown', fixture.id);
  assert.equal(edge.status, fixture.expected.resolve, fixture.id);
  assert.equal(edge.targetPath, fixture.expected.targetPath, fixture.id);
  assert(edge.raw.includes(fixture.expected.targetLiteral!), `${fixture.id}: raw source span must contain target`);
  assert.equal(fixture.markdown.slice(edge.start, edge.end), edge.raw, fixture.id);

  if (fixture.expected.syntax === 'wiki-link' && fixture.expected.rewrite === 'rewrite') {
    const rewritten = rewriteWorkspaceWikiLinksForRename(
      fixture.markdown, edges, edge.targetPath!, fixture.renamedTargetPath!,
    );
    assert.equal(rewritten.updatedLinks, 1, fixture.id);
    assert(rewritten.content.includes(fixture.expected.nextTargetLiteral!), fixture.id);
    assert(!rewritten.content.includes(fixture.expected.targetLiteral!), fixture.id);
  }
  if (fixture.expected.rewrite === 'blocked') {
    const rewritten = rewriteWorkspaceWikiLinksForRename(
      fixture.markdown, edges, 'Other.md', 'Renamed.md',
    );
    assert.equal(rewritten.updatedLinks, 0, fixture.id);
    assert.equal(rewritten.content, fixture.markdown, fixture.id);
  }
}

const operationIds = new Set<string>();
for (const fixture of WORKSPACE_OPERATION_CASES_V1) {
  assert(!operationIds.has(fixture.id), `duplicate operation fixture: ${fixture.id}`);
  operationIds.add(fixture.id);
  assert(fixture.pathMappings.length > 0, fixture.id);
  for (const [from, to] of fixture.pathMappings) {
    assert(from && to, fixture.id);
    assert(!from.startsWith('/') && !to.startsWith('/'), fixture.id);
  }
  if (fixture.expectedStatus === 'complete') {
    assert(fixture.markdownAfter !== null, `${fixture.id}: complete case needs expected content`);
  }
  if (fixture.kind === 'copy' && fixture.expectedStatus === 'complete') {
    assert(fixture.markdownBefore.length > 0, `${fixture.id}: original copy content is retained`);
  }
}
assert.deepEqual(new Set(WORKSPACE_OPERATION_CASES_V1.map((fixture) => fixture.kind)),
  new Set(['rename', 'move', 'copy', 'overwrite']));
assert(WORKSPACE_OPERATION_CASES_V1.some((fixture) => fixture.sourceWorkspaceId !== fixture.destinationWorkspaceId));

console.log(`workspace-link-contract-v1-test: ok (${baselineCases} live parser/resolver cases, ${WORKSPACE_LINK_CASES_V1.length} syntax cases, ${WORKSPACE_OPERATION_CASES_V1.length} operation cases)`);
