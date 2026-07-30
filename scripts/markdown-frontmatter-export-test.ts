import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { JSDOM } from 'jsdom';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

type MarkdownToHtmlModule = typeof import('../app/lib/pdf/markdown-to-html');

async function importMarkdownToHtml(): Promise<MarkdownToHtmlModule> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/pdf/markdown-to-html');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-frontmatter-export-'));
  const workspace: WorkspaceContext = {
    workspaceId: 'frontmatter-export-test',
    workspaceType: 'personal',
    rootPath,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };

  try {
    await fs.writeFile(path.join(rootPath, 'report.md'), `---
title: Hidden report metadata
tags:
  - type/report
  - status/final
aliases:
  - Internal report alias
---

# Visible report

Only this document body belongs in the export.
`);

    const { markdownFileToHtmlDocument, markdownTextToHtmlDocument } = await importMarkdownToHtml();
    const html = await markdownFileToHtmlDocument('report.md', { workspace });
    const document = new JSDOM(html).window.document;
    const text = document.body.textContent || '';

    assert.match(text, /Visible report/);
    assert.match(text, /Only this document body belongs in the export/);
    assert.doesNotMatch(
      text,
      /Hidden report metadata|type\/report|status\/final|Internal report alias/,
    );
    assert.equal(document.querySelector('body > hr'), null);
    assert.equal(document.body.firstElementChild?.tagName, 'H1');
    assert.match(html, /body\s*\{[\s\S]*?padding:\s*0;/u);
    assert.match(
      html,
      /body\s*>\s*:first-child,[\s\S]*?\.canvas-brand-header\s*\+\s*\*\s*\{[\s\S]*?margin-top:\s*0;/u,
    );

    await fs.mkdir(path.join(rootPath, 'notes', 'assets'), { recursive: true });
    await fs.writeFile(
      path.join(rootPath, 'notes', 'assets', 'chart.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#2563eb"/></svg>',
      'utf8',
    );
    const inlineHtml = await markdownTextToHtmlDocument(`# Inline report

![Inline chart](assets/chart.svg)
`, {
      title: 'Inline export',
      assetBasePath: 'notes',
      fileOptions: { workspace },
    });
    const inlineDocument = new JSDOM(inlineHtml).window.document;
    assert.equal(inlineDocument.title, 'Inline export');
    assert.equal(inlineDocument.querySelector('h1')?.textContent, 'Inline report');
    assert.match(inlineDocument.querySelector('img')?.getAttribute('src') || '', /^data:image\/svg\+xml;base64,/u);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }

  console.log('markdown frontmatter export tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
