import {
  DEFAULT_WORKSPACE_BRAND_PROFILE,
  type WorkspaceBrandHeadingStyle,
  type WorkspaceBrandProfile,
} from '@/app/lib/workspaces/brand-profile';
import { workspaceBrandFontStack } from '@/app/lib/workspaces/brand-fonts';

export { workspaceBrandFontStack } from '@/app/lib/workspaces/brand-fonts';

export type MarkdownPdfRenderOptions = {
  format: 'A4' | 'Letter';
  preferCssPageSize: true;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  margin?: {
    top: string;
    right: string;
    bottom: string;
    left: string;
  };
};

const LOGO_HEADER_MIN_TOP_MARGIN_MM = 18;
const LOGO_HEADER_MAX_DATA_URI_LENGTH = 1_500_000;
const LOGO_DATA_URI_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/iu;

function hasRepeatingLogo(profile: WorkspaceBrandProfile): boolean {
  return profile.enabled && Boolean(profile.logoPath);
}

function pageTopMarginMm(profile: WorkspaceBrandProfile): number {
  return hasRepeatingLogo(profile)
    ? Math.max(profile.page.verticalMarginMm, LOGO_HEADER_MIN_TOP_MARGIN_MM)
    : profile.page.verticalMarginMm;
}

function pageMarginCss(profile: WorkspaceBrandProfile): string {
  const top = pageTopMarginMm(profile);
  if (top === profile.page.verticalMarginMm) {
    return `${profile.page.verticalMarginMm}mm ${profile.page.horizontalMarginMm}mm`;
  }
  return `${top}mm ${profile.page.horizontalMarginMm}mm ${profile.page.verticalMarginMm}mm`;
}

function headingDecorationCss(
  selector: 'h1' | 'h2',
  style: WorkspaceBrandHeadingStyle,
  profile: WorkspaceBrandProfile,
): string {
  if (style === 'plain') {
    return `${selector} { border-bottom: none; padding-bottom: 0; }`;
  }

  if (style === 'accent-bar') {
    return `${selector} {
      border-bottom: none;
      border-left: 4px solid ${profile.colors.accent};
      padding-bottom: 0;
      padding-left: 0.55em;
    }`;
  }

  const width = selector === 'h1' ? 2 : 1;
  const color = profile.enabled
    ? profile.colors.accent
    : selector === 'h1' ? '#333333' : '#cccccc';
  return `${selector} {
    border-bottom: ${width}px solid ${color};
    padding-bottom: 0.3em;
  }`;
}

export function createWorkspaceBrandCss(profile: WorkspaceBrandProfile): string {
  const effective = profile || DEFAULT_WORKSPACE_BRAND_PROFILE;
  return `
    :root {
      --brand-page-background: ${effective.page.backgroundColor};
      --brand-text: ${effective.colors.text};
      --brand-muted-text: ${effective.colors.mutedText};
      --brand-heading: ${effective.colors.heading};
      --brand-accent: ${effective.colors.accent};
      --brand-link: ${effective.colors.link};
      --brand-border: ${effective.colors.border};
      --brand-surface: ${effective.colors.surface};
      --brand-code-background: ${effective.colors.codeBackground};
      --brand-table-header: ${effective.colors.tableHeaderBackground};
      --brand-table-stripe: ${effective.colors.tableStripeBackground};
    }

    @page {
      size: ${effective.page.size};
      margin: ${pageMarginCss(effective)};
      background: ${effective.page.backgroundColor};
    }

    @page markdown-wide-table {
      size: ${effective.page.size} landscape;
      margin: ${hasRepeatingLogo(effective) ? `${LOGO_HEADER_MIN_TOP_MARGIN_MM}mm 15mm 15mm` : '15mm'};
      background: ${effective.page.backgroundColor};
    }

    html, body {
      background: var(--brand-page-background);
    }

    body {
      color: var(--brand-text);
      font-family: ${workspaceBrandFontStack(effective.typography.bodyFont)};
      font-size: ${effective.typography.bodySizePt}pt;
      line-height: ${effective.typography.lineHeight};
    }

    h1, h2, h3, h4, h5, h6 {
      color: var(--brand-heading);
      font-family: ${workspaceBrandFontStack(effective.typography.headingFont)};
      font-weight: ${effective.typography.headingWeight};
    }

    h1 { font-size: ${effective.typography.h1SizePt}pt; }
    h2 { font-size: ${effective.typography.h2SizePt}pt; }

    ${headingDecorationCss('h1', effective.typography.h1Style, effective)}
    ${headingDecorationCss('h2', effective.typography.h2Style, effective)}

    a { color: var(--brand-link); }
    pre { background: var(--brand-code-background); border-color: var(--brand-border); }
    :not(pre) > code { background: var(--brand-code-background); }
    th, td { border-color: var(--brand-border); }
    th { background: var(--brand-table-header); }
    tr:nth-child(even) { background: var(--brand-table-stripe); }
    blockquote { border-left-color: var(--brand-accent); color: var(--brand-muted-text); }
    hr { border-top-color: var(--brand-border); }
    .mermaid-diagram-fallback { border-color: var(--brand-border); background: var(--brand-surface); }

    .canvas-brand-header {
      align-items: center;
      border-bottom: 1px solid var(--brand-border);
      display: flex;
      gap: 14px;
      margin: 0 0 2.2em;
      min-height: 38px;
      padding: 0 0 1em;
    }

    .canvas-brand-logo {
      display: block;
      height: 38px;
      margin: 0;
      max-width: 150px;
      object-fit: contain;
      object-position: left center;
      width: auto;
    }

    .canvas-brand-name {
      color: var(--brand-heading);
      font-family: ${workspaceBrandFontStack(effective.typography.headingFont)};
      font-size: 10pt;
      font-weight: ${effective.typography.headingWeight};
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
  `;
}

function validLogoDataUri(value: string | null | undefined): string | null {
  if (!value || value.length > LOGO_HEADER_MAX_DATA_URI_LENGTH || !LOGO_DATA_URI_PATTERN.test(value)) {
    return null;
  }
  return value;
}

export function createWorkspaceBrandPdfHeaderTemplate(
  profile: WorkspaceBrandProfile,
  logoDataUri: string | null | undefined,
): string {
  const logo = hasRepeatingLogo(profile) ? validLogoDataUri(logoDataUri) : null;
  if (!logo) return '';

  const justifyContent = profile.logoPosition === 'left' ? 'flex-start' : 'flex-end';
  return `<div style="align-items:flex-start;box-sizing:border-box;display:flex;font-size:0;height:11mm;justify-content:${justifyContent};padding:1.5mm ${profile.page.horizontalMarginMm}mm 0;width:100%;"><img alt="" src="${logo}" style="display:block;height:auto;max-height:9mm;max-width:28mm;object-fit:contain;width:auto;"></div>`;
}

export function getMarkdownPdfRenderOptions(
  profile: WorkspaceBrandProfile,
  logoDataUri?: string | null,
): MarkdownPdfRenderOptions {
  const options: MarkdownPdfRenderOptions = {
    format: profile.page.size,
    preferCssPageSize: true,
  };
  const headerTemplate = createWorkspaceBrandPdfHeaderTemplate(profile, logoDataUri);
  if (!headerTemplate) return options;

  return {
    ...options,
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate: '<div></div>',
    margin: {
      top: `${pageTopMarginMm(profile)}mm`,
      right: `${profile.page.horizontalMarginMm}mm`,
      bottom: `${profile.page.verticalMarginMm}mm`,
      left: `${profile.page.horizontalMarginMm}mm`,
    },
  };
}

export function createWorkspaceBrandHeaderHtml(input: {
  profile: WorkspaceBrandProfile;
  logoDataUri?: string | null;
  escapeHtml: (value: string) => string;
}): string {
  if (!input.profile.enabled || (!input.profile.brandName && !input.logoDataUri)) return '';

  const logo = input.logoDataUri
    ? `<img class="canvas-brand-logo" src="${input.logoDataUri}" alt="">`
    : '';
  const name = input.profile.brandName
    ? `<span class="canvas-brand-name">${input.escapeHtml(input.profile.brandName)}</span>`
    : '';
  return `<header class="canvas-brand-header">${logo}${name}</header>`;
}
