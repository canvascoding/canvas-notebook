import 'server-only';

import type { ElementHandle, Page } from 'puppeteer-core';

import type { BrowserGatewayInput, BrowserObservation, ObservedTarget } from './types';

const OBSERVE_TARGETS_SOURCE = String.raw`
  const attrSelector = (name, value) => {
    return '[' + name + '="' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
  };

  const selectorCandidates = (el) => {
    const htmlEl = el;
    const candidates = [];
    const testId = htmlEl.dataset && htmlEl.dataset.testid ? htmlEl.dataset.testid : htmlEl.getAttribute('data-testid');
    if (testId) candidates.push(attrSelector('data-testid', testId));
    if (htmlEl.id) candidates.push('#' + CSS.escape(htmlEl.id));
    const name = htmlEl.getAttribute('name');
    if (name) candidates.push(htmlEl.tagName.toLowerCase() + attrSelector('name', name));
    const aria = htmlEl.getAttribute('aria-label');
    if (aria) candidates.push(htmlEl.tagName.toLowerCase() + attrSelector('aria-label', aria));
    if (htmlEl instanceof HTMLAnchorElement && htmlEl.href) {
      candidates.push('a' + attrSelector('href', htmlEl.getAttribute('href') || htmlEl.href));
    }

    const pathParts = [];
    let current = el;
    while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName.toLowerCase() === tag) index += 1;
        sibling = sibling.previousElementSibling;
      }
      pathParts.unshift(tag + ':nth-of-type(' + index + ')');
      current = current.parentElement;
    }
    if (pathParts.length > 0) {
      candidates.push('body > ' + pathParts.join(' > '));
    }
    return candidates.filter(function (value, index, array) {
      return array.indexOf(value) === index;
  });
  };

  const isVisible = function (el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };

  const textFor = function (el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return el.value || el.placeholder || null;
    }
    return (el.textContent && el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)) || null;
  };

  const referencedText = function (el, attrName) {
    const ids = (el.getAttribute(attrName) || '').split(/\s+/).filter(Boolean);
    const parts = ids
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean)
      .map(function (item) { return item.textContent && item.textContent.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
    return parts.length > 0 ? parts.join(' ').slice(0, 160) : null;
  };

  const labelTextFor = function (el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const labels = Array.from(el.labels || []);
      const text = labels
        .map(function (label) { return label.textContent && label.textContent.replace(/\s+/g, ' ').trim(); })
        .filter(Boolean)
        .join(' ');
      if (text) return text.slice(0, 160);
    }
    return null;
  };

  const nameFor = function (el) {
    const htmlEl = el;
    return htmlEl.getAttribute('aria-label')
      || referencedText(htmlEl, 'aria-labelledby')
      || labelTextFor(el)
      || htmlEl.getAttribute('title')
      || htmlEl.getAttribute('alt')
      || htmlEl.getAttribute('placeholder')
      || textFor(el);
  };

  const elements = Array.from(document.querySelectorAll(
    'a[href], button, input, textarea, select, summary, [contenteditable="true"], [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])',
  )).filter(isVisible).slice(0, maxTargets);

  const targets = elements.map(function (el, index) {
    const htmlEl = el;
    const rect = el.getBoundingClientRect();
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? el.value
      : null;
    return {
      targetId: 't' + (index + 1),
      tag: htmlEl.tagName.toLowerCase(),
      role: htmlEl.getAttribute('role'),
      name: nameFor(el),
      text: textFor(el),
      ariaLabel: htmlEl.getAttribute('aria-label'),
      placeholder: htmlEl.getAttribute('placeholder'),
      href: el instanceof HTMLAnchorElement ? el.href : null,
      value,
      testId: htmlEl.dataset && htmlEl.dataset.testid ? htmlEl.dataset.testid : htmlEl.getAttribute('data-testid'),
      type: htmlEl.getAttribute('type'),
      disabled: Boolean(htmlEl.disabled || htmlEl.getAttribute('aria-disabled') === 'true'),
      checked: el instanceof HTMLInputElement ? el.checked : htmlEl.getAttribute('aria-checked') === null ? null : htmlEl.getAttribute('aria-checked') === 'true',
      selected: el instanceof HTMLOptionElement ? el.selected : htmlEl.getAttribute('aria-selected') === null ? null : htmlEl.getAttribute('aria-selected') === 'true',
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      candidates: selectorCandidates(el),
    };
  });

  return {
    title: document.title,
    url: window.location.href,
    targets,
  };
`;

export class BrowserTargetStore {
  private targets = new Map<string, ObservedTarget>();

  replace(observation: BrowserObservation): void {
    this.targets = new Map(observation.targets.map((target) => [target.targetId, target]));
  }

  clear(): void {
    this.targets = new Map();
  }

  get(targetId: string): ObservedTarget | undefined {
    return this.targets.get(targetId);
  }
}

export async function observeInteractiveTargets(page: Page, limit: number): Promise<BrowserObservation> {
  const observed = await page.evaluate(
    (maxTargets, source) => {
      const run = new Function('maxTargets', source);
      return run(maxTargets);
    },
    limit,
    OBSERVE_TARGETS_SOURCE,
  );

  return observed;
}

async function isHandleVisible(handle: ElementHandle<Element>): Promise<boolean> {
  return handle.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
}

async function findUniqueVisibleHandle(page: Page, selectors: string[]): Promise<ElementHandle<Element>> {
  for (const selector of selectors) {
    const handles = await page.$$(selector);
    const visible: ElementHandle<Element>[] = [];

    for (const handle of handles) {
      if (await isHandleVisible(handle).catch(() => false)) {
        visible.push(handle);
      } else {
        await handle.dispose().catch(() => undefined);
      }
    }

    if (visible.length === 1) {
      return visible[0];
    }

    for (const handle of visible) {
      await handle.dispose().catch(() => undefined);
    }
  }

  throw new Error('No unique visible element matched. Run observe again and use a current target_id.');
}

export async function resolveTargetHandle(
  page: Page,
  input: BrowserGatewayInput,
  targetStore: BrowserTargetStore,
): Promise<ElementHandle<Element>> {
  const targetId = input.target_id?.trim();
  const selector = input.selector?.trim();

  if (targetId) {
    const target = targetStore.get(targetId);
    if (!target) {
      throw new Error(`Unknown target_id "${targetId}". Run observe before interacting.`);
    }
    return findUniqueVisibleHandle(page, target.candidates);
  }

  if (selector) {
    return findUniqueVisibleHandle(page, [selector]);
  }

  throw new Error('target_id or selector is required for this browser action.');
}
