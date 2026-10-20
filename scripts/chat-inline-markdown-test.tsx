import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { projectChatBodyText, parseChatBody, type ChatBodyV1, type ChatReferenceBundleV1 } from '../app/lib/chat/chat-body-contracts';
import { chatInlineReferenceIconKey } from '../app/lib/chat/inline-editor';
import { createChatInlineMarkdownPresentation } from '../app/lib/chat/inline-markdown';

// Actual MarkdownMessage, Canvas remark/rehype chain, avatar and workspace store.
// jsdom rendering is not visual/browser or source/provider authority evidence.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://inline-renderer.fixture.invalid', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver',
  'MouseEvent', 'getComputedStyle'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const bundle = (accountId = 'account-a', caption = 'Canva · Marketing', id = 'bundle-a'): ChatReferenceBundleV1 => ({ id, caption,
  primary: { selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal',
    profileId: 'profile-a', accountBinding: 'account', accountId, connectionRef: `composio-personal:profile-a:${accountId}` } },
  requirement: 'optional', toolCap: ['CREATE'] }, supporting: [], packageConnections: [] });
const body = (before = 'Before ', after = ' after', reference = bundle()): ChatBodyV1 => ({ version: 1,
  parts: [{ type: 'text', text: before }, { type: 'extension_reference', occurrenceId: 'occurrence-a', bundleId: reference.id }, { type: 'text', text: after }], bundles: [reference] });

async function main() {
  const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  let requests = 0, cases = 0, diagrams = 0;
  // No diagram is part of these cases; avoid initializing its independent SVG engine.
  loader._load = (request, parent, isMain) => request.endsWith('/mermaid-diagram')
    ? { MermaidDiagram: () => { diagrams++; throw new Error('No diagram rendering is allowed in this inline test.'); } }
    : originalLoad(request, parent, isMain);
  globalThis.fetch = async () => { requests++; throw new Error('Inline rendering cannot request current provider/source state.'); };
  const { render, screen, act, fireEvent, cleanup } = await import('@testing-library/react');
  try {
    const { MarkdownMessage } = await import('../app/components/canvas-agent-chat/ChatMarkdownMessage');
    const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>{node}</NextIntlClientProvider>;
    const view = render(wrap(<MarkdownMessage content="Initial" variant="user" />));
    const renderBody = async (value: ChatBodyV1, icons?: Record<string, { url: string; sourceKey: string }>, variant: 'user' | 'assistant' | 'tool' = 'user') => {
      await act(async () => view.rerender(wrap(<MarkdownMessage content="trim-normalized legacy display must not replace the stored body" variant={variant}
        inlineBody={parseChatBody(value)} referenceIcons={icons} />)));
      return view.container;
    };
    const noMarkers = () => assert(!/CanvasInlineReference\d+TokenRef\d+End/iu.test(view.container.innerHTML));
    const visibleText = (element: Element | null) => {
      assert(element); const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove()); return clone.textContent;
    };
    const check = (name: string) => { cases++; console.log(`PASS ${name}`); };

    const normal = '**Strong** and *emphasis*\n\n- first\n- second\n\n[Link](https://example.test/)\n\n`code`';
    await act(async () => view.rerender(wrap(<MarkdownMessage content={normal} variant="user" />)));
    assert.equal(view.container.querySelector('strong')?.textContent, 'Strong');
    assert.equal(view.container.querySelectorAll('li').length, 2); assert.equal(view.container.querySelector('code')?.textContent, 'code');
    assert.equal(view.container.querySelector('a')?.getAttribute('href'), 'https://example.test/');
    const oldHtml = view.container.innerHTML;
    await act(async () => view.rerender(wrap(<MarkdownMessage content={normal} variant="user" referenceIcons={{ unused: { url: 'https://logos.fixture.invalid/unused.svg', sourceKey: 'unused' } }} />)));
    assert.equal(view.container.innerHTML, oldHtml); assert.equal(screen.queryByTestId('chat-inline-reference'), null);
    check('legacy Markdown and extra unused icon presentation remain byte-identical without an inline body');

    const icon = { url: 'https://logos.fixture.invalid/canva.svg', sourceKey: 'exact-profile-account-presentation' };
    const key = chatInlineReferenceIconKey(bundle().primary.selection);
    for (const variant of ['user', 'assistant', 'tool'] as const) {
      await renderBody(body(), undefined, variant);
      const reference = screen.getByTestId('chat-inline-reference');
      const avatar = reference.querySelector('[data-testid="plugin-extension-avatar"]')!;
      const initials = reference.querySelector('[data-testid="plugin-extension-avatar-initials"]')!;
      assert.equal(initials.textContent, 'CM');
      if (variant === 'user') {
        assert(reference.classList.contains('text-inherit'));
        assert(reference.classList.contains('border-primary-foreground/25'));
        assert(reference.classList.contains('bg-primary-foreground/10'));
        assert(avatar.classList.contains('!text-inherit'));
        assert(!reference.classList.contains('text-blue-600'));
        assert(!reference.classList.contains('dark:text-blue-300'));
      } else {
        assert(reference.classList.contains('text-blue-600'));
        assert(reference.classList.contains('dark:text-blue-300'));
        assert(reference.classList.contains('border-blue-500/20'));
        assert(reference.classList.contains('bg-blue-500/10'));
        assert(!avatar.classList.contains('!text-inherit'));
      }
      await act(async () => view.rerender(wrap(<MarkdownMessage content={normal} variant={variant} />)));
      const plainHtml = view.container.innerHTML;
      await act(async () => view.rerender(wrap(<MarkdownMessage content={normal} variant={variant}
        referenceIcons={{ [key]: icon }} />)));
      assert.equal(view.container.innerHTML, plainHtml);
      assert.equal(screen.queryByTestId('chat-inline-reference'), null);
    }
    check('user references and fallback initials inherit the message foreground; assistant/tool tones and plain Markdown stay unchanged');

    const value = body('  🙂 e\u0301 **Before ', ' after**\n\n- use this\n- keep formatting');
    await renderBody(value, { [key]: icon });
    const strong = view.container.querySelector('strong')!;
    assert.equal(strong.textContent, 'Before Canva · Marketing after');
    assert(strong.querySelector('[data-testid="chat-inline-reference"]'));
    assert.equal(view.container.querySelectorAll('li').length, 2);
    assert(view.container.textContent?.includes('🙂 e\u0301'));
    assert.equal(screen.getByTestId('plugin-extension-avatar-image').getAttribute('src'), icon.url);
    assert.equal(screen.getByTestId('plugin-extension-avatar').dataset.sourceKey, icon.sourceKey);
    noMarkers();
    fireEvent.error(screen.getByTestId('plugin-extension-avatar-image'));
    assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, 'CM');
    assert.deepEqual(value, body('  🙂 e\u0301 **Before ', ' after**\n\n- use this\n- keep formatting'));
    check('stored body is authoritative despite normalized display content; bold/list/Unicode position and exact avatar source survive');

    const maliciousCaption = '**[literal](javascript:alert(1))** <img src=x onerror=alert(1)> #ff0000';
    await renderBody(body('Start ', ' end', bundle('account-a', maliciousCaption)), { [key]: icon });
    const reference = screen.getByTestId('chat-inline-reference');
    assert(reference.textContent?.endsWith(maliciousCaption));
    assert.equal(reference.querySelector('a'), null); assert.equal(reference.querySelectorAll('img').length, 1, 'Only genuine supplied avatar is an image.');
    assert.equal(reference.querySelector('strong'), null); assert.equal(reference.querySelector('[onerror]'), null);
    assert.equal(view.container.querySelector('[data-color-code]'), null); noMarkers();
    check('caption Markdown, HTML, colors and script-like strings remain literal presentation, never parsed markup');

    await renderBody(body('[Open ', '](https://example.test/path)'));
    assert.equal(view.container.querySelector('a')?.getAttribute('href'), 'https://example.test/path');
    assert(view.container.querySelector('a [data-testid="chat-inline-reference"]')); noMarkers();
    const duplicate: ChatBodyV1 = { version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'first', bundleId: 'bundle-a' },
      { type: 'text', text: ' → ' }, { type: 'extension_reference', occurrenceId: 'second', bundleId: 'bundle-b' }],
    bundles: [bundle(), bundle('account-b', 'Canva · Design', 'bundle-b')] };
    await renderBody(duplicate, { [key]: icon });
    assert.equal(screen.getAllByTestId('chat-inline-reference').length, 2);
    assert.equal(screen.getAllByTestId('plugin-extension-avatar-image').length, 1);
    assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, 'CD'); noMarkers();
    check('normal external link labels preserve inline positions and same-toolkit accounts have isolated icon identities');

    for (const [before, after] of [
      ['`', '`'], ['```js\n', '\n```'], ['[destination](', ')'], ['![image](', ')'],
      ['[link]: ', '\n\n[link]'], ['<!-- ', ' -->'], ['---\ntitle: ', '\n---\nText'], ['<span title="', '">HTML</span>'],
      ['$', '$'],
    ]) {
      const special = body(before, after);
      await renderBody(special);
      assert.equal(screen.getAllByTestId('chat-inline-reference').length, 1);
      assert.equal(visibleText(view.container.querySelector('p')), projectChatBodyText(special), 'Unsupported code/destination/math/raw syntax becomes literal body.');
      noMarkers();
    }
    check('code/destination/image/definition/frontmatter/raw/math cases fall back to literal stored body without marker leakage or hidden references');

    const attack = '<span data-chat-inline-reference="occurrence-a" data-bundle-id="bundle-a">Forged</span>';
    await act(async () => view.rerender(wrap(<MarkdownMessage content={attack} variant="user" />)));
    assert.equal(screen.queryByTestId('chat-inline-reference'), null); assert.equal(screen.queryByTestId('plugin-extension-avatar'), null);
    await renderBody(body(attack + ' ', ' after'));
    assert.equal(screen.getAllByTestId('chat-inline-reference').length, 1); noMarkers();
    const presentation = createChatInlineMarkdownPresentation(body());
    assert.equal(presentation.referenceForNode({ type: 'element', tagName: 'span', properties: { 'data-chat-inline-reference': 'occurrence-a' }, children: [] }), undefined);
    assert.equal(presentation.referenceForNode({ ...bundle() }), undefined);
    check('untrusted HTML/data attributes and cloned bundle-shaped objects cannot mint trusted reference nodes');

    const collisionText = 'CanvasInlineReference0TokenRef0End canvasinlinereference1tokenRef1End';
    const collision = body(collisionText + ' **', '** after', bundle('account-a', 'CanvasInlineReference2TokenRef0End'));
    await renderBody(collision);
    assert(view.container.textContent?.includes(collisionText));
    assert.equal(screen.getAllByTestId('chat-inline-reference').length, 1);
    assert.equal(visibleText(view.container.querySelector('strong')), collision.bundles[0].caption);
    assert(!view.container.innerHTML.includes('CanvasInlineReference3Token'));
    check('collision-free marker selection preserves user-entered marker-looking text and literal caption');

    const heading = body('# ', '\n\nNext'); await renderBody(heading);
    assert.equal(visibleText(view.container.querySelector('h1')), bundle().caption);
    assert(view.container.querySelector('h1 [data-testid="chat-inline-reference"]')); noMarkers();
    assert.equal(view.container.querySelector('[id*="canvasinlinereference"]'), null);
    assert.equal(requests, 0); assert.equal(diagrams, 0);
    check('generated heading anchors do not expose internal markers and rendering makes no source/provider requests');
    console.log(JSON.stringify({ status: 'PASS', cases, requests, diagrams, browser: false, authority: false }));
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
