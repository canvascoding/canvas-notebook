import type { WorkspaceBrandFontId } from './brand-profile';

const WORKSPACE_BRAND_FONT_STACKS: Record<WorkspaceBrandFontId, string> = {
  'canvas-sans': "Arial, 'Liberation Sans', Helvetica, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif",
  'humanist-sans': "'Avenir Next', Avenir, 'Segoe UI', 'DejaVu Sans', 'Liberation Sans', Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif",
  'editorial-serif': "Georgia, Cambria, 'Liberation Serif', 'Times New Roman', Times, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif",
  'classic-serif': "Baskerville, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Liberation Serif', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif",
  'technical-mono': "'SFMono-Regular', 'Cascadia Code', 'Roboto Mono', Consolas, 'Liberation Mono', 'Courier New', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', monospace",
  'arial-sans': "Arial, 'Liberation Sans', Helvetica, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif",
  'verdana-sans': "Verdana, 'DejaVu Sans', 'Liberation Sans', Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif",
  'trebuchet-sans': "'Trebuchet MS', 'Liberation Sans', Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif",
  'georgia-serif': "Georgia, 'Liberation Serif', 'Times New Roman', Times, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif",
  'times-serif': "'Times New Roman', Times, 'Liberation Serif', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif",
  'courier-mono': "'Courier New', Courier, 'Liberation Mono', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', monospace",
};

export function workspaceBrandFontStack(font: WorkspaceBrandFontId): string {
  return WORKSPACE_BRAND_FONT_STACKS[font];
}

export function workspaceBrandUiFontStack(font: WorkspaceBrandFontId): string {
  if (font === 'canvas-sans') {
    return `var(--font-geist-sans), ${WORKSPACE_BRAND_FONT_STACKS[font]}`;
  }
  return WORKSPACE_BRAND_FONT_STACKS[font];
}
