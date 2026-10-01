import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  MarkdownModeViewport,
  type MarkdownViewportAdapter,
  type MarkdownViewportAnchor,
  type MarkdownViewportMode,
} from '../app/lib/editor/markdown-mode-viewport';

/** Controller tests deliberately exclude browser geometry. Each view can
 * report a different visible line boundary for the same successfully restored
 * text; the handoff must remain stable until the user or document changes. */
function fakeView(mode: MarkdownViewportMode, sourceOffset: number, asynchronous = false) {
  const surface = Object.assign(new EventTarget(), {
    style: { visibility: '' }, scrollTop: 500, clientWidth: 640,
  });
  const element = surface as unknown as HTMLElement;
  const captured: MarkdownViewportAnchor[] = [];
  const restored: MarkdownViewportAnchor[] = [];
  const state = { sourceOffset, viewportOffset: 12, version: {} as unknown };
  let complete: ((updated?: MarkdownViewportAnchor) => void) | undefined;
  let current: (() => boolean) | undefined;
  const adapter: MarkdownViewportAdapter = {
    key: {}, mode, element, content: element, version: () => state.version,
    capture() {
      const anchor = { sourceOffset: state.sourceOffset, viewportOffset: state.viewportOffset };
      captured.push(anchor);
      return anchor;
    },
    restore(anchor, done, isCurrent) {
      restored.push({ ...anchor });
      current = isCurrent;
      complete = updated => {
        if (!isCurrent()) return;
        surface.scrollTop = 700 + (updated ?? anchor).sourceOffset;
        done(updated);
      };
      if (!asynchronous) complete();
    },
  };
  return { adapter, state, surface, captured, restored,
    finish: (updated?: MarkdownViewportAnchor) => complete?.(updated),
    restorationIsCurrent: () => current?.() ?? false };
}

function harness(context: TestContext) {
  const controller = new MarkdownModeViewport();
  const detachments: (() => void)[] = [];
  context.after(() => { for (const detach of detachments.toReversed()) detach(); });
  return { controller, attach(view: ReturnType<typeof fakeView>) {
    const detach = controller.attach(view.adapter);
    detachments.push(detach);
    return detach;
  } };
}

test('rapid return from an unfinished Source handoff keeps the original text anchor', context => {
  const { controller, attach } = harness(context);
  const reading = fakeView('read', 100);
  const detachReading = attach(reading);
  controller.prepare('source'); detachReading();
  const source = fakeView('source', 0, true);
  const detachSource = attach(source);
  assert.equal(source.restored[0].sourceOffset, 100);

  controller.prepare('read'); detachSource();
  assert.equal(source.restorationIsCurrent(), false);
  const destination = fakeView('read', 0);
  attach(destination);
  assert.equal(destination.restored[0].sourceOffset, 100);
  assert.equal(source.captured.length, 0, 'an unfinished intermediate Source view must not supply a new position');
  source.finish({ sourceOffset: 0, viewportOffset: 0 });
  assert.equal(destination.restored.length, 1, 'obsolete completion must not restart the destination handoff');
});

test('requesting the same Source mode does not cancel an unfinished handoff', context => {
  const { controller, attach } = harness(context);
  const detachReading = attach(fakeView('read', 100));
  controller.prepare('source'); detachReading();
  const source = fakeView('source', 0, true);
  const detachSource = attach(source);

  controller.prepare('source');
  assert.equal(source.restorationIsCurrent(), true);
  assert.equal(source.restored.length, 1);
  source.finish();
  assert.equal(source.surface.style.visibility, '');
  controller.prepare('rich'); detachSource();
  const destination = fakeView('rich', 900);
  attach(destination);
  assert.equal(destination.restored[0].sourceOffset, 100);
});

test('unchanged consecutive views retain one anchor despite differing visible line starts', context => {
  const { controller, attach } = harness(context);
  const reading = fakeView('read', 987);
  let detach = attach(reading);
  for (const [index, mode] of (['rich', 'source', 'read', 'source', 'rich', 'read'] as const).entries()) {
    controller.prepare(mode); detach();
    const destination = fakeView(mode, 900 - index * 11);
    detach = attach(destination);
    assert.deepEqual(destination.restored, [{ sourceOffset: 987, viewportOffset: 12 }]);
    assert.equal(destination.captured.length, 0, 'successful unchanged views reuse the transferred text position');
  }
  assert.equal(reading.captured.length, 1);
});

test('scroll changes replace a successful handoff with a fresh visible position', context => {
  const { controller, attach } = harness(context);
  const detachReading = attach(fakeView('read', 100));
  controller.prepare('source'); detachReading();
  const source = fakeView('source', 150);
  const detachSource = attach(source);
  source.state.sourceOffset = 250;
  source.surface.scrollTop += 180;

  controller.prepare('read'); detachSource();
  const destination = fakeView('read', 0);
  attach(destination);
  assert.equal(destination.restored[0].sourceOffset, 250);
  assert.equal(source.captured.length, 1);
});

test('document version changes force a fresh capture even without scrolling', context => {
  const { controller, attach } = harness(context);
  const detachReading = attach(fakeView('read', 100));
  controller.prepare('rich'); detachReading();
  const rich = fakeView('rich', 150);
  const detachRich = attach(rich);
  rich.state.sourceOffset = 275;
  rich.state.version = {};

  controller.prepare('source'); detachRich();
  const destination = fakeView('source', 0);
  attach(destination);
  assert.equal(destination.restored[0].sourceOffset, 275);
  assert.equal(rich.captured.length, 1);
});

test('changed line-wrapping width forces a fresh visible position', context => {
  const { controller, attach } = harness(context);
  const detachReading = attach(fakeView('read', 100));
  controller.prepare('rich'); detachReading();
  const rich = fakeView('rich', 320);
  const detachRich = attach(rich);
  rich.surface.clientWidth = 390;

  controller.prepare('read'); detachRich();
  const destination = fakeView('read', 0);
  attach(destination);
  assert.equal(destination.restored[0].sourceOffset, 320);
  assert.equal(rich.captured.length, 1);
});

test('mapped source updates become the anchor for the next unchanged handoff', context => {
  const { controller, attach } = harness(context);
  const detachReading = attach(fakeView('read', 100));
  controller.prepare('source'); detachReading();
  const source = fakeView('source', 0, true);
  const detachSource = attach(source);
  source.state.version = {};
  source.finish({ sourceOffset: 140, viewportOffset: 12 });

  controller.prepare('read'); detachSource();
  const destination = fakeView('read', 0);
  attach(destination);
  assert.equal(destination.restored[0].sourceOffset, 140);
  assert.equal(source.captured.length, 0);
});

test('explicit navigation invalidates an unchanged handoff and old requests are not replayed', context => {
  const { controller, attach } = harness(context);
  const detachReading = attach(fakeView('read', 100));
  controller.prepare('source'); detachReading();
  const source = fakeView('source', 450);
  const detachSource = attach(source);
  assert.equal(controller.claimNavigation('heading-request'), true);
  assert.equal(controller.claimNavigation('heading-request'), false);

  controller.prepare('read'); detachSource();
  const destination = fakeView('read', 0);
  attach(destination);
  assert.equal(destination.restored[0].sourceOffset, 450);
});
