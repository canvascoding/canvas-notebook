import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public/_canvas-tool-apps');
const widgetMessages = Object.fromEntries(await Promise.all(['de', 'en'].map(async (locale) => {
  const messages = JSON.parse(await readFile(path.join(root, `messages/${locale}.json`), 'utf8'));
  const { scheduleSummary, intervalUnits, weekdays } = messages.automationen;
  return [locale, { widget: messages.chat.toolApp, automations: { scheduleSummary, intervalUnits, weekdays } }];
})));
const css = await readFile(path.join(root, 'app/tool-widgets/widget.css'), 'utf8');
const fonts = await Promise.all([['Regular', 400], ['Bold', 700]].map(async ([face, weight]) => {
  const data = await readFile(path.join(root, `seed_skills/canvas-design/canvas-fonts/InstrumentSans-${face}.ttf`));
  return `@font-face{font-family:CanvasWidgetSans;font-weight:${weight};font-display:swap;src:url(data:font/ttf;base64,${data.toString('base64')}) format('truetype')}`;
}));
await mkdir(output, { recursive: true });
for (const [entry, title] of [['automation-job', 'Canvas Automation'], ['human-todo', 'Canvas Todo']]) {
  const result = await build({ entryPoints: [path.join(root, `app/tool-widgets/${entry}.tsx`)],
    bundle: true, format: 'iife', platform: 'browser', write: false, minify: true,
    define: { 'process.env.NODE_ENV': '"production"', '__CANVAS_WIDGET_MESSAGES__': JSON.stringify(widgetMessages) } });
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${fonts.join('')}${css}</style></head><body><script>${result.outputFiles[0].text.replace(/<\/script/giu, '<\\/script')}</script></body></html>`;
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new Error('Canvas widget exceeds the sandbox resource limit.');
  await writeFile(path.join(output, `${entry}-v1.html`), html);
  console.log(`Built ${title} widget (${Math.ceil(Buffer.byteLength(html) / 1024)} KiB).`);
}
