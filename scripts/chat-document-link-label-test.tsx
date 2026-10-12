import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'React', { value: React, configurable: true });

const opened: string[] = [];
let unexpectedFetches = 0;
globalThis.fetch = async () => {
  unexpectedFetches++;
  throw new Error('Document link rendering must not contact a provider or server in this test');
};

type WikiLinkProps = {
  children: React.ReactNode;
  target: string;
  sourcePath?: string;
  onOpenFile?: (path: string) => Promise<void> | void;
};
const modules = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = modules._load;
modules._load = (request, parent, isMain) => {
  if (request.endsWith('/useOpenChatFileReference')) {
    return { useOpenChatFileReference: () => async (path: string) => { opened.push(path); } };
  }
  if (request.endsWith('/useChatFileReferenceValidation')) {
    return {
      useChatFileReferenceValidation: (path: string) => ({
        results: new Map([[path, { path, type: 'file' }]]),
      }),
    };
  }
  if (request.endsWith('/workspace-store')) {
    return { useWorkspaceStore: (selector: (state: { activeWorkspaceId: string }) => unknown) => selector({ activeWorkspaceId: 'workspace-test' }) };
  }
  if (request.endsWith('/ObsidianWikiLink')) {
    return {
      ObsidianWikiLink: ({ children, target, sourcePath, onOpenFile }: WikiLinkProps) => (
        <button
          type="button"
          data-testid="wiki-link"
          data-target={target}
          data-source-path={sourcePath}
          onClick={() => void onOpenFile?.(target)}
        >
          {children}
        </button>
      ),
    };
  }
  if (request.endsWith('/WorkspaceMarkdownEmbed')) {
    return {
      WorkspaceMarkdownEmbed: ({ renderContent }: {
        renderContent: (content: string, sourcePath: string, ancestors: string[]) => React.ReactNode;
      }) => renderContent('[`test.md`](test.md)', 'embedded.md', ['embedded.md']),
    };
  }
  if (request.endsWith('/ClipboardCopyButton')) return { ClipboardCopyButton: () => null };
  if (request.endsWith('/SafeMarkdownImage')) return { SafeMarkdownImage: () => <span data-testid="image" /> };
  if (request.endsWith('/mermaid-diagram')) return { MermaidDiagram: () => null };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { getChatDocumentLinkLabel } = await import('../app/lib/chat/document-link-label');
  const { MarkdownMessage } = await import('../app/components/canvas-agent-chat/ChatMarkdownMessage');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);

  try {
    assert.equal(getChatDocumentLinkLabel('notizen/test.md', 'notizen/test.md'), 'Test');
    assert.equal(getChatDocumentLinkLabel('notizen/test.md', 'test'), 'Test');
    assert.equal(getChatDocumentLinkLabel('notizen/überblick.markdown', 'überblick.markdown'), 'Überblick');
    assert.equal(getChatDocumentLinkLabel('notizen/API.mdx', 'API.mdx'), 'API');
    assert.equal(getChatDocumentLinkLabel('notizen/mein%20test.md', 'mein test.md'), 'Mein test');
    assert.equal(getChatDocumentLinkLabel('test', 'test', { allowExtensionless: true }), 'Test');
    assert.equal(getChatDocumentLinkLabel('notizen/test.md', 'Projektplan'), null);
    assert.equal(getChatDocumentLinkLabel('test.pdf', 'test.pdf'), null);
    assert.equal(getChatDocumentLinkLabel('https://example.com/test.md', 'test.md'), null);

    const render = async (
      content: string,
      variant: 'assistant' | 'user' | 'tool' = 'assistant',
      sourcePath?: string,
    ) => {
      await act(async () => root.render(<MarkdownMessage content={content} variant={variant} sourcePath={sourcePath} />));
    };
    const fileButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-chat-file-reference]')];
    const wikiButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="wiki-link"]')];

    await render([
      '[test.md](test.md)',
      '[notizen/test.md](notizen/test.md)',
      '[`test.md`](notizen/test.md)',
      '[**test.md**](notizen/test.md)',
      '[*test.md*](notizen/test.md)',
      '[~~test.md~~](notizen/test.md)',
      '[**test**.md](notizen/test.md)',
      '[überblick.markdown](notizen/überblick.markdown)',
      '[API.mdx](notizen/API.mdx)',
      '[test](notizen/test.md)',
    ].join('\n\n'));
    assert.deepEqual(fileButtons().map((button) => button.textContent), [
      'Test', 'Test', 'Test', 'Test', 'Test', 'Test', 'Test', 'Überblick', 'API', 'Test',
    ], 'assistant filename links use document names for all text-only Markdown formatting');
    assert.equal(fileButtons()[2].querySelector('code'), null, 'a filename link is rendered as a plain readable label');
    assert.equal(fileButtons()[3].querySelector('strong'), null);
    assert.equal(fileButtons()[4].querySelector('em'), null);
    assert.equal(fileButtons()[1].getAttribute('title'), 'Open notizen/test.md', 'the full target remains available in the tooltip');
    await act(async () => fileButtons()[1].click());
    assert.deepEqual(opened, ['notizen/test.md'], 'friendly labels do not alter the file opened');

    await render('[Projektplan](notizen/test.md)\n\n[**Projektplan**](notizen/test.md)\n\n[`Projektplan`](notizen/test.md)\n\n[other.md](notizen/test.md)');
    assert.deepEqual(fileButtons().map((button) => button.textContent), ['Projektplan', 'Projektplan', 'Projektplan', 'other.md']);
    assert.ok(fileButtons()[1].querySelector('strong'), 'custom descriptive formatting is preserved');
    assert.ok(fileButtons()[2].querySelector('code'), 'custom descriptive code formatting is preserved');

    await render('[![test.md](image.png)](test.md)');
    assert.ok(fileButtons()[0].querySelector('[data-testid="image"]'), 'non-text link content remains intact');

    await render('[test.pdf](test.pdf)\n\n[notizen/test.pdf](notizen/test.pdf)\n\n[`test.md`](https://example.com/test.md)');
    assert.deepEqual(fileButtons().map((button) => button.textContent), ['test.pdf', 'notizen/test.pdf']);
    const external = document.querySelector<HTMLAnchorElement>('a[href="https://example.com/test.md"]');
    assert.ok(external);
    assert.equal(external.textContent, 'test.md');
    assert.ok(external.querySelector('code'), 'external link presentation is unchanged');

    for (const variant of ['user', 'tool'] as const) {
      await render('[test.md](test.md)\n\n[notizen/test.md](notizen/test.md)\n\n[`test.md`](test.md)', variant);
      assert.deepEqual(fileButtons().map((button) => button.textContent), ['test', 'notizen/test', 'test.md'], `${variant} links retain their existing display behavior`);
      assert.ok(fileButtons()[2].querySelector('code'));
    }

    await render('[test.md](test.md)\n\n[`test.md`](test.md)', 'assistant', 'embedded.md');
    assert.deepEqual(fileButtons().map((button) => button.textContent), ['test', 'test.md'], 'embedded document content retains its own link labels');
    assert.ok(fileButtons()[1].querySelector('code'));

    await render('[[notizen/test.md]]\n\n[[notizen/test]]\n\n[[notizen/test.md|test.md]]\n\n[[notizen/test.md|test]]\n\n[[notizen/test.md|Projektplan]]\n\n[[test]]');
    assert.deepEqual(wikiButtons().map((button) => button.textContent), ['Test', 'Test', 'test.md', 'test', 'Projektplan', 'Test'], 'default wiki labels are friendly while every explicit alias is respected');
    assert.deepEqual(wikiButtons().map((button) => button.getAttribute('data-target')), [
      'notizen/test.md', 'notizen/test', 'notizen/test.md', 'notizen/test.md', 'notizen/test.md', 'test',
    ], 'wiki link targets are passed through unchanged');
    await act(async () => wikiButtons()[0].click());
    assert.deepEqual(opened, ['notizen/test.md', 'notizen/test.md']);

    await render('[[notizen/test.md]]', 'user');
    assert.equal(wikiButtons()[0].textContent, 'test');
    await render('[[notizen/test.md]]', 'assistant', 'embedded.md');
    assert.equal(wikiButtons()[0].textContent, 'test');
    assert.equal(wikiButtons()[0].getAttribute('data-source-path'), 'embedded.md');

    await render('![[embedded.md]]');
    assert.equal(fileButtons()[0].textContent, 'test.md', 'transcluded Markdown keeps source document labels');
    assert.ok(fileButtons()[0].querySelector('code'));

    await render('```markdown\n[test.md](test.md)\n[[notizen/test.md]]\n```');
    assert.equal(fileButtons().length, 0);
    assert.equal(wikiButtons().length, 0);
    assert.match(document.querySelector('pre')?.textContent ?? '', /\[test\.md\]\(test\.md\)/u);

    await render('[mein test.md](notizen/mein%20test.md)\n\n[überblick.md](notizen/%C3%BCberblick.md)');
    assert.deepEqual(fileButtons().map((button) => button.textContent), ['Mein test', 'Überblick']);
    await act(async () => fileButtons()[0].click());
    assert.equal(opened.at(-1), 'notizen/mein%20test.md', 'display decoding leaves the original click target intact');
    assert.equal(unexpectedFetches, 0);
    console.log('chat-document-link-label-test: helper and rendered Markdown regressions passed');
  } finally {
    await act(async () => root.unmount());
    modules._load = originalLoad;
    dom.window.close();
  }
}

void main();
