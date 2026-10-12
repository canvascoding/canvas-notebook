import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import { parseWorkspaceLocalLinks } from '../app/lib/markdown/workspace-local-link-parser';
import { diagnoseWorkspaceLinks } from '../app/lib/markdown/workspace-link-diagnostics';
import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';

for (const newline of ['\n', '\r\n']) {
  for (const title of ['plain', '😀', '𝄞 𠮷 😀']) {
    const prefix = ['---', `title: ${title}`, 'tags: [regression]', '---', '', ''].join(newline);
    const content = `${prefix}[[B]]${newline}[link](B.md)${newline}`;
    const parsed = parseWorkspaceLocalLinks(content, 'A.md');
    assert.deepEqual(parsed.unevaluated, []);
    assert.deepEqual(parsed.links.map((link) => link.kind), ['wiki', 'markdown'], `${title}: both link types`);
    for (const link of parsed.links) {
      assert.equal(content.slice(link.start, link.end), link.raw);
      assert.equal(link.start, content.indexOf(link.raw));
      assert.equal(content.slice(link.targetStart, link.targetEnd), link.targetLiteral);
      assert.equal(link.targetStart, content.indexOf(link.kind === 'wiki' ? '[[B]]' : '(B.md)') + (link.kind === 'wiki' ? 2 : 1));
    }
    const index = buildWorkspaceLinkIndexFromDocuments([
      { path: 'A.md', content }, { path: 'B.md', content: '# Target' },
    ]);
    assert.equal(index.coverage.complete, true);
    assert.deepEqual(index.edges.map((edge) => [edge.kind, edge.status, edge.targetPath]), [
      ['wiki', 'resolved', 'B.md'], ['markdown', 'resolved', 'B.md'],
    ]);
    assert.equal(index.backlinks['B.md'].length, 2);
    const diagnosis = diagnoseWorkspaceLinks({ index, path: 'A.md', content,
      contentSha256: createHash('sha256').update(content).digest('hex'), basis: 'current' });
    assert.equal(diagnosis.status, 'complete');
    assert.deepEqual(diagnosis.counts, { checked: 2, resolved: 2, missing: 0, ambiguous: 0, unverified: 0 });
    const plan = createWorkspaceFileOperationPlan({
      kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
      selections: [{ sourcePath: 'B.md', destinationPath: 'C.md' }],
      snapshots: [{ workspaceId: 'w1', entries: [
        { path: 'A.md', kind: 'file', identity: 'a', markdownContent: content },
        { path: 'B.md', kind: 'file', identity: 'b', markdownContent: '# Target' },
      ] }],
    });
    assert.equal(plan.readiness, 'ready');
    assert.equal(plan.linkEdits.length, 2, 'both references must be repaired');
    for (const edit of plan.linkEdits) {
      const range = edit.targetRange;
      assert.equal(content.slice(range.startUtf16, range.endUtf16), edit.previousTargetLiteral);
      assert.equal(Buffer.from(content).subarray(range.startUtf8Byte, range.endUtf8Byte).toString(), edit.previousTargetLiteral);
    }
    const after = plan.previewContents.find((entry) => entry.path === 'A.md')?.content;
    assert.equal(after, `${prefix}[[C]]${newline}[link](C.md)${newline}`, 'only target literals change');
    const repaired = buildWorkspaceLinkIndexFromDocuments([
      { path: 'A.md', content: after! }, { path: 'C.md', content: '# Target' },
    ]);
    assert.deepEqual(repaired.edges.map((edge) => [edge.kind, edge.status, edge.targetPath]), [
      ['wiki', 'resolved', 'C.md'], ['markdown', 'resolved', 'C.md'],
    ]);
  }
}

console.log('workspace-link-frontmatter-test: 6 parser/index/diagnostics/rename scenarios passed');
