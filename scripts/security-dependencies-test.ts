import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { simpleParser } from 'mailparser';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';

const exec = promisify(execFile);

async function main() {
  const message = await simpleParser([
    'From: sender@example.test', 'To: reader@example.test', 'Subject: =?UTF-8?B?R3LDvMOfZQ==?=',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="fixture"', '',
    '--fixture', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    '<h1>Gr=C3=BC=C3=9Fe</h1><p>Hello <strong>Canvas</strong>.</p>',
    '--fixture', 'Content-Type: image/png', 'Content-Disposition: attachment; filename="pixel.png"',
    'Content-Transfer-Encoding: base64', '',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    '--fixture--', '',
  ].join('\r\n'), { skipHtmlToText: false, skipTextToHtml: true, maxHtmlLengthToParse: 512 * 1024 });
  assert.equal(message.subject, 'Grüße');
  assert.match(String(message.html), /Grüße/u);
  const htmlOnly = await simpleParser('Content-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <strong>Canvas</strong>.</p>', { skipHtmlToText: false, skipTextToHtml: true });
  assert.match(htmlOnly.text || '', /Hello Canvas\./u);
  assert.equal(message.attachments.length, 1); assert.equal(message.attachments[0].filename, 'pixel.png');
  assert.equal(message.attachments[0].content.subarray(1, 4).toString(), 'PNG');

  const sreRequire = createRequire(require.resolve('speech-rule-engine'));
  const { DOMImplementation, XMLSerializer } = sreRequire('@xmldom/xmldom');
  const document = new DOMImplementation().createDocument(null, 'root', null);
  assert.throws(() => new XMLSerializer().serializeToString(document.createEntityReference('safe; <injected/> &x'), { requireWellFormed: true }));
  assert.match(new XMLSerializer().serializeToString(document), /<root/u);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-dependency-render-'));
  try {
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide(); slide.addText('Security export fixture', { x: 1, y: 1, w: 6, h: 1 });
    slide.addImage({ data: 'data:image/png;base64,' + message.attachments[0].content.toString('base64'), x: 1, y: 2, w: 1, h: 1 });
    const output = path.join(temporary, 'fixture.pptx'); await pptx.writeFile({ fileName: output });
    const zip = await JSZip.loadAsync(await fs.readFile(output));
    assert.ok(zip.file('ppt/slides/slide1.xml')); assert.ok(Object.keys(zip.files).some(p => p.startsWith('ppt/media/') && p.endsWith('.png')));

    const browserPath = process.env.CHROMIUM_PATH;
    assert.ok(browserPath, 'Set CHROMIUM_PATH to the existing local test browser for real Marp PDF/PNG/PPTX checks');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="80"><rect width="140" height="80" fill="#246b9a"/></svg>';
    await fs.writeFile(path.join(temporary, 'local.svg'), svg);
    await fs.writeFile(path.join(temporary, 'deck.md'), '---\nmarp: true\nmath: mathjax\n---\n# Export fixture\n\n$E=mc^2$\n\n![width:90px](https://www.w3.org/Icons/w3c_home.png)\n\n---\n# Relative image\n\n![width:140px](./local.svg)\n');
    const cli = path.resolve('node_modules/@marp-team/marp-cli/marp-cli.js');
    for (const [flag, extension] of [['--pdf', 'pdf'], ['--images=png', 'png'], ['--pptx', 'pptx']]) {
      await exec(process.execPath, [cli, path.join(temporary, 'deck.md'), flag, '--no-stdin', '--allow-local-files', '--browser-path', browserPath, '-o', path.join(temporary, 'deck.' + extension)], {
        cwd: process.cwd(), timeout: 60_000, maxBuffer: 1024 * 1024,
      });
    }
    assert.equal((await fs.readFile(path.join(temporary, 'deck.pdf'))).subarray(0, 4).toString(), '%PDF');
    const marpZip = await JSZip.loadAsync(await fs.readFile(path.join(temporary, 'deck.pptx')));
    assert.equal(Object.keys(marpZip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/u.test(p)).length, 2);
    const pngs = (await fs.readdir(temporary)).filter(p => /^deck.*\.png$/u.test(p)); assert.equal(pngs.length, 2);
    if (process.env.TEST_EXPORT_OUTPUT) await fs.cp(temporary, process.env.TEST_EXPORT_OUTPUT, { recursive: true });
    console.log('Dependency regressions passed: MIME/HTML/attachment, XML injection rejection, PptxGenJS image deck, real Marp PDF/PNG/PPTX with MathJax and local/public images');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
