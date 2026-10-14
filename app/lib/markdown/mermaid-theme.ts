import type { MermaidConfig } from 'mermaid';
import {
  mixWorkspaceAppearanceColor,
  workspaceAppearanceContrastRatio,
} from '@/app/lib/workspaces/appearance-theme';
import type { WorkspaceBrandProfile } from '@/app/lib/workspaces/brand-profile';
import { workspaceBrandFontStack } from '@/app/lib/workspaces/brand-fonts';

export interface MermaidThemeTokens {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  primary: string;
  charts: string[];
  fontFamily: string;
}

// Hex fallbacks also serve non-DOM renderers. The browser resolves the actual
// CSS tokens, including OKLCH and workspace appearance overrides.
export const CANVAS_MERMAID_LIGHT: MermaidThemeTokens = {
  background: '#f6f9fc', foreground: '#141b23', muted: '#536170', border: '#c9d1da',
  primary: '#254b6e', charts: ['#254b6e', '#228a6e', '#b47222', '#b45555', '#8559a5'],
  fontFamily: 'Arial, Helvetica, sans-serif',
};

export const CANVAS_MERMAID_DARK: MermaidThemeTokens = {
  background: '#090c12', foreground: '#e4e9ef', muted: '#a2aab4', border: '#303b48',
  primary: '#8ab9df', charts: ['#8ab9df', '#63b798', '#d4a062', '#d17e7e', '#b58dcf'],
  fontFamily: 'Arial, Helvetica, sans-serif',
};

function readableColor(color: string, background: string, ratio: number): string {
  if (workspaceAppearanceContrastRatio(color, background) >= ratio) return color;
  const target = workspaceAppearanceContrastRatio('#111111', background) > workspaceAppearanceContrastRatio('#ffffff', background)
    ? '#111111' : '#ffffff';
  for (let step = 1; step <= 20; step++) {
    const adjusted = mixWorkspaceAppearanceColor(color, target, step / 20);
    if (workspaceAppearanceContrastRatio(adjusted, background) >= ratio) return adjusted;
  }
  return target;
}

export function createMermaidTheme(tokens: MermaidThemeTokens = CANVAS_MERMAID_LIGHT): MermaidConfig {
  const darkMode = workspaceAppearanceContrastRatio('#ffffff', tokens.background)
    > workspaceAppearanceContrastRatio('#111111', tokens.background);
  const text = readableColor(tokens.foreground, tokens.background, 4.5);
  const muted = readableColor(tokens.muted, tokens.background, 4.5);
  const line = readableColor(tokens.muted, tokens.background, 3);
  const palette = (tokens.charts.length ? tokens.charts : [tokens.primary])
    .map((color) => readableColor(color, tokens.background, 4.5));
  const primary = mixWorkspaceAppearanceColor(tokens.background, tokens.primary, darkMode ? 0.22 : 0.10);
  const secondary = mixWorkspaceAppearanceColor(tokens.background, palette[1] ?? palette[0], darkMode ? 0.18 : 0.08);
  const tertiary = mixWorkspaceAppearanceColor(tokens.background, text, darkMode ? 0.08 : 0.04);
  const categorical: Record<string, string> = {};
  for (let index = 0; index < 12; index++) {
    const color = palette[index % palette.length];
    categorical[`pie${index + 1}`] = color;
    categorical[`cScale${index}`] = mixWorkspaceAppearanceColor(tokens.background, color, darkMode ? 0.25 : 0.12);
    categorical[`cScaleLabel${index}`] = text;
    categorical[`cScaleInv${index}`] = line;
    if (index < 8) categorical[`fillType${index}`] = categorical[`cScale${index}`];
  }
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: tokens.fontFamily,
    themeVariables: {
      ...categorical,
      darkMode,
      background: tokens.background,
      fontFamily: tokens.fontFamily,
      fontSize: '14px',
      textColor: text,
      primaryColor: primary,
      primaryTextColor: text,
      primaryBorderColor: readableColor(tokens.primary, tokens.background, 3),
      secondaryColor: secondary,
      secondaryTextColor: text,
      secondaryBorderColor: line,
      tertiaryColor: tertiary,
      tertiaryTextColor: text,
      tertiaryBorderColor: line,
      lineColor: line,
      mainBkg: primary,
      nodeTextColor: text,
      clusterBkg: tertiary,
      clusterBorder: tokens.border,
      edgeLabelBackground: tokens.background,
      titleColor: text,
      scaleLabelColor: text,
      actorBkg: primary,
      actorTextColor: text,
      actorBorder: line,
      actorLineColor: line,
      signalColor: line,
      signalTextColor: text,
      noteBkgColor: secondary,
      noteTextColor: text,
      noteBorderColor: line,
      labelTextColor: text,
      loopTextColor: text,
      activationBkgColor: secondary,
      activationBorderColor: line,
      pieTitleTextColor: text,
      pieLegendTextColor: text,
      pieSectionTextColor: tokens.background,
      pieStrokeColor: tokens.background,
      pieOuterStrokeColor: tokens.border,
      pieOpacity: 1,
      xyChart: {
        backgroundColor: tokens.background,
        titleColor: text,
        dataLabelColor: text,
        legendTextColor: text,
        xAxisLabelColor: muted,
        xAxisTitleColor: text,
        xAxisTickColor: line,
        xAxisLineColor: line,
        yAxisLabelColor: muted,
        yAxisTitleColor: text,
        yAxisTickColor: line,
        yAxisLineColor: line,
        plotColorPalette: palette.join(', '),
      },
    },
  };
}

export function createMermaidExportTheme(profile?: WorkspaceBrandProfile): MermaidConfig {
  if (!profile) return createMermaidTheme();
  return createMermaidTheme({
    ...CANVAS_MERMAID_LIGHT,
    background: profile.page.backgroundColor,
    foreground: profile.colors.text,
    muted: profile.colors.mutedText,
    border: profile.colors.border,
    primary: profile.colors.accent,
    charts: [profile.colors.accent, ...CANVAS_MERMAID_LIGHT.charts.slice(1)],
    fontFamily: workspaceBrandFontStack(profile.typography.bodyFont),
  });
}
