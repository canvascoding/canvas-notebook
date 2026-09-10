import type { McpUiHostContext, McpUiStyleVariableKey, McpUiStyles } from '@modelcontextprotocol/ext-apps';

const VARIABLES: Partial<Record<McpUiStyleVariableKey, string>> = {
  '--color-background-primary': '--background', '--color-background-secondary': '--muted',
  '--color-text-primary': '--foreground', '--color-text-secondary': '--muted-foreground',
  '--color-border-primary': '--border', '--color-text-danger': '--destructive',
  '--color-ring-primary': '--ring', '--border-radius-sm': '--radius', '--border-radius-md': '--radius',
  '--border-radius-lg': '--radius', '--font-sans': '--app-font-sans', '--font-mono': '--font-geist-mono',
};

export function readToolAppHostContext(locale: string): McpUiHostContext {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const variables = Object.fromEntries(Object.entries(VARIABLES).map(([key, token]) => [key, computed.getPropertyValue(token).trim() || undefined])) as McpUiStyles;
  return { locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    theme: root.classList.contains('dark') ? 'dark' : 'light', platform: 'web',
    displayMode: 'inline', availableDisplayModes: ['inline'],
    styles: { variables }, containerDimensions: { maxHeight: 900 } };
}
