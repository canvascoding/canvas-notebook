import { readFile } from '@/app/lib/filesystem/workspace-files';
import { marked } from 'marked';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs/promises';

const execFileAsync = promisify(execFile);

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

async function renderMermaidToSvg(code: string): Promise<string | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mermaid-'));
  const inputPath = path.join(tmpDir, 'diagram.mmd');
  const outputPath = path.join(tmpDir, 'diagram.svg');

  try {
    await fs.writeFile(inputPath, code, 'utf-8');

    const mmdcPath = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      'mmdc'
    );

    await execFileAsync(mmdcPath, [
      '-i', inputPath,
      '-o', outputPath,
      '-t', 'default',
      '-b', 'white',
      '--quiet',
    ], {
      timeout: 15000,
    });

    const svgContent = await fs.readFile(outputPath, 'utf-8');
    return svgContent;
  } catch (err) {
    console.warn('[Markdown Export] Failed to render mermaid diagram:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
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