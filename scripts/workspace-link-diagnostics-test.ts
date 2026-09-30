import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import { diagnoseWorkspaceLinks } from '../app/lib/markdown/workspace-link-diagnostics';

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');
const sourcePath = 'notes/source.md';
const content = '# Notes\n![hero](missing.jpg)\n[Guide](../guide.md#unchecked)\n[[offer]]\n[[new-missing]]\n';
const index = buildWorkspaceLinkIndexFromDocuments([
  { path: sourcePath, content },
  { path: 'guide.md', content: '# Guide' },
  { path: 'sales/a.md', content: '---\naliases: [offer]\n---\nA' },
  { path: 'sales/b.md', content: '---\naliases: [offer]\n---\nB' },
]);
const diagnosis = diagnoseWorkspaceLinks({ index, path: sourcePath, content, contentSha256: sha256(content),
  basis: 'applied', beforeContent: '![existing hero](missing.jpg)\n[[offer]]' });
assert.equal(diagnosis.status, 'complete');
assert.deepEqual(diagnosis.counts, { checked: 4, resolved: 1, missing: 2, ambiguous: 1, unverified: 0 });
assert.equal(diagnosis.contentSha256, sha256(content));
assert.equal(diagnosis.issues[0].line, 2);
assert.equal(diagnosis.issues[0].column, 9);
assert.equal(diagnosis.issues[0].target, 'missing.jpg');
assert.equal(diagnosis.issues[0].change, 'existing');
assert.deepEqual(diagnosis.issues[1].candidates, ['sales/a.md', 'sales/b.md']);
assert.equal(diagnosis.issues[1].change, 'existing');
assert.equal(diagnosis.issues[2].change, 'introduced');
assert.equal(diagnosis.anchorsChecked, false);
assert.equal(diagnosis.externalChecked, false);

// A reference that existed but only became ambiguous through this edit is new
// breakage, rather than an existing warning merely because its text is old.
const newAmbiguityContent = '---\naliases: [offer]\n---\n[[offer]]';
const newAmbiguityIndex = buildWorkspaceLinkIndexFromDocuments([
  { path: sourcePath, content: newAmbiguityContent },
  { path: 'sales/a.md', content: '---\naliases: [offer]\n---' },
]);
const newAmbiguity = diagnoseWorkspaceLinks({ index: newAmbiguityIndex, path: sourcePath,
  content: newAmbiguityContent, contentSha256: sha256(newAmbiguityContent), basis: 'proposed', beforeContent: '[[offer]]' });
assert.equal(newAmbiguity.issues[0].status, 'ambiguous');
assert.equal(newAmbiguity.issues[0].change, 'introduced');

const duplicateContent = '[first](missing.md)\n[second](missing.md)';
const duplicateIndex = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: duplicateContent }]);
const duplicates = diagnoseWorkspaceLinks({ index: duplicateIndex, path: sourcePath, content: duplicateContent,
  contentSha256: sha256(duplicateContent), basis: 'current', beforeContent: '[old](missing.md)' });
assert.deepEqual(duplicates.issues.map((issue) => issue.change), ['existing', 'introduced']);
const unknown = diagnoseWorkspaceLinks({ index: duplicateIndex, path: sourcePath, content: duplicateContent,
  contentSha256: sha256(duplicateContent), basis: 'current' });
assert.equal(unknown.issues[0].change, 'unknown');

const many = Array.from({ length: 25 }, (_, index) => `[${index}](${index}-${'x'.repeat(350)}.md)`).join('\n');
const manyIndex = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: many }]);
const limited = diagnoseWorkspaceLinks({ index: manyIndex, path: sourcePath, content: many,
  contentSha256: sha256(many), basis: 'proposed', beforeContent: '' });
assert.equal(limited.counts.missing, 25);
assert.equal(limited.issues.length, 20);
assert.ok(limited.issues.every((issue) => issue.target.length <= 300));
assert.equal(limited.truncated, true);
const aliasSources = Array.from({ length: 9 }, (_, index) => ({ path: `alias-${index}.md`, content: '---\naliases: [same]\n---' }));
const aliasContent = '[[same]]';
const aliasIndex = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: aliasContent }, ...aliasSources]);
const aliasDiagnosis = diagnoseWorkspaceLinks({ index: aliasIndex, path: sourcePath, content: aliasContent,
  contentSha256: sha256(aliasContent), basis: 'applied' });
assert.equal(aliasDiagnosis.issues[0].candidates.length, 5);
assert.equal(aliasDiagnosis.truncated, true);

const exactOnlyContent = '[Guide](../guide.md)';
const unrelatedOmission = buildWorkspaceLinkIndexFromDocuments([
  { path: sourcePath, content: exactOnlyContent }, { path: 'guide.md', content: '# Guide' },
], new Date(), [],
  [{ path: 'other.md', reason: 'unreadable' }]);
assert.equal(diagnoseWorkspaceLinks({ index: unrelatedOmission, path: sourcePath, content: exactOnlyContent,
  contentSha256: sha256(exactOnlyContent), basis: 'applied' }).status, 'complete');

const omittedAliasContent = '[[newsletter]]\n[[offer]]\n[[guide]]';
const omittedAliasIndex = buildWorkspaceLinkIndexFromDocuments([
  { path: sourcePath, content: omittedAliasContent },
  { path: 'sales/a.md', content: '---\naliases: [offer]\n---' },
  { path: 'guide.md', content: '# Guide' },
], new Date(), ['guide.md', 'sales/a.md', 'omitted.md'], [{ path: 'omitted.md', reason: 'unreadable' }]);
const omittedAliases = diagnoseWorkspaceLinks({ index: omittedAliasIndex, path: sourcePath,
  content: omittedAliasContent, contentSha256: sha256(omittedAliasContent), basis: 'applied' });
assert.equal(omittedAliases.status, 'partial');
assert.deepEqual(omittedAliases.counts, { checked: 3, resolved: 1, missing: 0, ambiguous: 0, unverified: 2 });
assert.ok(omittedAliases.issues.every((issue) => issue.status === 'not-evaluated'));
assert.ok(omittedAliases.notices.some((notice) => notice.includes('metadata was omitted')));

const removedAliasContent = '[[offer]]';
const beforeAliasIndex = buildWorkspaceLinkIndexFromDocuments([
  { path: sourcePath, content: removedAliasContent },
  { path: 'sales/a.md', content: '---\naliases: [offer]\n---' },
]);
const afterAliasIndex = buildWorkspaceLinkIndexFromDocuments([
  { path: sourcePath, content: removedAliasContent }, { path: 'sales/a.md', content: '# New product' },
]);
const removedAlias = diagnoseWorkspaceLinks({ index: afterAliasIndex, beforeIndex: beforeAliasIndex,
  path: sourcePath, content: removedAliasContent, contentSha256: sha256(removedAliasContent), basis: 'applied' });
assert.equal(removedAlias.issues[0].status, 'missing');
assert.equal(removedAlias.issues[0].change, 'introduced');

const unavailableBeforeSource = buildWorkspaceLinkIndexFromDocuments([], new Date(), [sourcePath],
  [{ path: sourcePath, reason: 'too-large' }]);
const unknownBeforeSource = diagnoseWorkspaceLinks({ index: afterAliasIndex, beforeIndex: unavailableBeforeSource,
  path: sourcePath, content: removedAliasContent, contentSha256: sha256(removedAliasContent), basis: 'applied' });
assert.equal(unknownBeforeSource.status, 'complete', 'current check is complete even when prior classification is unknown');
assert.equal(unknownBeforeSource.issues[0].change, 'unknown');

const missingBeforeAliases = buildWorkspaceLinkIndexFromDocuments([
  { path: sourcePath, content: removedAliasContent },
], new Date(), [sourcePath, 'sales/a.md'], [{ path: 'sales/a.md', reason: 'too-large' }]);
const unknownBeforeAlias = diagnoseWorkspaceLinks({ index: afterAliasIndex, beforeIndex: missingBeforeAliases,
  path: sourcePath, content: removedAliasContent, contentSha256: sha256(removedAliasContent), basis: 'applied' });
assert.equal(unknownBeforeAlias.issues[0].change, 'unknown', 'omitted aliases cannot prove prior missing status');
assert.ok(unknownBeforeAlias.notices.some((notice) => notice.includes('Prior link state')));

const exactBeforeContent = '[[guide]]';
const beforeExactWiki = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: exactBeforeContent }],
  new Date(), [sourcePath, 'guide.md'], [{ path: 'guide.md', reason: 'too-large' }]);
const afterExactWiki = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: exactBeforeContent }]);
const omittedExactTarget = diagnoseWorkspaceLinks({ index: beforeExactWiki, path: sourcePath, content: exactBeforeContent,
  contentSha256: sha256(exactBeforeContent), basis: 'current' });
assert.equal(omittedExactTarget.status, 'partial');
assert.equal(omittedExactTarget.counts.unverified, 1, 'unresolved extensionless Wiki links with omitted metadata remain unverified');
const knownBeforeExactWiki = diagnoseWorkspaceLinks({ index: afterExactWiki, beforeIndex: beforeExactWiki,
  path: sourcePath, content: exactBeforeContent, contentSha256: sha256(exactBeforeContent), basis: 'applied' });
assert.equal(knownBeforeExactWiki.issues[0].change, 'unknown', 'an inferred extension cannot override an unresolved prior index edge');

const explicitBeforeContent = '[[guide.md]]';
const explicitBeforeIndex = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: explicitBeforeContent }],
  new Date(), [sourcePath, 'guide.md'], [{ path: 'guide.md', reason: 'too-large' }]);
const explicitBefore = diagnoseWorkspaceLinks({ index: explicitBeforeIndex, path: sourcePath, content: explicitBeforeContent,
  contentSha256: sha256(explicitBeforeContent), basis: 'current' });
assert.equal(explicitBefore.status, 'complete');
assert.equal(explicitBefore.counts.resolved, 1, 'explicit Wiki file path agrees with the shared resolver despite omitted body');
const explicitAfterIndex = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: explicitBeforeContent }]);
const explicitAfter = diagnoseWorkspaceLinks({ index: explicitAfterIndex, beforeIndex: explicitBeforeIndex,
  path: sourcePath, content: explicitBeforeContent, contentSha256: sha256(explicitBeforeContent), basis: 'applied' });
assert.equal(explicitAfter.issues[0].change, 'introduced', 'explicit prior target resolution does not require alias metadata');
const sourceOmission = buildWorkspaceLinkIndexFromDocuments([], new Date(), [sourcePath],
  [{ path: sourcePath, reason: 'too-large' }]);
const omitted = diagnoseWorkspaceLinks({ index: sourceOmission, path: sourcePath, content,
  contentSha256: sha256(content), basis: 'applied' });
assert.equal(omitted.status, 'partial');
assert.equal(omitted.counts.checked, 0);
assert.equal(omitted.counts.unverified, 1);
assert.ok(omitted.notices[0].includes('unknown'));
assert.equal(diagnoseWorkspaceLinks({ index: sourceOmission, path: 'absent.md', content,
  contentSha256: sha256(content), basis: 'applied' }).status, 'unavailable');
assert.equal(diagnoseWorkspaceLinks({ index, path: 'source.mdx', content,
  contentSha256: sha256(content), basis: 'applied' }).status, 'not_applicable');

const excluded = '[web](https://example.com)\n![remote](https://example.com/image.jpg)\n[mail](mailto:test@example.com)\n'
  + '```md\n[[not-a-link]]\n[not](missing.md)\n```\n`[[inline-code]]`\n[anchor](#here)';
const excludedIndex = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: excluded }]);
const excludedDiagnosis = diagnoseWorkspaceLinks({ index: excludedIndex, path: sourcePath, content: excluded,
  contentSha256: sha256(excluded), basis: 'applied' });
assert.deepEqual(excludedDiagnosis.counts, { checked: 0, resolved: 0, missing: 0, ambiguous: 0, unverified: 0 });
assert.equal(excludedDiagnosis.status, 'complete');

const partialContent = '[escape](../../outside.md)\n<a href="maybe.md">HTML</a>\n[query](local.md?v=1)';
const partialIndex = buildWorkspaceLinkIndexFromDocuments([{ path: sourcePath, content: partialContent }]);
const partial = diagnoseWorkspaceLinks({ index: partialIndex, path: sourcePath, content: partialContent,
  contentSha256: sha256(partialContent), basis: 'applied', beforeContent: '' });
assert.equal(partial.status, 'partial');
assert.equal(partial.counts.unverified, 3);
assert.deepEqual(partial.issues.map((issue) => issue.status), ['outside-workspace', 'not-evaluated', 'not-evaluated']);

console.log('workspace-link-diagnostics-test: ok');
