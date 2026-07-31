import type { BrowserSessionSnapshot } from './types';

export function buildBrowserRuntimeContextBlock(
  snapshot: BrowserSessionSnapshot | null | undefined,
): string | null {
  if (!snapshot?.running) {
    return null;
  }

  const lines = [
    '## Active Browser Session',
    'A browser session is running for this chat. Its URLs are compacted and omit query strings, fragments, and credentials.',
    `Control mode: ${snapshot.controlMode}`,
  ];

  if (snapshot.controlMode === 'user') {
    lines.push('The user currently controls the browser. Do not run interactive browser actions until control returns to the agent.');
  } else if (snapshot.controlMode === 'view') {
    lines.push('The browser is visible in read-only mode; the agent retains interaction control.');
  }

  if (snapshot.activeTabId) {
    lines.push(`Active tab ID: ${JSON.stringify(snapshot.activeTabId)}`);
  }
  if (snapshot.activeTitle) {
    lines.push(`Active tab title: ${JSON.stringify(snapshot.activeTitle)}`);
  }
  if (snapshot.activeUrl) {
    lines.push(`Active tab URL: ${JSON.stringify(snapshot.activeUrl)}`);
  }

  lines.push(`Open tab count: ${snapshot.tabCount}`);
  if (snapshot.tabs.length > 0) {
    lines.push(`Open tabs: ${JSON.stringify(snapshot.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
    })))}`);
  }

  if (snapshot.hasPendingDialog) {
    lines.push('A page dialog is pending. Inspect it with browser dialog_status before continuing interaction.');
  }

  return lines.join('\n');
}
