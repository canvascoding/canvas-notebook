import assert from 'node:assert/strict';
import Module from 'node:module';

const internal = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internal._load;
internal._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);

async function main() {
  const { outboxBodyFromMarkdown } = await import('../app/lib/email/outbox-markdown');
  const formatted = outboxBodyFromMarkdown('Hallo **Frank** und *Team*!\n\n- Eins\n- Zwei\n\n[Canvas](https://example.com)');
  assert.match(formatted.bodyHtml, /<strong>Frank<\/strong>/u);
  assert.match(formatted.bodyHtml, /<em>Team<\/em>/u);
  assert.match(formatted.bodyHtml, /<ul>\s*<li>Eins<\/li>\s*<li>Zwei<\/li>\s*<\/ul>/u);
  assert.match(formatted.bodyHtml, /href="https:\/\/example.com"/u);
  assert.doesNotMatch(formatted.bodyHtml, /\*\*Frank\*\*/u);
  assert.match(formatted.body, /Hallo Frank und Team/u);

  const unsafe = outboxBodyFromMarkdown('**Sicher** <script>alert(1)</script> [Klick](javascript:alert(1)) ![Bild](https://example.com/a.png)');
  assert.doesNotMatch(unsafe.bodyHtml, /<script|javascript:|<img/iu);
  assert.match(unsafe.bodyHtml, /&lt;script&gt;/u);
  assert.match(unsafe.bodyHtml, /Klick/u);
  assert.match(unsafe.bodyHtml, /Bild/u);

  const literal = outboxBodyFromMarkdown('Die Zeichen \\*wörtlich\\* behalten.');
  assert.match(literal.bodyHtml, /\*wörtlich\*/u);
  console.log('Email Outbox Markdown conversion passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  internal._load = originalLoad;
});
