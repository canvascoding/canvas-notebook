import {
  WORKSPACE_BRAND_FONT_IDS,
  type WorkspaceBrandFontId,
  type WorkspaceBrandProfile,
} from './brand-profile';
import { workspaceBrandUiFontStack } from './brand-fonts';

export const WORKSPACE_APPEARANCE_UPDATED_EVENT = 'canvas:workspace-appearance-updated';

export type WorkspaceAppearanceColorMode = 'light' | 'dark';

export interface WorkspaceAppearanceDefinition {
  enabled: boolean;
  radiusPx: number;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  font: WorkspaceBrandFontId;
}

export const WORKSPACE_APPEARANCE_CSS_PROPERTIES = [
  '--app-font-sans',
  '--radius',
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  '--ring',
  '--chart-1',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
] as const;

export type WorkspaceAppearanceCssProperty = (typeof WORKSPACE_APPEARANCE_CSS_PROPERTIES)[number];
export type WorkspaceAppearanceCssTokens = Record<WorkspaceAppearanceCssProperty, string>;

export const WORKSPACE_ACCENT_CSS_PROPERTIES = [
  '--primary',
  '--primary-foreground',
  '--accent',
  '--accent-foreground',
  '--ring',
  '--chart-1',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-ring',
] as const satisfies readonly WorkspaceAppearanceCssProperty[];

export type WorkspaceAccentCssProperty = (typeof WORKSPACE_ACCENT_CSS_PROPERTIES)[number];
export type WorkspaceAccentCssTokens = Record<WorkspaceAccentCssProperty, string>;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

type RgbColor = { red: number; green: number; blue: number };

function parseHexColor(color: string): RgbColor {
  return {
    red: Number.parseInt(color.slice(1, 3), 16),
    green: Number.parseInt(color.slice(3, 5), 16),
    blue: Number.parseInt(color.slice(5, 7), 16),
  };
}

function toHexColor(color: RgbColor): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

export function mixWorkspaceAppearanceColor(from: string, to: string, toWeight: number): string {
  const start = parseHexColor(from);
  const end = parseHexColor(to);
  const weight = Math.min(1, Math.max(0, toWeight));
  return toHexColor({
    red: start.red + ((end.red - start.red) * weight),
    green: start.green + ((end.green - start.green) * weight),
    blue: start.blue + ((end.blue - start.blue) * weight),
  });
}

function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  const linearChannel = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * linearChannel(rgb.red))
    + (0.7152 * linearChannel(rgb.green))
    + (0.0722 * linearChannel(rgb.blue));
}

export function workspaceAppearanceContrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function bestContrastColor(background: string): '#111111' | '#ffffff' {
  return workspaceAppearanceContrastRatio('#111111', background) >= workspaceAppearanceContrastRatio('#ffffff', background)
    ? '#111111'
    : '#ffffff';
}

function ensureContrast(color: string, background: string, minimumRatio: number): string {
  if (workspaceAppearanceContrastRatio(color, background) >= minimumRatio) return color;
  const target = bestContrastColor(background);
  for (let step = 1; step <= 10; step += 1) {
    const candidate = mixWorkspaceAppearanceColor(color, target, step / 10);
    if (workspaceAppearanceContrastRatio(candidate, background) >= minimumRatio) return candidate;
  }
  return target;
}

export function workspaceAppearanceDefinitionFromProfile(
  profile: WorkspaceBrandProfile,
): WorkspaceAppearanceDefinition {
  return {
    enabled: profile.appearance.enabled,
    radiusPx: profile.appearance.radiusPx,
    backgroundColor: profile.page.backgroundColor,
    textColor: profile.colors.text,
    accentColor: profile.colors.accent,
    font: profile.typography.bodyFont,
  };
}

export function normalizeWorkspaceAppearanceDefinition(value: unknown): WorkspaceAppearanceDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<WorkspaceAppearanceDefinition>;
  if (typeof record.enabled !== 'boolean') return null;
  if (typeof record.radiusPx !== 'number' || !Number.isFinite(record.radiusPx)) return null;
  if (typeof record.backgroundColor !== 'string' || !HEX_COLOR_PATTERN.test(record.backgroundColor)) return null;
  if (typeof record.textColor !== 'string' || !HEX_COLOR_PATTERN.test(record.textColor)) return null;
  if (typeof record.accentColor !== 'string' || !HEX_COLOR_PATTERN.test(record.accentColor)) return null;
  if (typeof record.font !== 'string' || !WORKSPACE_BRAND_FONT_IDS.includes(record.font as WorkspaceBrandFontId)) return null;

  return {
    enabled: record.enabled,
    radiusPx: Math.min(16, Math.max(0, record.radiusPx)),
    backgroundColor: record.backgroundColor.toLowerCase(),
    textColor: record.textColor.toLowerCase(),
    accentColor: record.accentColor.toLowerCase(),
    font: record.font as WorkspaceBrandFontId,
  };
}

export function createWorkspaceAppearanceCssTokens(
  definition: WorkspaceAppearanceDefinition,
  mode: WorkspaceAppearanceColorMode,
): WorkspaceAppearanceCssTokens {
  const configuredBackground = definition.backgroundColor.toLowerCase();
  const background = mode === 'dark'
    ? mixWorkspaceAppearanceColor('#090c12', configuredBackground, 0.18)
    : configuredBackground;
  const foregroundSeed = mode === 'dark'
    ? mixWorkspaceAppearanceColor('#f7f8fa', definition.textColor.toLowerCase(), 0.12)
    : definition.textColor.toLowerCase();
  const foreground = ensureContrast(foregroundSeed, background, 4.5);
  const isDarkSurface = relativeLuminance(background) < 0.24;
  const elevatedTarget = isDarkSurface ? '#ffffff' : '#ffffff';
  const card = mixWorkspaceAppearanceColor(background, elevatedTarget, isDarkSurface ? 0.055 : 0.72);
  const primary = ensureContrast(definition.accentColor.toLowerCase(), background, 3);
  const primaryForeground = bestContrastColor(primary);
  const secondary = mixWorkspaceAppearanceColor(background, foreground, isDarkSurface ? 0.11 : 0.07);
  const muted = mixWorkspaceAppearanceColor(background, foreground, isDarkSurface ? 0.075 : 0.055);
  const mutedForeground = ensureContrast(
    mixWorkspaceAppearanceColor(foreground, background, isDarkSurface ? 0.28 : 0.34),
    muted,
    4.5,
  );
  const accent = mixWorkspaceAppearanceColor(background, primary, isDarkSurface ? 0.24 : 0.14);
  const border = mixWorkspaceAppearanceColor(background, foreground, isDarkSurface ? 0.2 : 0.16);
  const sidebar = mixWorkspaceAppearanceColor(background, primary, isDarkSurface ? 0.055 : 0.035);

  return {
    '--app-font-sans': workspaceBrandUiFontStack(definition.font),
    '--radius': `${definition.radiusPx}px`,
    '--background': background,
    '--foreground': foreground,
    '--card': card,
    '--card-foreground': foreground,
    '--popover': card,
    '--popover-foreground': foreground,
    '--primary': primary,
    '--primary-foreground': primaryForeground,
    '--secondary': secondary,
    '--secondary-foreground': foreground,
    '--muted': muted,
    '--muted-foreground': mutedForeground,
    '--accent': accent,
    '--accent-foreground': foreground,
    '--border': border,
    '--input': border,
    '--ring': primary,
    '--chart-1': primary,
    '--sidebar': sidebar,
    '--sidebar-foreground': foreground,
    '--sidebar-primary': primary,
    '--sidebar-primary-foreground': primaryForeground,
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-border': border,
    '--sidebar-ring': primary,
  };
}

export function createWorkspaceAccentCssTokens(
  accentColor: string,
  mode: WorkspaceAppearanceColorMode,
): WorkspaceAccentCssTokens {
  const configuredAccent = HEX_COLOR_PATTERN.test(accentColor) ? accentColor.toLowerCase() : '#2563eb';
  const background = mode === 'dark' ? '#090c12' : '#ffffff';
  const foreground = mode === 'dark' ? '#f7f8fa' : '#111111';
  const primary = ensureContrast(configuredAccent, background, 3);
  const primaryForeground = bestContrastColor(primary);
  const accent = mixWorkspaceAppearanceColor(background, primary, mode === 'dark' ? 0.24 : 0.12);

  return {
    '--primary': primary,
    '--primary-foreground': primaryForeground,
    '--accent': accent,
    '--accent-foreground': foreground,
    '--ring': primary,
    '--chart-1': primary,
    '--sidebar-primary': primary,
    '--sidebar-primary-foreground': primaryForeground,
    '--sidebar-accent': accent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-ring': primary,
  };
}
