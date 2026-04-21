import { readFile } from '@/app/lib/filesystem/workspace-files';
import { marked } from 'marked';
import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const READ_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] || 'image/png';
}

function escapeForJsTemplate(code: string): string {
  return code
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

async function renderMermaidToSvg(code: string): Promise<string | null> {
  const { getBrowser } = await import('./browser');
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const mermaidPath = require.resolve('mermaid');
    const mermaidJs = await fs.readFile(mermaidPath, 'utf-8');

    const escapedCode = escapeForJsTemplate(code);

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body>
          <div id="diagram"></div>
          <script>
            ${mermaidJs}
            mermaid.initialize({ 
              startOnLoad: false, 
              theme: 'default',
              securityLevel: 'loose'
            });
            mermaid.render('mermaid-svg', \`${escapedCode}\`)
              .then(({ svg }) => {
                document.getElementById('diagram').innerHTML = svg;
              })
              .catch((err) => {
                console.error('Mermaid render error:', err);
                document.getElementById('diagram').innerHTML = '<div class="mermaid-error">Error rendering diagram</div>';
              });
          </script>
        </body>
      </html>
    `);

    await page.waitForSelector('#diagram svg', { timeout: 10000 });
    const svg = await page.$eval('#diagram svg', el => el.outerHTML);
    return svg;
  } catch (err) {
    console.error('[Mermaid Render] Failed to render diagram:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    await page.close();
  }
}

async function processMermaidBlocks(markdownContent: string): Promise<string> {
  const mermaidBlockRegex = /```mermaid\n([\s\S]*?)```/g;
  const matches = Array.from(markdownContent.matchAll(mermaidBlockRegex));

  if (matches.length === 0) {
    return markdownContent;
  }

  let processed = markdownContent;

  for (const match of matches) {
    const fullMatch = match[0];
    const mermaidCode = match[1].trim();
    const svg = await renderMermaidToSvg(mermaidCode);

    if (svg) {
      processed = processed.replace(fullMatch, `<div class="mermaid-diagram" style="text-align: center; margin: 1em 0;">${svg}</div>`);
    } else {
      processed = processed.replace(fullMatch, `<div class="mermaid-diagram-fallback" style="border: 1px solid #e0e0e0; border-radius: 4px; padding: 1em; margin: 1em 0; background: #f9f9f9;"><p style="font-size: 0.85em; color: #666; margin: 0 0 0.5em 0; font-weight: 600;">Mermaid Diagram (preview not available in export)</p><pre style="background: transparent; padding: 0; margin: 0;"><code>${escapeHtml(mermaidCode)}</code></pre></div>`);
    }
  }

  return processed;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Regex patterns for color detection (same as in color-swatch.tsx)
const HEX_REGEX = /^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const RGB_REGEX = /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/;
const RGBA_REGEX = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/;
const HSL_REGEX = /^hsl\(\s*\d+\s*,\s*\d+%?\s*,\s*\d+%?\s*\)$/;
const HSLA_REGEX = /^hsla\(\s*\d+\s*,\s*\d+%?\s*,\s*\d+%?\s*,\s*[\d.]+\s*\)$/;

function isColorCode(str: string): boolean {
  const trimmed = str.trim();
  return HEX_REGEX.test(trimmed) || 
         RGB_REGEX.test(trimmed) || 
         RGBA_REGEX.test(trimmed) || 
         HSL_REGEX.test(trimmed) || 
         HSLA_REGEX.test(trimmed);
}

function processColorCodes(htmlContent: string): string {
  // Find inline <code> elements and replace color codes with styled spans
  return htmlContent.replace(/&lt;code&gt;([^&]*)&lt;\/code&gt;/g, (match, codeContent) => {
    const decodedContent = codeContent
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    
    if (isColorCode(decodedContent)) {
      const color = decodedContent.trim();
      const swatchStyle = `display:inline-block;width:14px;height:14px;border-radius:2px;border:1px solid rgba(0,0,0,0.2);margin-left:4px;vertical-align:middle;background-color:${color};`;
      return `<span style="display:inline-flex;align-items:center;gap:4px;"><code style="font-size:0.75rem;">${codeContent}</code><span style="${swatchStyle}"></span></span>`;
    }
    
    return match;
  });
}

async function inlineImagesAsBase64(
  htmlContent: string,
  markdownDir: string
): Promise<string> {
  const imgRegex = /<img([^>]*)src="([^"]+)"([^>]*)>/g;
  const matches: Array<{ full: string; before: string; src: string; after: string }> = [];

  let match;
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    matches.push({ full: match[0], before: match[1], src: match[2], after: match[3] });
  }

  let processedHtml = htmlContent;

  for (const { full, before, src, after } of matches) {
    try {
      if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
        continue;
      }

      let imagePath: string;
      if (src.startsWith('/')) {
        imagePath = src.slice(1);
      } else {
        imagePath = path.join(markdownDir, src);
      }

      imagePath = path.normalize(imagePath).replace(/\\/g, '/');

      const imageBuffer = await readFile(imagePath);

      if (imageBuffer.length > MAX_IMAGE_SIZE) {
        console.warn(`[Markdown Export] Image too large to inline: ${imagePath} (${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
        continue;
      }

      const ext = path.extname(imagePath).slice(1);
      const mimeType = getMimeType(ext);
      const base64 = imageBuffer.toString('base64');
      const dataUri = `data:${mimeType};base64,${base64}`;

      processedHtml = processedHtml.replace(full, `<img${before}src="${dataUri}"${after}>`);
    } catch (err) {
      console.warn(`[Markdown Export] Failed to inline image: ${src}`, err);
    }
  }

  return processedHtml;
}

export async function markdownFileToHtmlDocument(filePath: string): Promise<string> {
  const contentBuffer = await readFile(filePath);

  if (contentBuffer.length > READ_SIZE_LIMIT) {
    const err = new Error('File is too large to export') as NodeJS.ErrnoException;
    (err as { statusCode?: number }).statusCode = 413;
    throw err;
  }

  const markdownContent = contentBuffer.toString('utf-8');

  const processedMarkdown = await processMermaidBlocks(markdownContent);

  marked.use({ gfm: true, breaks: true });
  let htmlContent = await marked.parse(processedMarkdown);

  // Post-process color codes in the HTML
  htmlContent = processColorCodes(htmlContent);

  const fileDir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const fileName = path.basename(filePath, ext);

  htmlContent = await inlineImagesAsBase64(htmlContent, fileDir);

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap" rel="stylesheet">
  <style>
    @page {
      size: A4;
      margin: 25mm 20mm;
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family: Arial, Helvetica, sans-serif, 'Noto Color Emoji';
      font-size: 11pt;
      line-height: 1.6;
      color: #222;
      max-width: 100%;
      margin: 0;
      padding: 20px;
    }

    h1, h2, h3, h4, h5, h6 {
      font-family: Arial, Helvetica, sans-serif;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      line-height: 1.3;
    }

    h1 { font-size: 2em; border-bottom: 2px solid #333; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #ccc; padding-bottom: 0.3em; }
    h3 { font-size: 1.25em; }
    h4 { font-size: 1.1em; }

    p {
      margin: 0.8em 0;
    }

    pre {
      background: #f5f5f5;
      padding: 1em;
      border-radius: 4px;
      overflow: auto;
      border: 1px solid #e0e0e0;
      margin: 1em 0;
    }

    code {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace, 'Noto Color Emoji';
      font-size: 0.9em;
    }

    pre code {
      font-size: 0.85em;
      background: transparent;
      padding: 0;
    }

    :not(pre) > code {
      background: #f0f0f0;
      padding: 0.2em 0.4em;
      border-radius: 3px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }

    th, td {
      border: 1px solid #ccc;
      padding: 6px 10px;
      text-align: left;
    }

    th {
      background: #f5f5f5;
      font-weight: 600;
    }

    tr:nth-child(even) {
      background: #fafafa;
    }

    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1em auto;
    }

    blockquote {
      border-left: 4px solid #ddd;
      margin: 1em 0;
      padding-left: 1em;
      color: #555;
      font-style: italic;
    }

    ul, ol {
      margin: 0.8em 0;
      padding-left: 2em;
    }

    li {
      margin: 0.3em 0;
    }

    a {
      color: #0066cc;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    hr {
      border: none;
      border-top: 1px solid #ccc;
      margin: 2em 0;
    }

    .mermaid-diagram {
      margin: 1.5em 0;
      padding: 1em 0;
      text-align: center;
    }

    .mermaid-diagram svg {
      max-width: 100%;
      height: auto;
    }

    .mermaid-diagram-fallback {
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      padding: 1em;
      margin: 1em 0;
      background: #f9f9f9;
    }

    @media print {
      pre {
        white-space: pre-wrap;
        word-wrap: break-word;
      }

      a {
        text-decoration: underline;
      }

      a[href]:after {
        content: " (" attr(href) ")";
        font-size: 0.85em;
        color: #666;
      }

      a[href^="#"]:after,
      a[href^="data:"]:after {
        content: "";
      }
    }

    .hljs-comment, .hljs-quote { color: #998; font-style: italic; }
    .hljs-keyword, .hljs-selector-tag, .hljs-subst { color: #333; font-weight: bold; }
    .hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable, .hljs-tag .hljs-attr { color: #008080; }
    .hljs-string, .hljs-doctag { color: #d14; }
    .hljs-title, .hljs-section, .hljs-selector-id { color: #900; font-weight: bold; }
    .hljs-subst { font-weight: normal; }
    .hljs-type, .hljs-class .hljs-title { color: #458; font-weight: bold; }
    .hljs-tag, .hljs-name, .hljs-attribute { color: #000080; font-weight: normal; }
    .hljs-regexp, .hljs-link { color: #009926; }
    .hljs-symbol, .hljs-bullet { color: #990073; }
    .hljs-built_in, .hljs-builtin-name { color: #0086b3; }
    .hljs-meta { color: #999; font-weight: bold; }
    .hljs-deletion { background: #fdd; }
    .hljs-addition { background: #dfd; }
    .hljs-emphasis { font-style: italic; }
    .hljs-strong { font-weight: bold; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
}