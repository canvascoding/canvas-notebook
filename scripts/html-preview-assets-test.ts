import assert from 'node:assert/strict';
import { buildHtmlPreviewAssetManifest, normalizeHtmlPreviewPath, type HtmlPreviewAssetReader } from '../app/lib/html-preview-assets';
import { rewriteHtmlPreviewCss, rewriteHtmlPreviewDocument, rewriteHtmlPreviewScript } from '../app/lib/html-preview-assets';
import { JSDOM } from 'jsdom';

const prefix = '/__preview/' + 'x'.repeat(43);
const rewritten = new JSDOM(rewriteHtmlPreviewDocument(`<html><head><style>h1{background:url('/assets/bg.png')}</style></head><body><img src="/assets/image.svg"><img src="https://cdn.invalid/image.png"><script type="module" src="./app.mjs"></script><script>fetch('/assets/data.json');new Worker('./worker.js');</script></body></html>`, 'report/index.html', prefix));
assert.equal(rewritten.window.document.querySelector('base')?.getAttribute('href'), prefix + '/report/');
assert.equal(rewritten.window.document.querySelector('img')?.getAttribute('src'), prefix + '/assets/image.svg');
assert.equal(rewritten.window.document.querySelectorAll('img')[1].getAttribute('src'), 'https://cdn.invalid/image.png');
assert.equal(rewritten.window.document.querySelector('script[src]')?.getAttribute('src'), './app.mjs');
assert.ok(rewritten.window.document.querySelector('style')?.textContent?.includes(prefix + '/assets/bg.png'));
assert.ok(rewritten.window.document.querySelector('script:not([src])')?.textContent?.includes(prefix + '/assets/data.json'));
rewritten.window.close();
assert.equal(rewriteHtmlPreviewCss(`@import '/assets/theme.css';x{background:url(https://cdn.invalid/x.png)}`, prefix), `@import '${prefix}/assets/theme.css';x{background:url(https://cdn.invalid/x.png)}`);
assert.equal(rewriteHtmlPreviewScript('import "/assets/main.mjs";fetch(`/assets/${name}.json`);fetch("./local.json")', prefix), `import "${prefix}/assets/main.mjs";fetch(\`${prefix}/assets/\${name}.json\`);fetch("./local.json")`);
assert.ok(rewriteHtmlPreviewDocument('<base href="https://cdn.invalid/"><img src="image.png">', 'report/index.html', prefix).includes('href="https://cdn.invalid/"'));

async function main() {
  const files: Record<string,string> = {
    'report/index.html': `<link rel="stylesheet" href="./style.css"><img src="./chart.svg"><img src="https://cdn.invalid/picture.png"><script type="module" src="./main.mjs"></script><script>fetch('./data.json');new Worker('./worker.js');window.location='https://outside.invalid';</script>`,
    'report/style.css': `@import './theme.css';h1{background:url('../shared/background.png')}`,
    'report/theme.css': `@font-face{font-family:Fixture;src:url('./font.woff2')}`,
    'report/main.mjs': "import './module.mjs';fetch(`./data/${language}.json`);fetch(dynamicFilename);",
    'report/module.mjs': "import './main.mjs';// './unmentioned.json' is a comment, not a dependency\n",
    'report/worker.js': "importScripts('./worker-helper.js');fetch('./worker-data.json');",
    'report/worker-helper.js': 'postMessage(true);',
    'report/chart.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'report/data/en.json': '{}', 'report/data/de.json': '{}', 'report/data/.env': 'private',
    'report/data.json':'{}','report/worker-data.json':'{}',
    'report/unmentioned.json':'private','report/other.html':'private',
    'private.txt':'private','other-workspace/secret.json':'private',
  };
  const listed: string[] = [];
  const reader: HtmlPreviewAssetReader = {
    async read(filePath) { if (!(filePath in files)) throw new Error('missing');return Buffer.from(files[filePath]); },
    async list(directory) { listed.push(directory);return Object.keys(files).filter(p=>p.startsWith(directory+'/')).map(p=>({path:p,type:'file' as const})); },
  };
  const manifest = await buildHtmlPreviewAssetManifest('report/index.html',reader);
  assert.deepEqual(manifest,[
    'report/chart.svg','report/data.json','report/data/de.json','report/data/en.json','report/font.woff2',
    'report/index.html','report/main.mjs','report/module.mjs','report/style.css','report/theme.css',
    'report/worker-data.json','report/worker-helper.js','report/worker.js','shared/background.png',
  ]);
  assert.deepEqual(listed,['report/data']);
  for (const invalid of ['../private.txt','report/../../file','/absolute','report/.env','report\\file.html','report/\0file']) {
    assert.throws(()=>normalizeHtmlPreviewPath(invalid));
  }
  files['root.html'] = "<script>fetch(`./${dynamic}.json`);fetch('./');fetch('../');</script><img src='root.svg'>";
  listed.length=0;
  assert.deepEqual(await buildHtmlPreviewAssetManifest('root.html',reader),['root.html','root.svg']);
  assert.deepEqual(listed,[],'dynamic names cannot expand the workspace root');
  files['external.html']='<base href="https://cdn.invalid/"><script src="app.js"></script>';
  assert.deepEqual(await buildHtmlPreviewAssetManifest('external.html',reader),['external.html']);
  console.log('HTML preview asset manifest tests passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
