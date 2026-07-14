export const WORKSPACE_BRAND_FONT_IDS = [
  'canvas-sans',
  'humanist-sans',
  'editorial-serif',
  'classic-serif',
  'technical-mono',
] as const;

export type WorkspaceBrandFontId = (typeof WORKSPACE_BRAND_FONT_IDS)[number];

export const WORKSPACE_BRAND_HEADING_STYLES = ['plain', 'underline', 'accent-bar'] as const;

export type WorkspaceBrandHeadingStyle = (typeof WORKSPACE_BRAND_HEADING_STYLES)[number];

export const WORKSPACE_BRAND_PAGE_SIZES = ['A4', 'Letter'] as const;

export type WorkspaceBrandPageSize = (typeof WORKSPACE_BRAND_PAGE_SIZES)[number];

export interface WorkspaceBrandProfile {
  enabled: boolean;
  brandName: string;
  logoPath: string;
  voice: string;
  targetAudience: string;
  writingGuidelines: string;
  page: {
    size: WorkspaceBrandPageSize;
    backgroundColor: string;
    marginMm: number;
  };
  typography: {
    bodyFont: WorkspaceBrandFontId;
    headingFont: WorkspaceBrandFontId;
    bodySizePt: number;
    lineHeight: number;
    h1SizePt: number;
    h2SizePt: number;
    headingWeight: number;
    h1Style: WorkspaceBrandHeadingStyle;
    h2Style: WorkspaceBrandHeadingStyle;
  };
  colors: {
    text: string;
    mutedText: string;
    heading: string;
    accent: string;
    link: string;
    border: string;
    surface: string;
    codeBackground: string;
    tableHeaderBackground: string;
    tableStripeBackground: string;
  };
}

export interface WorkspaceBrandProfileState {
  profile: WorkspaceBrandProfile;
  configured: boolean;
  revision: number;
  updatedAt: number | null;
}

export const DEFAULT_WORKSPACE_BRAND_PROFILE: WorkspaceBrandProfile = {
  enabled: false,
  brandName: '',
  logoPath: '',
  voice: '',
  targetAudience: '',
  writingGuidelines: '',
  page: {
    size: 'A4',
    backgroundColor: '#ffffff',
    marginMm: 20,
  },
  typography: {
    bodyFont: 'canvas-sans',
    headingFont: 'canvas-sans',
    bodySizePt: 11,
    lineHeight: 1.6,
    h1SizePt: 22,
    h2SizePt: 16.5,
    headingWeight: 700,
    h1Style: 'underline',
    h2Style: 'underline',
  },
  colors: {
    text: '#222222',
    mutedText: '#555555',
    heading: '#222222',
    accent: '#0066cc',
    link: '#0066cc',
    border: '#cccccc',
    surface: '#fafafa',
    codeBackground: '#f5f5f5',
    tableHeaderBackground: '#f5f5f5',
    tableStripeBackground: '#fafafa',
  },
};

export const WORKSPACE_BRAND_PRESETS = {
  canvas: DEFAULT_WORKSPACE_BRAND_PROFILE,
  editorial: {
    ...DEFAULT_WORKSPACE_BRAND_PROFILE,
    enabled: true,
    page: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.page,
      backgroundColor: '#fbf8f1',
      marginMm: 22,
    },
    typography: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.typography,
      bodyFont: 'editorial-serif',
      headingFont: 'classic-serif',
      bodySizePt: 11.5,
      lineHeight: 1.68,
      h1SizePt: 25,
      h2SizePt: 18,
      h1Style: 'plain',
      h2Style: 'accent-bar',
    },
    colors: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.colors,
      text: '#29251f',
      mutedText: '#6f675e',
      heading: '#1d1915',
      accent: '#b24a2b',
      link: '#9b3e24',
      border: '#d9cec0',
      surface: '#f5eee3',
      codeBackground: '#f2eadf',
      tableHeaderBackground: '#ede1d1',
      tableStripeBackground: '#f8f2e9',
    },
  },
  corporate: {
    ...DEFAULT_WORKSPACE_BRAND_PROFILE,
    enabled: true,
    typography: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.typography,
      bodyFont: 'humanist-sans',
      headingFont: 'humanist-sans',
      h1Style: 'accent-bar',
      h2Style: 'plain',
    },
    colors: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.colors,
      text: '#172033',
      mutedText: '#56627a',
      heading: '#101827',
      accent: '#0f6cbd',
      link: '#0f6cbd',
      border: '#c9d3e1',
      surface: '#f5f8fc',
      codeBackground: '#eef3f8',
      tableHeaderBackground: '#e7eef7',
      tableStripeBackground: '#f7f9fc',
    },
  },
  minimal: {
    ...DEFAULT_WORKSPACE_BRAND_PROFILE,
    enabled: true,
    page: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.page,
      marginMm: 24,
    },
    typography: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.typography,
      bodyFont: 'humanist-sans',
      headingFont: 'humanist-sans',
      bodySizePt: 10.5,
      lineHeight: 1.72,
      h1SizePt: 23,
      h2SizePt: 15,
      headingWeight: 600,
      h1Style: 'plain',
      h2Style: 'plain',
    },
    colors: {
      ...DEFAULT_WORKSPACE_BRAND_PROFILE.colors,
      text: '#1c1c1c',
      mutedText: '#666666',
      heading: '#111111',
      accent: '#111111',
      link: '#111111',
      border: '#dedede',
      surface: '#f8f8f8',
      codeBackground: '#f3f3f3',
      tableHeaderBackground: '#f0f0f0',
      tableStripeBackground: '#fafafa',
    },
  },
} as const satisfies Record<string, WorkspaceBrandProfile>;

export class WorkspaceBrandProfileValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBrandProfileValidationError';
  }
}

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringValue(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : fallback;
}

function colorValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}

function logoPathValue(value: unknown, fallback: string): string {
  const normalized = stringValue(value, fallback, 500).replace(/\\/gu, '/');
  if (!normalized) return '';
  if (normalized.startsWith('/') || normalized.includes('\0')) return fallback;
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) return fallback;
  return normalized;
}

export function normalizeWorkspaceBrandProfile(value: unknown): WorkspaceBrandProfile {
  const source = recordValue(value);
  const page = recordValue(source.page);
  const typography = recordValue(source.typography);
  const colors = recordValue(source.colors);
  const defaults = DEFAULT_WORKSPACE_BRAND_PROFILE;

  return {
    enabled: booleanValue(source.enabled, defaults.enabled),
    brandName: stringValue(source.brandName, defaults.brandName, 120),
    logoPath: logoPathValue(source.logoPath, defaults.logoPath),
    voice: stringValue(source.voice, defaults.voice, 500),
    targetAudience: stringValue(source.targetAudience, defaults.targetAudience, 500),
    writingGuidelines: stringValue(source.writingGuidelines, defaults.writingGuidelines, 2_000),
    page: {
      size: enumValue(page.size, WORKSPACE_BRAND_PAGE_SIZES, defaults.page.size),
      backgroundColor: colorValue(page.backgroundColor, defaults.page.backgroundColor),
      marginMm: numberValue(page.marginMm, defaults.page.marginMm, 10, 35),
    },
    typography: {
      bodyFont: enumValue(typography.bodyFont, WORKSPACE_BRAND_FONT_IDS, defaults.typography.bodyFont),
      headingFont: enumValue(typography.headingFont, WORKSPACE_BRAND_FONT_IDS, defaults.typography.headingFont),
      bodySizePt: numberValue(typography.bodySizePt, defaults.typography.bodySizePt, 8, 16),
      lineHeight: numberValue(typography.lineHeight, defaults.typography.lineHeight, 1.2, 2),
      h1SizePt: numberValue(typography.h1SizePt, defaults.typography.h1SizePt, 16, 36),
      h2SizePt: numberValue(typography.h2SizePt, defaults.typography.h2SizePt, 12, 28),
      headingWeight: numberValue(typography.headingWeight, defaults.typography.headingWeight, 400, 800),
      h1Style: enumValue(typography.h1Style, WORKSPACE_BRAND_HEADING_STYLES, defaults.typography.h1Style),
      h2Style: enumValue(typography.h2Style, WORKSPACE_BRAND_HEADING_STYLES, defaults.typography.h2Style),
    },
    colors: {
      text: colorValue(colors.text, defaults.colors.text),
      mutedText: colorValue(colors.mutedText, defaults.colors.mutedText),
      heading: colorValue(colors.heading, defaults.colors.heading),
      accent: colorValue(colors.accent, defaults.colors.accent),
      link: colorValue(colors.link, defaults.colors.link),
      border: colorValue(colors.border, defaults.colors.border),
      surface: colorValue(colors.surface, defaults.colors.surface),
      codeBackground: colorValue(colors.codeBackground, defaults.colors.codeBackground),
      tableHeaderBackground: colorValue(colors.tableHeaderBackground, defaults.colors.tableHeaderBackground),
      tableStripeBackground: colorValue(colors.tableStripeBackground, defaults.colors.tableStripeBackground),
    },
  };
}

function assertProfileShape(input: unknown): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkspaceBrandProfileValidationError('Brand profile must be an object.');
  }
}

function assertColorFields(value: unknown, fieldNames: string[]) {
  const record = recordValue(value);
  for (const fieldName of fieldNames) {
    const color = record[fieldName];
    if (color !== undefined && (typeof color !== 'string' || !HEX_COLOR_PATTERN.test(color.trim()))) {
      throw new WorkspaceBrandProfileValidationError(`${fieldName} must be a six-digit hex color.`);
    }
  }
}

export function validateWorkspaceBrandProfile(input: unknown): WorkspaceBrandProfile {
  assertProfileShape(input);
  assertColorFields(input.page, ['backgroundColor']);
  assertColorFields(input.colors, [
    'text',
    'mutedText',
    'heading',
    'accent',
    'link',
    'border',
    'surface',
    'codeBackground',
    'tableHeaderBackground',
    'tableStripeBackground',
  ]);

  const normalized = normalizeWorkspaceBrandProfile(input);
  if (typeof input.logoPath === 'string' && input.logoPath.trim() && !normalized.logoPath) {
    throw new WorkspaceBrandProfileValidationError('Logo path must be relative to the workspace.');
  }
  return normalized;
}

export function cloneWorkspaceBrandProfile(profile: WorkspaceBrandProfile): WorkspaceBrandProfile {
  return JSON.parse(JSON.stringify(profile)) as WorkspaceBrandProfile;
}
