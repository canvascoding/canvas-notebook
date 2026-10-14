import {
  CANVAS_MERMAID_DARK,
  CANVAS_MERMAID_LIGHT,
  createMermaidTheme,
} from './mermaid-theme';

export function readMermaidTheme() {
  const root = document.documentElement;
  const dark = root.classList.contains('dark') || (!root.classList.contains('light')
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const fallback = dark ? CANVAS_MERMAID_DARK : CANVAS_MERMAID_LIGHT;
  const style = getComputedStyle(root);
  // Canvas converts every CSS color format the browser supports to sRGB hex,
  // which Mermaid requires for its derived theme colors.
  const context = typeof CanvasRenderingContext2D === 'undefined'
    ? null : document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const color = (property: string, defaultValue: string) => {
    const value = style.getPropertyValue(property).trim();
    if (!value || !context || !CSS.supports('color', value)) return defaultValue;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (alpha !== 255) return defaultValue;
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  };
  return createMermaidTheme({
    background: color('--background', fallback.background),
    foreground: color('--foreground', fallback.foreground),
    muted: color('--muted-foreground', fallback.muted),
    border: color('--border', fallback.border),
    primary: color('--primary', fallback.primary),
    charts: fallback.charts.map((value, index) => color(`--chart-${index + 1}`, value)),
    fontFamily: style.getPropertyValue('--app-font-sans').trim() || getComputedStyle(document.body).fontFamily || fallback.fontFamily,
  });
}
