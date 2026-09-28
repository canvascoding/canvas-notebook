import type {
  WorkspaceFileOperationKindV1,
  WorkspaceLinkParseStatusV1,
  WorkspaceLinkResolveStatusV1,
  WorkspaceLinkRewriteStatusV1,
  WorkspaceLinkSyntaxV1,
} from '../../app/lib/markdown/workspace-link-contract-v1';

/**
 * Fixed v1 acceptance matrix. `baseline` rows are exercised against the
 * existing index today. `planned` rows become executable parser/rewriter
 * regressions in FL-02/FL-03; their expected result is normative even while
 * the old parser cannot produce it. All paths are workspace-relative.
 */
export type WorkspaceLinkContractFixtureV1 = {
  id: string;
  phase: 'baseline' | 'planned';
  sourcePath: string;
  markdown: string;
  catalog: Array<{ path: string; content?: string; sizeBytes?: number }>;
  expected: {
    parse: WorkspaceLinkParseStatusV1;
    syntax: WorkspaceLinkSyntaxV1 | null;
    /** Exact source spelling inside the delimiters; null when not parsed. */
    targetLiteral: string | null;
    resolve: WorkspaceLinkResolveStatusV1;
    targetPath: string | null;
    rewrite: WorkspaceLinkRewriteStatusV1;
    nextTargetLiteral: string | null;
  };
  /** The old target's path is renamed to this path for the rewrite expectation. */
  renamedTargetPath?: string;
};

export const WORKSPACE_LINK_CASES_V1: readonly WorkspaceLinkContractFixtureV1[] = [
  {
    id: 'inline-relative-fragment', phase: 'baseline',
    sourcePath: 'Projects/Overview.md', markdown: '[Plan](./Plan.md#Outcome)',
    catalog: [{ path: 'Projects/Plan.md' }], renamedTargetPath: 'Projects/Roadmap.md',
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: './Plan.md#Outcome', resolve: 'resolved', targetPath: 'Projects/Plan.md', rewrite: 'rewrite', nextTargetLiteral: './Roadmap.md#Outcome' },
  },
  {
    id: 'wiki-alias-fragment', phase: 'baseline',
    sourcePath: 'Projects/Overview.md', markdown: '[[Plan#Outcome|Roadmap]]',
    catalog: [{ path: 'Projects/Plan.md' }], renamedTargetPath: 'Projects/Roadmap.md',
    expected: { parse: 'parsed', syntax: 'wiki-link', targetLiteral: 'Plan#Outcome', resolve: 'resolved', targetPath: 'Projects/Plan.md', rewrite: 'rewrite', nextTargetLiteral: 'Projects/Roadmap#Outcome' },
  },
  {
    id: 'wiki-missing', phase: 'baseline',
    sourcePath: 'Projects/Overview.md', markdown: '[[Absent]]', catalog: [],
    expected: { parse: 'parsed', syntax: 'wiki-link', targetLiteral: 'Absent', resolve: 'missing', targetPath: null, rewrite: 'blocked', nextTargetLiteral: null },
  },
  {
    id: 'wiki-ambiguous', phase: 'baseline',
    sourcePath: 'Projects/Overview.md', markdown: '[[Shared]]',
    catalog: [{ path: 'A/Shared.md' }, { path: 'B/Shared.md' }],
    expected: { parse: 'parsed', syntax: 'wiki-link', targetLiteral: 'Shared', resolve: 'ambiguous', targetPath: null, rewrite: 'blocked', nextTargetLiteral: null },
  },
  {
    id: 'code-span', phase: 'baseline',
    sourcePath: 'Projects/Overview.md', markdown: '`[Plan](./Plan.md)`',
    catalog: [{ path: 'Projects/Plan.md' }],
    expected: { parse: 'ignored', syntax: null, targetLiteral: null, resolve: 'not-evaluated', targetPath: null, rewrite: 'not-applicable', nextTargetLiteral: null },
  },
  {
    id: 'code-fence', phase: 'baseline',
    sourcePath: 'Projects/Overview.md', markdown: '```md\n[[Plan]]\n```',
    catalog: [{ path: 'Projects/Plan.md' }],
    expected: { parse: 'ignored', syntax: null, targetLiteral: null, resolve: 'not-evaluated', targetPath: null, rewrite: 'not-applicable', nextTargetLiteral: null },
  },
  {
    id: 'external-url', phase: 'baseline',
    sourcePath: 'Projects/Overview.md', markdown: '[Site](https://example.com/Plan.md)',
    catalog: [{ path: 'Projects/Plan.md' }],
    expected: { parse: 'ignored', syntax: null, targetLiteral: null, resolve: 'external', targetPath: null, rewrite: 'not-applicable', nextTargetLiteral: null },
  },
  {
    id: 'inline-image', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '![Chart](../assets/chart.png)',
    catalog: [{ path: 'assets/chart.png' }], renamedTargetPath: 'assets/chart-v2.png',
    expected: { parse: 'parsed', syntax: 'inline-image', targetLiteral: '../assets/chart.png', resolve: 'resolved', targetPath: 'assets/chart.png', rewrite: 'rewrite', nextTargetLiteral: '../assets/chart-v2.png' },
  },
  {
    id: 'wiki-embed-image', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '![[assets/chart.png]]',
    catalog: [{ path: 'assets/chart.png' }], renamedTargetPath: 'assets/chart-v2.png',
    expected: { parse: 'parsed', syntax: 'wiki-embed', targetLiteral: 'assets/chart.png', resolve: 'resolved', targetPath: 'assets/chart.png', rewrite: 'rewrite', nextTargetLiteral: 'assets/chart-v2.png' },
  },
  {
    id: 'reference-definition-shared', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '[First][plan] and [Second][plan]\n\n[plan]: ./Plan.md "Title"',
    catalog: [{ path: 'Projects/Plan.md' }], renamedTargetPath: 'Projects/Roadmap.md',
    expected: { parse: 'parsed', syntax: 'reference-definition', targetLiteral: './Plan.md', resolve: 'resolved', targetPath: 'Projects/Plan.md', rewrite: 'rewrite', nextTargetLiteral: './Roadmap.md' },
  },
  {
    id: 'reference-link-use', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '[Plan][plan]\n\n[plan]: ./Plan.md',
    catalog: [{ path: 'Projects/Plan.md' }], renamedTargetPath: 'Projects/Roadmap.md',
    expected: { parse: 'parsed', syntax: 'reference-link', targetLiteral: './Plan.md', resolve: 'resolved', targetPath: 'Projects/Plan.md', rewrite: 'rewrite', nextTargetLiteral: './Roadmap.md' },
  },
  {
    id: 'reference-image-use', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '![Chart][asset]\n\n[asset]: ../assets/chart.png',
    catalog: [{ path: 'assets/chart.png' }], renamedTargetPath: 'assets/chart-v2.png',
    expected: { parse: 'parsed', syntax: 'reference-image', targetLiteral: '../assets/chart.png', resolve: 'resolved', targetPath: 'assets/chart.png', rewrite: 'rewrite', nextTargetLiteral: '../assets/chart-v2.png' },
  },
  {
    id: 'reference-image-angle-and-space', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '![Chart][asset]\n\n[asset]: <../assets/chart (1).png>',
    catalog: [{ path: 'assets/chart (1).png' }], renamedTargetPath: 'assets/chart (2).png',
    expected: { parse: 'parsed', syntax: 'reference-definition', targetLiteral: '../assets/chart (1).png', resolve: 'resolved', targetPath: 'assets/chart (1).png', rewrite: 'rewrite', nextTargetLiteral: '../assets/chart (2).png' },
  },
  {
    id: 'inline-angle-title-space', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '[Plan](<./Plan 1.md#Outcome> "title")',
    catalog: [{ path: 'Projects/Plan 1.md' }], renamedTargetPath: 'Projects/Plan 2.md',
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: './Plan 1.md#Outcome', resolve: 'resolved', targetPath: 'Projects/Plan 1.md', rewrite: 'rewrite', nextTargetLiteral: './Plan 2.md#Outcome' },
  },
  {
    id: 'inline-balanced-parentheses', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '[Plan](./Plan(1).md)',
    catalog: [{ path: 'Projects/Plan(1).md' }], renamedTargetPath: 'Projects/Plan(2).md',
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: './Plan(1).md', resolve: 'resolved', targetPath: 'Projects/Plan(1).md', rewrite: 'rewrite', nextTargetLiteral: './Plan(2).md' },
  },
  {
    id: 'inline-percent-encoding', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '[Plan](./Plan%201.md#Section%20A)',
    catalog: [{ path: 'Projects/Plan 1.md' }], renamedTargetPath: 'Projects/Plan 2.md',
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: './Plan%201.md#Section%20A', resolve: 'resolved', targetPath: 'Projects/Plan 1.md', rewrite: 'rewrite', nextTargetLiteral: './Plan%202.md#Section%20A' },
  },
  {
    id: 'inline-escaped-parentheses', phase: 'planned',
    sourcePath: 'Projects/Overview.md', markdown: '[Plan](./Plan\\(1\\).md)',
    catalog: [{ path: 'Projects/Plan(1).md' }], renamedTargetPath: 'Projects/Plan(2).md',
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: './Plan\\(1\\).md', resolve: 'resolved', targetPath: 'Projects/Plan(1).md', rewrite: 'rewrite', nextTargetLiteral: './Plan\\(2\\).md' },
  },
  {
    id: 'inline-exact-relative-no-alias-fallback', phase: 'planned',
    sourcePath: 'Notes/Start.md', markdown: '[Wrong](../Target.md)',
    catalog: [{ path: 'Notes/Target.md' }],
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: '../Target.md', resolve: 'missing', targetPath: null, rewrite: 'blocked', nextTargetLiteral: null },
  },
  {
    id: 'workspace-root-path', phase: 'planned',
    sourcePath: 'Notes/Start.md', markdown: '[Shared](/Shared.md)',
    catalog: [{ path: 'Shared.md' }], renamedTargetPath: 'Archive/Shared.md',
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: '/Shared.md', resolve: 'resolved', targetPath: 'Shared.md', rewrite: 'rewrite', nextTargetLiteral: '/Archive/Shared.md' },
  },
  {
    id: 'outside-workspace', phase: 'planned',
    sourcePath: 'Notes/Start.md', markdown: '[Outside](../../Other.md)',
    catalog: [{ path: 'Other.md' }],
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: '../../Other.md', resolve: 'outside-workspace', targetPath: null, rewrite: 'blocked', nextTargetLiteral: null },
  },
  {
    id: 'pure-anchor', phase: 'planned',
    sourcePath: 'Notes/Start.md', markdown: '[Heading](#heading)', catalog: [],
    expected: { parse: 'ignored', syntax: null, targetLiteral: null, resolve: 'anchor-only', targetPath: null, rewrite: 'not-applicable', nextTargetLiteral: null },
  },
  {
    id: 'html-image-unevaluated', phase: 'planned',
    sourcePath: 'Notes/Start.md', markdown: '<img src="../assets/chart.png">',
    catalog: [{ path: 'assets/chart.png' }],
    expected: { parse: 'not-evaluated', syntax: null, targetLiteral: null, resolve: 'not-evaluated', targetPath: null, rewrite: 'not-applicable', nextTargetLiteral: null },
  },
  {
    id: 'oversize-markdown-source', phase: 'planned',
    sourcePath: 'Notes/Large.md', markdown: '[Plan](./Plan.md)',
    catalog: [{ path: 'Notes/Plan.md' }, { path: 'Notes/Large.md', sizeBytes: 4 * 1024 * 1024 + 1 }],
    expected: { parse: 'omitted', syntax: null, targetLiteral: null, resolve: 'omitted', targetPath: null, rewrite: 'blocked', nextTargetLiteral: null },
  },
  {
    id: 'unicode-offset', phase: 'planned',
    sourcePath: 'Notes/Start.md', markdown: '🙂 [A](./A.md)',
    catalog: [{ path: 'Notes/A.md' }], renamedTargetPath: 'Notes/B.md',
    expected: { parse: 'parsed', syntax: 'inline-link', targetLiteral: './A.md', resolve: 'resolved', targetPath: 'Notes/A.md', rewrite: 'rewrite', nextTargetLiteral: './B.md' },
  },
] as const;

export type WorkspaceFileOperationFixtureV1 = {
  id: string;
  kind: WorkspaceFileOperationKindV1;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  pathMappings: ReadonlyArray<readonly [string, string]>;
  markdownBefore: string;
  markdownAfter: string | null;
  expectedStatus: 'complete' | 'blocked' | 'needs_recovery';
  reason: string;
};

/** Fixed operation cases for FL-03 planning and FL-05 execution tests. */
export const WORKSPACE_OPERATION_CASES_V1: readonly WorkspaceFileOperationFixtureV1[] = [
  {
    id: 'target-rename-updates-incoming', kind: 'rename', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    pathMappings: [['Notes/Plan.md', 'Notes/Roadmap.md']],
    markdownBefore: '[Plan](./Plan.md)', markdownAfter: '[Plan](./Roadmap.md)',
    expectedStatus: 'complete', reason: 'Incoming exact-relative link follows target identity.',
  },
  {
    id: 'source-move-preserves-outgoing', kind: 'move', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    pathMappings: [['Notes/Start.md', 'Archive/Start.md']],
    markdownBefore: '[Plan](./Plan.md)', markdownAfter: '[Plan](../Notes/Plan.md)',
    expectedStatus: 'complete', reason: 'Moving a Markdown source recalculates relative outgoing paths.',
  },
  {
    id: 'directory-move-maps-internal-and-external', kind: 'move', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    pathMappings: [['Notes', 'Archive/Notes']],
    markdownBefore: '[Inside](./Plan.md) [Outside](../Shared.md)',
    markdownAfter: '[Inside](./Plan.md) [Outside](../../Shared.md)',
    expectedStatus: 'complete', reason: 'Internal identity stays inside moved directory; external relative path changes.',
  },
  {
    id: 'directory-copy-maps-internal-only', kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    pathMappings: [['Notes', 'Archive/Notes']],
    markdownBefore: '[Inside](./Plan.md) [Outside](../Shared.md)',
    markdownAfter: '[Inside](./Plan.md) [Outside](../../Shared.md)',
    expectedStatus: 'complete', reason: 'Original stays byte-identical; copied internal target is used.',
  },
  {
    id: 'copy-collision-uses-chosen-destination', kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    pathMappings: [['Notes', 'Archive/Notes (2)']],
    markdownBefore: '[Outside](../Shared.md)', markdownAfter: '[Outside](../../Shared.md)',
    expectedStatus: 'complete', reason: 'Resolved destination after collision determines relative link spelling.',
  },
  {
    id: 'cross-workspace-copy-external-unresolved', kind: 'copy', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w2',
    pathMappings: [['Notes/Start.md', 'Notes/Start.md']],
    markdownBefore: '[Outside](../Shared.md)', markdownAfter: null,
    expectedStatus: 'blocked', reason: 'Uncopied source-workspace target cannot bind by name in destination.',
  },
  {
    id: 'large-overwrite-requires-recovery', kind: 'overwrite', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    pathMappings: [['Notes/Large.md', 'Notes/Large.md']],
    markdownBefore: '[Plan](./Plan.md)', markdownAfter: null,
    expectedStatus: 'blocked', reason: 'Over 1 MiB version limit requires separate durable recovery.',
  },
] as const;
